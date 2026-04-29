import { BANNED_REGEXES, MAX_HASHTAGS } from '../config/voice.js';
import { MAX_TWEET_CHARS, MIN_BULLETS, MAX_BULLETS, parseDigest } from '../config/format.js';
import type { ValidationResult } from '../../types/index.js';

/**
 * Hard regex pre-filter for digest text. Runs BEFORE any review LLM call to
 * cheaply reject drafts that violate non-negotiable rules.
 *
 * Accumulates ALL violations (not short-circuit) so a single rejection message
 * can cover everything wrong with a draft.
 */
export function validateDraft(text: string): ValidationResult {
  const violations: string[] = [];

  if (text.length > MAX_TWEET_CHARS) {
    violations.push(`over-length: ${text.length} chars`);
  }

  for (const [regex, name] of BANNED_REGEXES) {
    if (regex.test(text)) {
      violations.push(name);
    }
  }

  const hashtagMatches = text.match(/#\w+/g);
  const hashtagCount = hashtagMatches ? hashtagMatches.length : 0;
  if (hashtagCount > MAX_HASHTAGS) {
    violations.push(`too many hashtags: ${hashtagCount}`);
  }

  const parsed = parseDigest(text);
  if (parsed === null) {
    violations.push('does-not-match-digest-format');
  } else {
    if (parsed.bullets.length < MIN_BULLETS || parsed.bullets.length > MAX_BULLETS) {
      violations.push(
        `bullet count out of range: ${parsed.bullets.length} (must be ${MIN_BULLETS}-${MAX_BULLETS})`,
      );
    }
  }

  return { valid: violations.length === 0, violations };
}
