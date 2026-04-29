// Niche definition. Imported by research.ts to scope what counts as relevant.

export const NICHE =
  'AI/ML for working software builders — model launches, agent tooling, evaluation research, inference infrastructure cost, frontier lab moves, developer-facing AI products';

export const TOPIC_SOURCES_HINT = `Prefer credible sources: official lab blogs (Anthropic, OpenAI, Google AI/DeepMind, Meta AI, xAI, Mistral), arxiv (especially cs.CL/cs.LG categories), Hacker News front page, well-known AI Twitter/X accounts when corroborated, GitHub release notes for major dev tools (LangChain, LlamaIndex, Cursor, Continue, Aider). De-prioritize secondary aggregators that just rehash press releases.`;

export const EXCLUDED_TOPICS: string[] = [
  'us politics',
  'crypto trading',
  'consumer celebrity gossip',
  'general tech-industry layoffs without an AI angle',
  'sci-fi-style AGI doom takes without a concrete event',
];

/**
 * Forced-priority topic seeds. v1 returns empty (research is fully news-driven).
 * Future use: when a known event is upcoming (a release date you want to cover),
 * insert a row in the `topics` table with active=true, and the research agent
 * will weight it ahead of organic discovery.
 */
export function getTopicSeedsActive(): string[] {
  return [];
}
