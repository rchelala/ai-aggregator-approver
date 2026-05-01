// One-shot diagnostic: connect to Neon with the same options the app uses
// and run the same query as /api/internal/cost. Hard timeout at 20s.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

// Load .env.local manually (no dotenv dep)
try {
  const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL missing');
  process.exit(2);
}

const masked = url.replace(/:([^:@]+)@/, ':***@');
console.log('[diag] url:', masked);

const sql = postgres(url, {
  ssl: 'require',
  prepare: false,
  connect_timeout: 10,
  idle_timeout: 5,
});

const hardKill = setTimeout(() => {
  console.error('[diag] HARD TIMEOUT 20s — connection or query hung');
  process.exit(3);
}, 20_000).unref();

try {
  const t0 = Date.now();
  const ping = await sql`SELECT 1 AS ok`;
  console.log(`[diag] ping ok in ${Date.now() - t0}ms:`, ping[0]);

  const t1 = Date.now();
  const rows = await sql`
    SELECT provider, SUM(cost_usd)::text AS total
    FROM api_logs
    WHERE timestamp > now() - interval '7 days'
      AND cost_usd IS NOT NULL
    GROUP BY provider
  `;
  console.log(`[diag] cost query ok in ${Date.now() - t1}ms, rows:`, rows.length);
  console.log('[diag] sample:', rows.slice(0, 3));
} catch (e) {
  console.error('[diag] ERROR:', e?.message ?? e);
  process.exit(1);
} finally {
  clearTimeout(hardKill);
  await sql.end({ timeout: 5 });
}
