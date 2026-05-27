import { neon } from '@neondatabase/serverless';
import type { PostRow, PostStatus, DraftVariant, ApiLogInsert, ResearchOutput } from '../../types/index.js';
import { PostRowSchema, ResearchOutputSchema } from '../../types/index.js';

// ---------------------------------------------------------------------------
// HTTP client — @neondatabase/serverless (no persistent TCP socket)
// Using HTTP mode means no lingering sockets after queries complete, which
// allows Vercel's Node.js runtime to terminate functions cleanly.
// ---------------------------------------------------------------------------

function getClient() {
  const rawUrl = process.env['DATABASE_URL'];
  if (!rawUrl) throw new Error('Missing env var: DATABASE_URL');
  // Strip channel_binding — the neon HTTP driver doesn't need it
  const url = rawUrl
    .replace(/[?&]channel_binding=[^&]*/i, '')
    .replace(/\?&/, '?')
    .replace(/[?&]$/, '');
  return neon(url);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toIso(val: unknown): string | null {
  if (val == null) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') return val;
  return String(val);
}

function normaliseRow(raw: Record<string, unknown>): PostRow {
  return PostRowSchema.parse({
    ...raw,
    created_at: toIso(raw['created_at']),
    posted_at: toIso(raw['posted_at']),
  });
}

// ---------------------------------------------------------------------------
// createPost
// ---------------------------------------------------------------------------

export async function createPost(args: {
  topic: string;
  research_summary: string | null;
  draft_variants: DraftVariant[] | null;
  selected_variant: string | null;
  bullet_breakdown: unknown | null;
  status: PostStatus;
  reason?: string | null;
}): Promise<PostRow> {
  const sql = getClient();

  const dv = args.draft_variants != null ? JSON.stringify(args.draft_variants) : null;
  const bb = args.bullet_breakdown != null ? JSON.stringify(args.bullet_breakdown) : null;

  const rows = await sql`
    INSERT INTO posts (
      topic, research_summary, draft_variants, selected_variant,
      bullet_breakdown, status, reason
    ) VALUES (
      ${args.topic},
      ${args.research_summary},
      ${dv}::jsonb,
      ${args.selected_variant},
      ${bb}::jsonb,
      ${args.status},
      ${args.reason ?? null}
    )
    RETURNING *
  ` as Record<string, unknown>[];

  const row = rows[0];
  if (!row) throw new Error('createPost: no row returned');
  return normaliseRow(row);
}

// ---------------------------------------------------------------------------
// getPostById
// ---------------------------------------------------------------------------

export async function getPostById(id: string): Promise<PostRow | null> {
  const sql = getClient();
  const rows = await sql`SELECT * FROM posts WHERE id = ${id} LIMIT 1` as Record<string, unknown>[];
  if (rows.length === 0) return null;
  return normaliseRow(rows[0]!);
}

// ---------------------------------------------------------------------------
// updatePostStatus — individual field updates (HTTP driver has no fragment API)
// ---------------------------------------------------------------------------

export async function updatePostStatus(
  id: string,
  fields: {
    status?: PostStatus;
    posted?: boolean;
    posted_at?: Date | null;
    tweet_id?: string | null;
    reason?: string | null;
    slack_message_ts?: string | null;
  },
): Promise<void> {
  // The neon HTTP driver has no composable fragment API, so we issue one
  // UPDATE per changed field. Non-atomic but fine for a low-volume pipeline.
  const sql = getClient();
  const updates: Promise<unknown>[] = [];

  if (fields.status !== undefined) updates.push(sql`UPDATE posts SET status = ${fields.status} WHERE id = ${id}`);
  if (fields.posted !== undefined) updates.push(sql`UPDATE posts SET posted = ${fields.posted} WHERE id = ${id}`);
  if ('posted_at' in fields) updates.push(sql`UPDATE posts SET posted_at = ${fields.posted_at ?? null} WHERE id = ${id}`);
  if ('tweet_id' in fields) updates.push(sql`UPDATE posts SET tweet_id = ${fields.tweet_id ?? null} WHERE id = ${id}`);
  if ('reason' in fields) updates.push(sql`UPDATE posts SET reason = ${fields.reason ?? null} WHERE id = ${id}`);
  if ('slack_message_ts' in fields) updates.push(sql`UPDATE posts SET slack_message_ts = ${fields.slack_message_ts ?? null} WHERE id = ${id}`);

  await Promise.all(updates);
}

// ---------------------------------------------------------------------------
// expireOldQueued
// ---------------------------------------------------------------------------

export async function expireOldQueued(): Promise<number> {
  const sql = getClient();
  const rows = await sql`
    UPDATE posts SET status = 'rejected', reason = 'expired'
    WHERE status = 'queued' AND created_at < (now() - interval '24 hours')
    RETURNING id
  ` as { id: string }[];
  return rows.length;
}

// ---------------------------------------------------------------------------
// listQueuedPosts
// ---------------------------------------------------------------------------

export async function listQueuedPosts(): Promise<PostRow[]> {
  const sql = getClient();
  const rows = await sql`
    SELECT * FROM posts WHERE status = 'queued' ORDER BY created_at ASC
  ` as Record<string, unknown>[];
  return rows.map(normaliseRow);
}

// ---------------------------------------------------------------------------
// getRecent7DaysPostedTexts
// ---------------------------------------------------------------------------

export async function getRecent7DaysPostedTexts(): Promise<string[]> {
  const sql = getClient();
  const rows = await sql`
    SELECT selected_variant FROM posts
    WHERE posted = true AND posted_at > now() - interval '7 days'
  ` as { selected_variant: string | null }[];
  return rows.map((r) => r.selected_variant).filter((v): v is string => v != null);
}

// ---------------------------------------------------------------------------
// alreadyRanToday
// ---------------------------------------------------------------------------

export async function alreadyRanToday(): Promise<boolean> {
  const sql = getClient();
  const rows = await sql`
    SELECT 1 AS exists FROM posts
    WHERE date_trunc('day', created_at AT TIME ZONE 'UTC') = date_trunc('day', now() AT TIME ZONE 'UTC')
      AND status IN ('queued', 'posted')
    LIMIT 1
  ` as { exists: number }[];
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// insertApiLog
// ---------------------------------------------------------------------------

export async function insertApiLog(row: ApiLogInsert): Promise<void> {
  const sql = getClient();
  await sql`
    INSERT INTO api_logs (
      provider, model, agent_type, input_tokens, cached_input_tokens,
      output_tokens, cost_usd, duration_ms, post_id, error
    ) VALUES (
      ${row.provider}, ${row.model}, ${row.agent_type}, ${row.input_tokens},
      ${row.cached_input_tokens}, ${row.output_tokens}, ${row.cost_usd},
      ${row.duration_ms}, ${row.post_id}, ${row.error}
    )
  `;
}

// ---------------------------------------------------------------------------
// get7DayCost
// ---------------------------------------------------------------------------

export async function get7DayCost(): Promise<{ total_usd: number; by_provider: Record<string, number> }> {
  const sql = getClient();
  const rows = await sql`
    SELECT provider, SUM(cost_usd)::text AS total
    FROM api_logs
    WHERE timestamp > now() - interval '7 days' AND cost_usd IS NOT NULL
    GROUP BY provider
  ` as { provider: string; total: string }[];
  const by_provider: Record<string, number> = {};
  let total_usd = 0;
  for (const r of rows) {
    const amount = parseFloat(r.total ?? '0');
    by_provider[r.provider] = amount;
    total_usd += amount;
  }
  return { total_usd, by_provider };
}

// ---------------------------------------------------------------------------
// getHealthInfo
// ---------------------------------------------------------------------------

export async function getHealthInfo(): Promise<{
  last_posted_at: string | null;
  last_skip: { date: string; reason: string } | null;
  skip_rate_7d: number;
  cost_usd_7d: number;
}> {
  const sql = getClient();

  const lastPostedRows = await sql`
    SELECT posted_at FROM posts WHERE posted = true ORDER BY posted_at DESC LIMIT 1
  ` as { posted_at: string | null }[];
  const lastSkipRows = await sql`
    SELECT created_at, reason FROM posts
    WHERE status = 'rejected' AND reason IS NOT NULL ORDER BY created_at DESC LIMIT 1
  ` as { created_at: string; reason: string | null }[];
  const statsRows = await sql`
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE status = 'rejected')::text AS rejected
    FROM posts WHERE created_at > now() - interval '7 days'
  ` as { total: string; rejected: string }[];

  const statsRow = statsRows[0];
  const total7d = parseInt(statsRow?.total ?? '0', 10);
  const rejected7d = parseInt(statsRow?.rejected ?? '0', 10);
  const { total_usd } = await get7DayCost();

  return {
    last_posted_at: toIso(lastPostedRows[0]?.posted_at ?? null),
    last_skip: lastSkipRows[0]
      ? { date: toIso(lastSkipRows[0].created_at) ?? '', reason: lastSkipRows[0].reason ?? '' }
      : null,
    skip_rate_7d: total7d > 0 ? rejected7d / total7d : 0,
    cost_usd_7d: total_usd,
  };
}

// ---------------------------------------------------------------------------
// saveResearchCache / getLatestResearchCache
// ---------------------------------------------------------------------------

export async function saveResearchCache(output: ResearchOutput): Promise<void> {
  const sql = getClient();
  await sql`INSERT INTO research_cache (items) VALUES (${JSON.stringify(output.items)}::jsonb)`;
}

// Alias used by warm-research (kept for backwards compat)
export const saveResearchCacheHttp = saveResearchCache;

export async function getLatestResearchCache(maxAgeMinutes: number): Promise<ResearchOutput | null> {
  const sql = getClient();
  const rows = await sql`
    SELECT items FROM research_cache
    WHERE created_at > now() - (${maxAgeMinutes} * interval '1 minute')
    ORDER BY created_at DESC LIMIT 1
  ` as { items: unknown }[];
  if (rows.length === 0) return null;
  return ResearchOutputSchema.parse({ items: rows[0]!.items });
}
