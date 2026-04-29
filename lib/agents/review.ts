import { ReviewDecisionSchema } from '../../types/index.js';
import type { DraftOutput, ReviewDecision, VariantReview } from '../../types/index.js';
import { anthropicCall } from '../clients/anthropic.js';
import { VOICE_STANCE, VOICE_SOFT_RULES, BAD_EXAMPLES } from '../config/voice.js';

// =====================================================================
// System prompt builder
// =====================================================================

function buildSystemPrompt(): string {
  const softRules = VOICE_SOFT_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const badExamples = BAD_EXAMPLES.map((e, i) =>
    `--- Anti-pattern ${i + 1} ---\n${e.text}\nWHY BAD: ${e.why_bad}`,
  ).join('\n\n');

  return `You are a quality-review agent for an AI news aggregator on X. Your job is to score tweet variants and decide which (if any) is worth posting.

VOICE & STANCE:
${VOICE_STANCE}

SOFT RULES (use these to evaluate voice match):
${softRules}

PER-BULLET QUALITY BAR (all 3 must pass for a variant to be eligible):
1. passes_specific_entity — the bullet names a concrete entity: a company, model name, paper title, dollar amount, or person. Vague references like "a major lab" fail.
2. passes_says_something — the take after the colon adds information or interpretation beyond the headline. A restated headline fails.
3. passes_non_obvious_take — the take is something a smart reader couldn't have generated from the headline alone. Generic commentary fails.

SCORING AXES (each 1–10):
- hook: does the first bullet make you want to read the second?
- voice_match: does it sound like the configured sharp-curator voice, not generic AI?
- substance: does the post say something, or is it filler?
- originality: is this a take, not a recap?
- overall_score: your holistic score weighing all axes

SELECTION RULE:
Pick a winner only if:
- every bullet in that variant passes all 3 hard bullet checks (passes_specific_entity, passes_says_something, passes_non_obvious_take), AND
- overall_score >= 7

If no variant meets both conditions, outcome must be "rejected".

ANTI-PATTERNS (anchors for low scores):
${badExamples}

OUTPUT FORMAT:
Respond with a JSON object matching this exact shape:

For a "picked" outcome:
{
  "outcome": "picked",
  "winner_index": <number — 0-based index into the variants array>,
  "reviews": [ <VariantReview>, ... ]
}

For a "rejected" outcome:
{
  "outcome": "rejected",
  "reason": "<string explaining why no variant qualified>",
  "reviews": [ <VariantReview>, ... ]
}

Each VariantReview:
{
  "variant_index": <number>,
  "overall_score": <number 1-10>,
  "hook": <number 1-10>,
  "voice_match": <number 1-10>,
  "substance": <number 1-10>,
  "originality": <number 1-10>,
  "bullet_scores": [
    {
      "index": <0-based bullet index>,
      "score": <number 1-10>,
      "passes_specific_entity": <boolean>,
      "passes_says_something": <boolean>,
      "passes_non_obvious_take": <boolean>,
      "notes": "<optional string>"
    }
  ],
  "reasoning": "<string>"
}`;
}

// =====================================================================
// Cross-check helpers
// =====================================================================

function allBulletsPass(review: VariantReview): boolean {
  return review.bullet_scores.every(
    (b) =>
      b.passes_specific_entity &&
      b.passes_says_something &&
      b.passes_non_obvious_take,
  );
}

function variantQualifies(review: VariantReview): boolean {
  return allBulletsPass(review) && review.overall_score >= 7;
}

// =====================================================================
// Main export
// =====================================================================

export async function runReview(
  draft: DraftOutput,
  postId?: string,
): Promise<ReviewDecision> {
  const systemPrompt = buildSystemPrompt();
  const n = draft.variants.length;

  const userPrompt = `Here are ${n} variant${n === 1 ? '' : 's'}. Review each per the schema. Pick a winner only if every bullet of that variant passes all 3 hard bullet checks AND overall_score >= 7.

Variants:
${JSON.stringify(
  draft.variants.map((v, i) => ({ variant_index: i, ...v })),
  null,
  2,
)}`;

  const result = await anthropicCall<ReviewDecision>({
    system: systemPrompt,
    user: userPrompt,
    jsonSchema: ReviewDecisionSchema,
    agentType: 'review',
    postId,
    useCache: true,
    maxTokens: 2048,
  });

  const decision = result.data;

  // =====================================================================
  // Cross-check: verify Haiku's decision against hard rules
  // =====================================================================

  if (decision.outcome === 'picked') {
    const winnerReview = decision.reviews.find(
      (r) => r.variant_index === decision.winner_index,
    );

    if (!winnerReview) {
      // Haiku returned a winner_index with no matching review — override
      return {
        outcome: 'rejected',
        reason: 'haiku_inconsistency: winner_index has no matching review entry',
        reviews: decision.reviews,
      };
    }

    if (!allBulletsPass(winnerReview)) {
      // Haiku said "picked" but the winner has failing bullets — override
      return {
        outcome: 'rejected',
        reason:
          'haiku_inconsistency: picked variant has bullet(s) failing hard quality checks',
        reviews: decision.reviews,
      };
    }

    if (winnerReview.overall_score < 7) {
      // Haiku said "picked" but score is below threshold — override
      return {
        outcome: 'rejected',
        reason: `haiku_inconsistency: picked variant overall_score=${winnerReview.overall_score} is below 7`,
        reviews: decision.reviews,
      };
    }
  } else {
    // Haiku said "rejected" — check if there's actually a qualifying variant
    // Per spec: if Haiku says rejected but a variant actually qualifies,
    // trust Haiku (don't override). Just log the divergence.
    const hiddenWinner = decision.reviews.find(variantQualifies);
    if (hiddenWinner !== undefined) {
      // Log divergence — Haiku saw nuance the heuristic missed
      console.warn(
        `[review] Divergence: Haiku rejected all variants but variant ${hiddenWinner.variant_index} ` +
          `passes heuristic checks (score=${hiddenWinner.overall_score}). Trusting Haiku's judgment.`,
      );
    }
  }

  return decision;
}
