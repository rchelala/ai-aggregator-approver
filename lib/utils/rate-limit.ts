import { neon } from '@neondatabase/serverless';

export const X_FREE_TIER_DAILY_LIMIT = 17;
export const PROJECT_DAILY_LIMIT = 1;

export async function checkDailyPostQuota(): Promise<{
  ok: boolean;
  postedToday: number;
  limit: number;
}> {
  const rawUrl = process.env['DATABASE_URL'];
  if (!rawUrl) throw new Error('Missing env var: DATABASE_URL');
  const url = rawUrl
    .replace(/[?&]channel_binding=[^&]*/i, '')
    .replace(/\?&/, '?')
    .replace(/[?&]$/, '');
  const sql = neon(url);
  const rows = await sql`
    select count(*)::int as cnt
    from posts
    where date_trunc('day', posted_at at time zone 'UTC') = date_trunc('day', now() at time zone 'UTC')
      and posted = true
  ` as { cnt: number }[];
  const cnt = rows[0]?.cnt ?? 0;
  return {
    ok: cnt < PROJECT_DAILY_LIMIT,
    postedToday: cnt,
    limit: PROJECT_DAILY_LIMIT,
  };
}
