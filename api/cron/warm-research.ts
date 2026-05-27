import { ok, err } from '../../types/index.js';
import { runResearch, EmptyResearchError } from '../../lib/agents/research.js';
import { saveResearchCache } from '../../lib/clients/neon.js';
import { GeminiQuotaExhaustedError } from '../../lib/clients/gemini.js';
import { log } from '../../lib/utils/logger.js';

export default async function handler(_req: Request): Promise<Response> {
  if (process.env.PAUSE_POSTING === 'true') {
    return Response.json(ok({ status: 'paused' }));
  }

  try {
    const research = await runResearch();
    log('info', 'warm-research complete', { item_count: research.items.length });

    // Best-effort DB write — if Neon is slow, skip it rather than timing out the whole function
    const cacheResult = await Promise.race([
      saveResearchCache(research).then(() => 'saved' as const),
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
