// Single source of truth for the digest format. Imported by draft.ts (generation
// instruction), review.ts (per-bullet quality bar), and the slack message builder.

import type { Bullet } from '../../types/index.js';

export const DIGEST_LEAD_IN = 'today in ai:\n\n';
export const MIN_BULLETS = 2;
export const MAX_BULLETS = 3;
export const MAX_TWEET_CHARS = 280;
export const BULLET_PREFIX = '· ';
export const BULLET_SEPARATOR = ': ';

export const FORMAT_RULES: string[] = [
  'Output starts with exactly "today in ai:" then a blank line.',
  `Then 2 or 3 bullets, never 1, never 4. Each bullet starts with "${BULLET_PREFIX}".`,
  `Inside each bullet, separate the headline from the take with "${BULLET_SEPARATOR}" (a colon and a space). Never use an em-dash or hyphen-space-hyphen as a separator.`,
  'Optional closing line at the end, after a blank line. Include only if the bullets share a genuine connecting thread. Otherwise omit.',
  `Total tweet text must be at most ${MAX_TWEET_CHARS} characters including newlines.`,
  'Each bullet must independently pass: (1) names a specific entity (company, model, paper, dollar amount), (2) the take after the colon says something, (3) the take is something a smart reader couldn\'t have generated from the headline alone.',
];

export class DigestFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigestFormatError';
  }
}

/**
 * Renders bullets + optional closing line into the canonical digest text.
 * Throws DigestFormatError if the result exceeds 280 chars or violates structural rules.
 */
export function renderDigest(bullets: Bullet[], closingLine?: string): string {
  if (bullets.length < MIN_BULLETS || bullets.length > MAX_BULLETS) {
    throw new DigestFormatError(
      `Digest must have ${MIN_BULLETS}-${MAX_BULLETS} bullets, got ${bullets.length}`,
    );
  }

  const bulletLines = bullets.map((b) => {
    if (!b.headline.trim() || !b.take.trim()) {
      throw new DigestFormatError('Bullet headline and take must both be non-empty');
    }
    return `${BULLET_PREFIX}${b.headline.trim()}${BULLET_SEPARATOR}${b.take.trim()}`;
  });

  const body = bulletLines.join('\n');
  const trimmedClosing = closingLine?.trim();
  const text =
    DIGEST_LEAD_IN +
    body +
    (trimmedClosing ? `\n\n${trimmedClosing}` : '');

  if (text.length > MAX_TWEET_CHARS) {
    throw new DigestFormatError(
      `Rendered digest is ${text.length} chars, exceeds ${MAX_TWEET_CHARS}`,
    );
  }
  return text;
}

/**
 * Best-effort reverse parse. Returns null if text doesn't fit the canonical shape.
 * Used for validating LLM raw output and for parsing posted-text in dedup.
 */
export function parseDigest(
  text: string,
): { bullets: Bullet[]; closing_line?: string } | null {
  const trimmed = text.trimEnd();
  if (!trimmed.toLowerCase().startsWith('today in ai:')) return null;

  const afterLead = trimmed.slice(trimmed.indexOf('\n')).trimStart();
  // Split on blank line — bullets section above, closing line below (if present)
  const sections = afterLead.split(/\n\s*\n/);
  if (sections.length === 0) return null;
  const bulletsBlock = sections[0];
  if (!bulletsBlock) return null;
  const closing = sections.length > 1 ? sections.slice(1).join('\n\n').trim() : undefined;

  const bulletLines = bulletsBlock.split('\n').filter((l) => l.trim().startsWith(BULLET_PREFIX));
  if (bulletLines.length < MIN_BULLETS || bulletLines.length > MAX_BULLETS) return null;

  const bullets: Bullet[] = [];
  for (const line of bulletLines) {
    const stripped = line.trim().slice(BULLET_PREFIX.length);
    const sepIdx = stripped.indexOf(BULLET_SEPARATOR);
    if (sepIdx === -1) return null;
    const headline = stripped.slice(0, sepIdx).trim();
    const take = stripped.slice(sepIdx + BULLET_SEPARATOR.length).trim();
    if (!headline || !take) return null;
    bullets.push({ headline, take });
  }

  return closing ? { bullets, closing_line: closing } : { bullets };
}
