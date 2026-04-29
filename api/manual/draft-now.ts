import { ok, err } from '../../types/index.js';
import { runResearch } from '../../lib/agents/research.js';
import { runDraft } from '../../lib/agents/draft.js';
import { runReview } from '../../lib/agents/review.js';
import { getRecent7DaysPostedTexts } from '../../lib/clients/neon.js';
import { validateDraft } from '../../lib/utils/validate.js';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return Response.json(err('method-not-allowed'), { status: 405 });
  }
  try {
    const research = await runResearch();
    const recentTexts = await getRecent7DaysPostedTexts();
    const draft = await runDraft(research, recentTexts);
    const surviving = draft.variants.filter((v) => validateDraft(v.rendered_text).valid);
    const decision = surviving.length > 0 ? await runReview({ variants: surviving }) : null;
    return Response.json(
      ok({
        research_count: research.items.length,
        variants: draft.variants,
        surviving_count: surviving.length,
        decision,
      }),
    );
  } catch (e) {
    return Response.json(err(String(e)), { status: 500 });
  }
}
