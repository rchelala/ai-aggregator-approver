import postgres from 'postgres';
import type { PostRow, PostStatus, DraftVariant, ApiLogInsert } from '../../types/index.js';
import { PostRowSchema } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let _db: postgres.Sql | undefined;

export function getDb(): postgres.Sql {
  if (!_db) {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('Missing env var: DATABASE_URL');
    _db = postgres(url, {
      ssl: 'require',
      prepare: false,
      connect_timeout: 10,
      idle_timeout: 20,
      max_lifetime: 60 * 5,
      max: 1,
    });
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// postgres returns Date objects for timestamptz — normalise to ISO string
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
  const sql = getDb();

  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO posts (
      topic,
      research_summary,
      draft_variants,
      selected_variant,
      bullet_breakdown,
      status,
      reason
    ) VALUES (
      ${args.topic},
      ${args.research_summary},
      ${args.draft_variants != null ? sql.json(args.draft_variants) : null},
      ${args.selected_variant},
      ${args.bullet_breakdown != null ? sql.json(args.bullet_breakdown as postgres.JSONValue) : null},
      ${args.status},
      ${args.reason ?? null}
    )
    RETURNING *
  `;

  const row = rows[0];
  if (!row) throw new Error('createPost: no row returned');
  return normaliseRow(row);
}

// ---------------------------------------------------------------------------
// getPostById
// ---------------------------------------------------------------------------

export async function getPostById(id: string): Promise<PostRow | null> {
  const sql = getDb();

  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM posts WHERE id = ${id} LIMIT 1
  `;

  if (rows.length === 0) return null;
  return normaliseRow(rows[0]!);
}

// ---------------------------------------------------------------------------
// updatePostStatus
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
  const sql = getDb();

  // Build dynamic SET clause via postgres fragment list
  const updates: postgres.PendingQuery<postgres.Row[]>[] = [];

  if (fields.status !== undefined) {
    updates.push(sql`status = ${fields.status}`);
  }
  if (fields.posted !== undefined) {
    updates.push(sql`posted = ${fields.posted}`);
  }
  if ('posted_at' in fields) {
    updates.push(sql`posted_at = ${fields.posted_at ?? null}`);
  }
  if ('tweet_id' in fields) {
    updates.push(sql`tweet_id = ${fields.tweet_id ?? null}`);
  }
  if ('reason' in fields) {
    updates.push(sql`reason = ${fields.reason ?? null}`);
  }
  if ('slack_message_ts' in fields) {
    updates.push(sql`slack_message_ts = ${fields.slack_message_ts ?? null}`);
  }

  if (updates.length === 0) return;

  // postgres-js supports joining fragments with sql`...`
  await sql`
    UPDATE posts
    SET ${updates.reduce((acc, frag) => sql`${acc}, ${frag}`)}
    WHERE id = ${id}
  `;
}

// ---------------------------------------------------------------------------
// expireOldQueued
// ---------------------------------------------------------------------------

export async function expireOldQueued(): Promise<number> {
  const sql = getDb();

  const rows = await sql<{ id: string }[]>`
    UPDATE posts
    SET status = 'rejected', reason = 'expired'
    WHERE status = 'queued'
      AND created_at < (now() - interval '24 hours')
    RETURNING id
  `;

  return rows.length;
}

// ---------------------------------------------------------------------------
// listQueuedPosts
// ---------------------------------------------------------------------------

export async function listQueuedPosts(): Promise<PostRow[]> {
  const sql = getDb();

  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM posts
    WHERE status = 'queued'
    ORDER BY created_at ASC
  `;

  return rows.map(normaliseRow);
}

// ---------------------------------------------------------------------------
// getRecent7DaysPostedTexts
// ---------------------------------------------------------------------------

export async function getRecent7DaysPostedTexts(): Promise<string[]> {
  const sql = getDb();

  const rows = await sql<{ selected_variant: string | null }[]>`
    SELECT selected_variant
    FROM posts
    WHERE posted = true
      AND posted_at > now() - interval '7 days'
  `;

  return rows
    .map((r) => r.selected_variant)
    .filter((v): v is string => v != null);
}

// ---------------------------------------------------------------------------
// alreadyRanToday
// ---------------------------------------------------------------------------

export async function alreadyRanToday(): Promise<boolean> {
  const sql = getDb();

  const rows = await sql<{ exists: number }[]>`
    SELECT 1 AS exists
    FROM posts
    WHERE date_trunc('day', created_at AT TIME ZONE 'UTC') = date_trunc('day', now() AT TIME ZONE 'UTC')
      AND status IN ('queued', 'posted')
    LIMIT 1
  `;

  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// insertApiLog
// ---------------------------------------------------------------------------

export async function insertApiLog(row: ApiLogInsert): Promise<void> {
  const sql = getDb();

  await sql`
    INSERT INTO api_logs (
      provider,
      model,
      agent_type,
      input_tokens,
      cached_input_tokens,
      output_tokens,
      cost_usd,
      duration_ms,
      post_id,
      error
    ) VALUES (
      ${row.provider},
      ${row.model},
      ${row.agent_type},
      ${row.input_tokens},
      ${row.cached_input_tokens},
      ${row.output_tokens},
      ${row.cost_usd},
      ${row.duration_ms},
      ${row.post_id},
      ${row.error}
    )
  `;
}

// ---------------------------------------------------------------------------
// get7DayCost
// ---------------------------------------------------------------------------

export async function get7DayCost(): Promise<{
  total_usd: number;
  by_provider: Record<string, number>;
}> {
  const sql = getDb();

  const rows = await sql<{ provider: string; total: string }[]>`
    SELECT provider, SUM(cost_usd)::text AS total
    FROM api_logs
    WHERE timestamp > now() - interval '7 days'
      AND cost_usd IS NOT NULL
    GROUP BY provider
  `;

  const by_provider: Record<string, number> = {};
  let total_usd = 0;

  for (const row of rows) {
    const amount = parseFloat(row.total ?? '0');
    by_provider[row.provider] = amount;
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
  const sql = getDb();

  // Last posted
  const [lastPostedRow] = await sql<{ posted_at: Date | null }[]>`
    SELECT posted_at
    FROM posts
    WHERE posted = true
    ORDER BY posted_at DESC
    LIMIT 1
  `;

  const last_posted_at = toIso(lastPostedRow?.posted_at ?? null);

  // Last skip (most recent rejected row with a reason)
  const [lastSkipRow] = await sql<{ created_at: Date; reason: string | null }[]>`
    SELECT created_at, reason
    FROM posts
    WHERE status = 'rejected'
      AND reason IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const last_skip =
    lastSkipRow != null
      ? {
          date: toIso(lastSkipRow.created_at) ?? '',
          reason: lastSkipRow.reason ?? '',
        }
      : null;

  // Skip rate over 7 days
  const [statsRow] = await sql<{ total: string; rejected: string }[]>`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE status = 'rejected')::text AS rejected
    FROM posts
    WHERE created_at > now() - interval '7 days'
  `;

  const total7d = parseInt(statsRow?.total ?? '0', 10);
  const rejected7d = parseInt(statsRow?.rejected ?? '0', 10);
  const skip_rate_7d = total7d > 0 ? rejected7d / total7d : 0;

  // Cost 7d
  const { total_usd } = await get7DayCost();

  return {
    last_posted_at,
    last_skip,
    skip_rate_7d,
    cost_usd_7d: total_usd,
  };
}
