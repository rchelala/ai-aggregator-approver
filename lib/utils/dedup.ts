/**
 * Lightweight entity-based deduplication. Detects when a candidate digest
 * overlaps too much with recent posts on the level of named entities
 * (companies, model names, dollar amounts). Not a real NER pipeline — a
 * regex-based heuristic that's good enough for "did we already cover this
 * angle in the last 7 days."
 */

const CAPITALIZED_RE = /\b[A-Z][a-zA-Z]{2,}\b/g;
const DOLLAR_AMOUNT_RE = /\$\d+(?:\.\d+)?[bmk]?/gi;
const VERSION_RE = /\b\d+\.\d+(?:\.\d+)?\b/g;
const MODEL_NAME_RE = /\b(?:gpt|claude|gemini|llama|opus|sonnet|haiku|grok|mistral|qwen|deepseek|phi|mixtral|gemma|command|nova)-?\d+(?:[.\-]\d+)*\b/gi;

export function extractEntities(text: string): Set<string> {
  const tokens = new Set<string>();

  const collect = (re: RegExp) => {
    const matches = text.match(re);
    if (matches) {
      for (const m of matches) tokens.add(m.toLowerCase());
    }
  };

  collect(CAPITALIZED_RE);
  collect(DOLLAR_AMOUNT_RE);
  collect(VERSION_RE);
  collect(MODEL_NAME_RE);

  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export function isDuplicate(
  candidateText: string,
  recentPostedTexts: string[],
  threshold = 0.6,
): { duplicate: boolean; overlap: number; matched_against?: string } {
  const candidateEntities = extractEntities(candidateText);
  let maxOverlap = 0;
  let bestMatch: string | undefined;

  for (const recent of recentPostedTexts) {
    const recentEntities = extractEntities(recent);
    const overlap = jaccard(candidateEntities, recentEntities);
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      bestMatch = recent;
    }
  }

  if (maxOverlap >= threshold) {
    return { duplicate: true, overlap: maxOverlap, matched_against: bestMatch };
  }
  return { duplicate: false, overlap: maxOverlap };
}
