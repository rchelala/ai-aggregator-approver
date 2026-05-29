import { ok, err } from '../../types/index.js';
import { runResearch } from '../../lib/agents/research.js';
import { runDraft } from '../../lib/agents/draft.js';
import { getRecent7DaysPostedTexts, getLatestResearchCache } from '../../lib/clients/neon.js';
import { validateDraft } from '../../lib/utils/validate.js';
import { vercelHandler } from '../../lib/utils/vercel-handler.js';

export const config = { api: { bodyParser: false } };

async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return Response.json(err('method-not-allowed'), { status: 405 });
  }
  try {
    const cached = await getLatestResearchCache(120);
    const research = cached ?? await runResearch();
    const recentTexts = await getRecent7DaysPostedTexts();
    const draft = await runDraft(research, recentTexts);
    const surviving = draft.variants.filter((v) => validateDraft(v.rendered_text).valid);
    return Response.json(
      ok({
        research_count: research.items.length,
        variants: draft.variants,
        surviving_count: surviving.length,
      }),
    );
  } catch (e) {
    return Response.json(err(String(e)), { status: 500 });
  }
}

export default vercelHandler(handler);
