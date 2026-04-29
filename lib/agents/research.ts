import { ResearchOutputSchema } from '../../types/index.js';
import type { ResearchOutput } from '../../types/index.js';
import { geminiCall } from '../clients/gemini.js';
import { NICHE, TOPIC_SOURCES_HINT, EXCLUDED_TOPICS } from '../config/topics.js';

// =====================================================================
// Typed errors
// =====================================================================

export class EmptyResearchError extends Error {
  constructor(message = 'Research agent returned 0 usable items') {
    super(message);
    this.name = 'EmptyResearchError';
  }
}

// =====================================================================
// Helpers
// =====================================================================

function isUrlObviouslyBroken(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Must be http or https
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;
    // Must have a real hostname (not localhost, not bare IP)
    if (!parsed.hostname || parsed.hostname === 'localhost') return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

function headlineMatchesExcluded(headline: string): boolean {
  const lower = headline.toLowerCase();
  return EXCLUDED_TOPICS.some((topic) => {
    // Simple keyword match — topic phrases are short and specific
    return lower.includes(topic.toLowerCase());
  });
}

// =====================================================================
// System prompt
// =====================================================================

const SYSTEM_PROMPT = `You are a research agent for an AI news aggregator account on X (formerly Twitter). Your job is to find the 3–5 most relevant, fresh items in the following niche from the last 24 hours.

NICHE:
${NICHE}

PREFERRED SOURCES:
${TOPIC_SOURCES_HINT}

EXCLUDED TOPICS (skip anything matching these):
${EXCLUDED_TOPICS.map((t, i) => `${i + 1}. ${t}`).join('\n')}

QUALITY BAR:
- Each item must be a concrete event, announcement, or finding — not a trend overview.
- Each item must name a specific entity: a company, model name, dollar amount, paper title, or person.
- Skip secondary aggregators that just rehash press releases. Prefer primary sources.
- If a source URL looks fabricated or you cannot verify it, omit that item.
- published_at should be an ISO 8601 date string (e.g. "2026-04-28") if you can determine it; omit otherwise.

OUTPUT FORMAT:
Respond with a JSON object matching this exact shape:
{
  "items": [
    {
      "headline": "string — one sentence, max 200 chars",
      "source_url": "string — real, direct URL to the source",
      "why_matters_hint": "string — one sentence on why a software builder should care, max 300 chars",
      "published_at": "string (optional) — ISO 8601 date"
    }
  ]
}

Return between 1 and 10 items. Prefer 3–5.`;

const USER_PROMPT =
  'Find 3–5 specific AI/dev-tools news items from the last 24 hours. Each must include a real source URL, a one-sentence headline, and a one-sentence why-it-matters hint. Skip secondary aggregators that just rehash press releases.';

// =====================================================================
// Main export
// =====================================================================

export async function runResearch(postId?: string): Promise<ResearchOutput> {
  const result = await geminiCall<ResearchOutput>({
    system: SYSTEM_PROMPT,
    user: USER_PROMPT,
    jsonSchema: ResearchOutputSchema,
    enableGoogleSearch: true,
    agentType: 'research',
    postId,
    temperature: 0.3, // lower temp for factual retrieval
  });

  // Filter out broken URLs and excluded topics
  const filtered = result.data.items.filter((item) => {
    if (isUrlObviouslyBroken(item.source_url)) return false;
    if (headlineMatchesExcluded(item.headline)) return false;
    return true;
  });

  if (filtered.length === 0) {
    throw new EmptyResearchError(
      'Research agent returned 0 usable items after filtering broken URLs and excluded topics.',
    );
  }

  return { items: filtered };
}
