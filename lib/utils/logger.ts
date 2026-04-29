import type { ApiLogInsert } from '../../types/index.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function thresholdLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

export function log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[thresholdLevel()]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(ctx ?? {}),
  };

  const line = JSON.stringify(entry) + '\n';
  if (level === 'warn' || level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

/**
 * Records one row in the `api_logs` table. Failure to log MUST never break
 * the calling LLM call — wraps the DB call in try/catch and downgrades to
 * a console warning on error.
 *
 * Dynamic-imports neon.ts so this module can be imported in environments
 * (e.g. tests) where DATABASE_URL isn't set.
 */
export async function recordApiLog(row: ApiLogInsert): Promise<void> {
  try {
    const { insertApiLog } = await import('../clients/neon.js');
    await insertApiLog(row);
  } catch (e) {
    log('warn', 'failed to record api_log', { error: String(e), provider: row.provider, agent_type: row.agent_type });
  }
}
