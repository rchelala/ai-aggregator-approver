/**
 * Daily X post quota tracking. The X free tier allows 17 posts/day,
 * but project policy is 1/day to keep signal density high.
 */

export const X_FREE_TIER_DAILY_LIMIT = 17;
export const PROJECT_DAILY_LIMIT = 1;

export async function checkDailyPostQuota(): Promise<{
  ok: boolean;
  postedToday: number;
  limit: number;
}> {
  const { getDb } = await import('../clients/neon.js');
  const sql = getDb();
  const rows = await sql<{ cnt: number }[]>`
    select count(*)::int as cnt
    from posts
    where date_trunc('day', posted_at at time zone 'UTC') = date_trunc('day', now() at time zone 'UTC')
      and posted = true
  `;
  const cnt = rows[0]?.cnt ?? 0;
  return {
    ok: cnt < PROJECT_DAILY_LIMIT,
    postedToday: cnt,
    limit: PROJECT_DAILY_LIMIT,
  };
}
