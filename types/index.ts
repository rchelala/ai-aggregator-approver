import { z } from 'zod';

// =====================================================================
// API response shape — every route returns this (CLAUDE.md mandate)
// =====================================================================

export const ApiResponseSchema = <T>(dataSchema: z.ZodType<T>) =>
  z.union([
    z.object({ ok: z.literal(true), data: dataSchema.optional() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]);

export type ApiResponse<T> =
  | { ok: true; data?: T }
  | { ok: false; error: string };

export const ok = <T>(data?: T): ApiResponse<T> => ({ ok: true, data });
export const err = <T = never>(error: string): ApiResponse<T> => ({ ok: false, error });

// =====================================================================
// LLM provider tags (used by api_logs)
// =====================================================================

export const LlmProviderSchema = z.enum(['gemini', 'anthropic']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const AgentTypeSchema = z.enum(['research', 'draft', 'review']);
export type AgentType = z.infer<typeof AgentTypeSchema>;

// =====================================================================
// Research output — what the research agent produces
// =====================================================================

export const ResearchItemSchema = z.object({
  headline: z.string().min(1).max(200),
  source_url: z.string().url(),
  why_matters_hint: z.string().min(1).max(300),
  published_at: z.string().optional(),
});
export type ResearchItem = z.infer<typeof ResearchItemSchema>;

export const ResearchOutputSchema = z.object({
  items: z.array(ResearchItemSchema).min(1).max(10),
});
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

// =====================================================================
// Draft structures — bullets + variants
// =====================================================================

export const BulletSchema = z.object({
  headline: z.string().min(1).max(120),
  take: z.string().min(1).max(120),
  source_url: z.string().url().optional(),
});
export type Bullet = z.infer<typeof BulletSchema>;

export const DraftVariantSchema = z.object({
  bullets: z.array(BulletSchema).min(2).max(3),
  closing_line: z.string().max(140).optional(),
  rendered_text: z.string().max(280),
});
export type DraftVariant = z.infer<typeof DraftVariantSchema>;

export const DraftOutputSchema = z.object({
  variants: z.array(DraftVariantSchema).min(1).max(3),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

// =====================================================================
// Review structures — per-bullet and per-variant scoring
// =====================================================================

export const BulletScoreSchema = z.object({
  index: z.number().int().min(0).max(2),
  score: z.number().int().min(1).max(10),
  passes_specific_entity: z.boolean(),
  passes_says_something: z.boolean(),
  passes_non_obvious_take: z.boolean(),
  notes: z.string().optional(),
});
export type BulletScore = z.infer<typeof BulletScoreSchema>;

export const VariantReviewSchema = z.object({
  variant_index: z.number().int().min(0),
  overall_score: z.number().min(1).max(10),
  hook: z.number().int().min(1).max(10),
  voice_match: z.number().int().min(1).max(10),
  substance: z.number().int().min(1).max(10),
  originality: z.number().int().min(1).max(10),
  bullet_scores: z.array(BulletScoreSchema),
  reasoning: z.string(),
});
export type VariantReview = z.infer<typeof VariantReviewSchema>;

export const ReviewDecisionSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('picked'),
    winner_index: z.number().int().min(0),
    reviews: z.array(VariantReviewSchema),
  }),
  z.object({
    outcome: z.literal('rejected'),
    reason: z.string(),
    reviews: z.array(VariantReviewSchema),
  }),
]);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

// =====================================================================
// posts table row
// =====================================================================

export const PostStatusSchema = z.enum(['queued', 'posted', 'rejected', 'failed']);
export type PostStatus = z.infer<typeof PostStatusSchema>;

export const PostRowSchema = z.object({
  id: z.string().uuid(),
  created_at: z.string(),
  topic: z.string(),
  research_summary: z.string().nullable(),
  draft_variants: z.array(DraftVariantSchema).nullable(),
  selected_variant: z.string().nullable(),
  bullet_breakdown: z.unknown().nullable(),
  engagement_metrics: z.unknown().nullable(),
  posted: z.boolean(),
  posted_at: z.string().nullable(),
  tweet_id: z.string().nullable(),
  status: PostStatusSchema,
  reason: z.string().nullable(),
  slack_message_ts: z.string().nullable(),
});
export type PostRow = z.infer<typeof PostRowSchema>;

// =====================================================================
// Slack interactive payloads
// =====================================================================

export const SlackActionSchema = z.object({
  action: z.enum(['approve', 'reject']),
  post_id: z.string().uuid(),
  user_id: z.string(),
  message_ts: z.string(),
  response_url: z.string().url(),
});
export type SlackAction = z.infer<typeof SlackActionSchema>;

// =====================================================================
// Validation result (used by validate.ts)
// =====================================================================

export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  violations: z.array(z.string()),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// =====================================================================
// api_logs row (per LLM call)
// =====================================================================

export const ApiLogRowSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string(),
  provider: LlmProviderSchema,
  model: z.string(),
  agent_type: AgentTypeSchema,
  input_tokens: z.number().int().nullable(),
  cached_input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  duration_ms: z.number().int().nullable(),
  post_id: z.string().uuid().nullable(),
  error: z.string().nullable(),
});
export type ApiLogRow = z.infer<typeof ApiLogRowSchema>;

export type ApiLogInsert = Omit<ApiLogRow, 'id' | 'timestamp'>;
