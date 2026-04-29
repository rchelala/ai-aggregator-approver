import { describe, it, expect } from 'vitest';
import { validateDraft } from '../lib/utils/validate.js';
import { GOOD_EXAMPLES } from '../lib/config/voice.js';

const validBase = `today in ai:

· anthropic dropped opus 4.7, 20% cheaper input: they want you cached, not one-shot
· cursor raised at $9b: the ide is the moat now, not the model

two bets on distribution.`;

describe('validateDraft', () => {
  it('accepts a clean digest from GOOD_EXAMPLES', () => {
    const result = validateDraft(GOOD_EXAMPLES[0]!);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('accepts the validBase fixture', () => {
    const result = validateDraft(validBase);
    expect(result.valid).toBe(true);
  });

  it('rejects an em-dash inside a bullet take', () => {
    const text = `today in ai:

· anthropic dropped opus 4.7 — they want you cached
· cursor raised at $9b: the ide is the moat now`;
    const result = validateDraft(text);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes('em-dash'))).toBe(true);
  });

  it('rejects the banned buzzword "delve"', () => {
    const text = `today in ai:

· anthropic dropped opus 4.7: builders should delve into the new caching
· cursor raised at $9b: the ide is the moat now, not the model`;
    const result = validateDraft(text);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.toLowerCase().includes('delve'))).toBe(true);
  });

  it('rejects text over 280 chars', () => {
    const longTake = 'a'.repeat(260);
    const text = `today in ai:

· anthropic launched: ${longTake}
· cursor raised: ${longTake}`;
    const result = validateDraft(text);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes('over-length'))).toBe(true);
  });

  it('rejects 4 bullets (over MAX_BULLETS)', () => {
    const text = `today in ai:

· one: take one here
· two: take two here
· three: take three here
· four: take four here`;
    const result = validateDraft(text);
    expect(result.valid).toBe(false);
    expect(
      result.violations.some(
        (v) => v.includes('does-not-match-digest-format') || v.includes('bullet count'),
      ),
    ).toBe(true);
  });

  it('rejects 1 bullet (under MIN_BULLETS)', () => {
    const text = `today in ai:

· anthropic dropped opus 4.7: they want you cached`;
    const result = validateDraft(text);
    expect(result.valid).toBe(false);
    expect(
      result.violations.some(
        (v) => v.includes('does-not-match-digest-format') || v.includes('bullet count'),
      ),
    ).toBe(true);
  });

  it('rejects 2+ hashtags', () => {
    const text = `today in ai:

· anthropic dropped opus 4.7: they want you cached #ai
· cursor raised at $9b: the ide is the moat now #llm #news`;
    const result = validateDraft(text);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes('hashtag'))).toBe(true);
  });

  it('rejects an emoji', () => {
    const text = `today in ai:

· anthropic dropped opus 4.7: they want you cached 🚀
· cursor raised at $9b: the ide is the moat now`;
    const result = validateDraft(text);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.toLowerCase().includes('emoji'))).toBe(true);
  });

  it('rejects "Just " opener', () => {
    const text = `Just dropped a hot take on AI`;
    const result = validateDraft(text);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes('Just'))).toBe(true);
  });

  it('rejects "it\'s not just X, it\'s Y" pattern', () => {
    const text = `today in ai:

· anthropic dropped opus 4.7: it's not just cheaper, it's stickier
· cursor raised at $9b: the ide is the moat now, not the model`;
    const result = validateDraft(text);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.toLowerCase().includes("not just"))).toBe(true);
  });

  it('rejects a draft that is not the digest format at all', () => {
    const text = `Hey followers, here is some news about AI today. Anthropic dropped Opus 4.7.`;
    const result = validateDraft(text);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes('does-not-match-digest-format'))).toBe(true);
  });
});
