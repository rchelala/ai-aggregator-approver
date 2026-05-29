import { ok, err } from '../../types/index.js';
import { runResearch, EmptyResearchError } from '../../lib/agents/research.js';
import { saveResearchCacheHttp } from '../../lib/clients/neon.js';
import { GeminiQuotaExhaustedError } from '../../lib/clients/gemini.js';
import { log } from '../../lib/utils/logger.js';
import { vercelHandler } from '../../lib/utils/vercel-handler.js';

export const config = { api: { bodyParser: false } };

async function doWork(): Promise<Response> {
  try {
    const research = await runResearch();
    log('info', 'warm-research complete', { item_count: research.items.length });

    // Best-effort DB write — 15s cap so a slow Neon cold-start doesn't eat our budget
    const cacheResult = await Promise.race([
      saveResearchCacheHttp(research).then(() => 'saved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15000)),
    ]);
    log('info', 'research cache write', { result: cacheResult });

    return Response.json(ok({ status: cacheResult === 'saved' ? 'cached' : 'cached_skip_db', item_count: research.items.length }));
  } catch (e) {
    if (e instanceof EmptyResearchError) {
      log('info', 'warm-research: no usable items found');
      return Response.json(ok({ status: 'no_items' }));
    }
    if (e instanceof GeminiQuotaExhaustedError) {
      log('warn', 'warm-research: gemini quota exhausted');
      return Response.json(ok({ status: 'quota_exhausted' }));
    }
    log('error', 'warm-research error', { error: String(e) });
    return Response.json(err(String(e)), { status: 500 });
  }
}

async function handler(_req: Request): Promise<Response> {
  if (process.env.PAUSE_POSTING === 'true') {
    return Response.json(ok({ status: 'paused' }));
  }

  // Global 50s ceiling — must respond before Vercel's 60s hard kill
  return Promise.race([
    doWork(),
    new Promise<Response>((resolve) =>
      setTimeout(() => resolve(Response.json(ok({ status: 'global_timeout' }))), 50000),
    ),
  ]);
}

export default vercelHandler(handler);
