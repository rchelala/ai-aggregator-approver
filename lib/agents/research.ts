import { ResearchOutputSchema } from '../../types/index.js';
import type { ResearchOutput } from '../../types/index.js';
import { geminiCall } from '../clients/gemini.js';
import { NICHE, EXCLUDED_TOPICS } from '../config/topics.js';

export class EmptyResearchError extends Error {
  constructor(message = 'Research agent returned 0 usable items') {
    super(message);
    this.name = 'EmptyResearchError';
  }
}

// ---------------------------------------------------------------------------
// HN Algolia fetch
// ---------------------------------------------------------------------------

interface HnHit {
  objectID: string;
  title: string;
  url: string | null;
  points: number;
  num_comments: number;
  created_at: string;
}

async function fetchHnStories(windowHours = 24): Promise<HnHit[]> {
  const since = Math.floor(Date.now() / 1000) - windowHours * 3600;

  // Fetch "AI" and "LLM" separately (Algolia AND-matches multi-word queries,
  // so compound queries return 0 hits), then merge and deduplicate.
  const fetchOne = async (q: string): Promise<HnHit[]> => {
    const r = await fetch(
      `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=${q}&hitsPerPage=30&numericFilters=created_at_i>${since}`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!r.ok) return [];
    return ((await r.json()) as { hits: HnHit[] }).hits;
  };

  const [aiHits, llmHits] = await Promise.all([fetchOne('AI'), fetchOne('LLM')]);
  const seen = new Set<string>();
  return [...aiHits, ...llmHits].filter((h) => {
    if (!h.url || seen.has(h.objectID)) return false;
    seen.add(h.objectID);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a research agent for an AI news aggregator account on X (formerly Twitter). You will be given a list of recent Hacker News stories. Your job is to select the 3–5 most relevant items for this niche:

NICHE:
${NICHE}

EXCLUDED TOPICS (skip anything matching these):
${EXCLUDED_TOPICS.map((t, i) => `${i + 1}. ${t}`).join('\n')}

SELECTION CRITERIA:
- Each item must be a concrete event, announcement, or finding — not a trend overview.
- Each item must name a specific entity: a company, model name, dollar amount, paper title, or person.
- Prefer higher-points stories but don't ignore low-points stories with strong relevance.
- Skip stories that are off-niche even if popular.

OUTPUT FORMAT:
Respond with a JSON object matching this exact shape:
{
  "items": [
    {
      "headline": "string — one sentence, max 200 chars, your own wording (not just the HN title)",
      "source_url": "string — use the story URL exactly as given",
      "why_matters_hint": "string — one sentence on why a software builder should care, max 300 chars",
      "published_at": "string (optional) — ISO 8601 date from created_at"
    }
  ]
}

Return between 1 and 5 items. Prefer 3–5.`;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runResearch(postId?: string): Promise<ResearchOutput> {
  let hits = await fetchHnStories(24);
  if (hits.length < 3) {
    hits = await fetchHnStories(48);
  }
  if (hits.length === 0) {
    throw new EmptyResearchError('HN returned 0 eligible stories in the last 48 hours.');
  }

  const storiesContext = hits
    .map(
      (h) =>
        `Title: ${h.title}\nURL: ${h.url}\nPoints: ${h.points} | Comments: ${h.num_comments}\nDate: ${h.created_at}`,
    )
    .join('\n\n---\n\n');

  const userPrompt = `Here are recent Hacker News stories. Select the 3–5 most relevant to the niche and return them in the required JSON format:\n\n${storiesContext}`;

  const result = await geminiCall<ResearchOutput>({
    model: 'gemini-2.5-flash',
    system: SYSTEM_PROMPT,
    user: userPrompt,
    jsonSchema: ResearchOutputSchema,
    enableGoogleSearch: false,
    agentType: 'research',
    postId,
    temperature: 0.2,
  });

  if (result.data.items.length === 0) {
    throw new EmptyResearchError('Gemini selected 0 items from HN stories.');
  }

  return result.data;
}
