import { DraftOutputSchema } from '../../types/index.js';
import type { ResearchOutput, DraftOutput } from '../../types/index.js';
import { geminiCall } from '../clients/gemini.js';
import {
  VOICE_STANCE,
  VOICE_HARD_RULES,
  VOICE_SOFT_RULES,
  GOOD_EXAMPLES,
  BAD_EXAMPLES,
} from '../config/voice.js';
import {
  FORMAT_RULES,
  DIGEST_LEAD_IN,
  renderDigest,
  DigestFormatError,
} from '../config/format.js';

// =====================================================================
// Typed errors
// =====================================================================

export class DraftFailedError extends Error {
  constructor(message = 'Draft agent produced 0 variants that survived format validation') {
    super(message);
    this.name = 'DraftFailedError';
  }
}

// =====================================================================
// System prompt builder
// =====================================================================

function buildSystemPrompt(): string {
  const hardRules = VOICE_HARD_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const softRules = VOICE_SOFT_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const formatRules = FORMAT_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const goodExamples = GOOD_EXAMPLES.map((e, i) => `--- Good example ${i + 1} ---\n${e}`).join('\n\n');
  const badExamples = BAD_EXAMPLES.map((e, i) =>
    `--- Anti-pattern ${i + 1} ---\n${e.text}\nWHY BAD: ${e.why_bad}`,
  ).join('\n\n');

  return `You are a draft agent for an AI news aggregator account on X (formerly Twitter).

VOICE & STANCE:
${VOICE_STANCE}

HARD RULES (non-negotiable — violating any of these causes the draft to be rejected):
${hardRules}

SOFT RULES (follow these to sound like the configured voice):
${softRules}

FORMAT RULES:
${formatRules}

The lead-in is always exactly: ${JSON.stringify(DIGEST_LEAD_IN)}

GOOD EXAMPLES (these nail the voice — use as style anchors):
${goodExamples}

ANTI-PATTERNS TO AVOID:
${badExamples}

OUTPUT INSTRUCTIONS:
- Pick the 3 strongest research items.
- Write 2 distinct variants. Each variant must cover the same 3 items but frame them differently.
- For each variant, output:
  {
    "bullets": [
      { "headline": "...", "take": "...", "source_url": "..." }
    ],
    "closing_line": "..." (optional — only include if bullets share a genuine connecting thread),
    "rendered_text": "..." (the full tweet text, starting with "today in ai:\\n\\n")
  }
- rendered_text must start with "today in ai:" followed by a blank line, then bullets in the form "· headline: take", then optionally a blank line and a closing line.
- Total rendered_text must be at most 280 characters including newlines.

Respond with a JSON object: { "variants": [ variant1, variant2 ] }`;
}

// =====================================================================
// Main export
// =====================================================================

export async function runDraft(
  research: ResearchOutput,
  recent7DaysPosts: string[],
  postId?: string,
): Promise<DraftOutput> {
  const systemPrompt = buildSystemPrompt();

  const recentSection =
    recent7DaysPosts.length > 0
      ? `Avoid these recently-used angles (posted in the last 7 days):\n${recent7DaysPosts.join('\n')}`
      : 'No recent posts to avoid.';

  const userPrompt = `Here are today's research items:\n${JSON.stringify(research.items, null, 2)}\n\n${recentSection}\n\nProduce 2 variants in the JSON shape specified in your instructions.`;

  const result = await geminiCall<DraftOutput>({
    system: systemPrompt,
    user: userPrompt,
    jsonSchema: DraftOutputSchema,
    enableGoogleSearch: false,
    agentType: 'draft',
    postId,
    temperature: 0.85, // higher creativity for drafting
  });

  // Verify and repair rendered_text for each variant
  const survivingVariants = result.data.variants.flatMap((variant) => {
    try {
      const recomputed = renderDigest(variant.bullets, variant.closing_line);

      // If rendered_text is mismatched or missing, overwrite with recomputed value
      const corrected = {
        ...variant,
        rendered_text: recomputed,
      };

      // Final check: DraftVariantSchema enforces max 280 chars on rendered_text
      if (corrected.rendered_text.length > 280) {
        // renderDigest should have already thrown, but guard anyway
        return [];
      }

      return [corrected];
    } catch (err) {
      if (err instanceof DigestFormatError) {
        // This variant is structurally broken — drop it
        return [];
      }
      // Unexpected error — re-throw
      throw err;
    }
  });

  if (survivingVariants.length === 0) {
    throw new DraftFailedError(
      'All draft variants failed format validation (renderDigest threw for each one).',
    );
  }

  // Re-validate the repaired output against the schema
  const repaired = DraftOutputSchema.parse({ variants: survivingVariants });

  return repaired;
}
