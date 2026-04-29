import { ok, err } from '../../types/index.js';
import { getPostById, updatePostStatus } from '../../lib/clients/neon.js';
import { updateSlackMessage } from '../../lib/clients/slack.js';
import { log } from '../../lib/utils/logger.js';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return Response.json(err('method-not-allowed'), { status: 405 });

  const body = (await req.json().catch(() => null)) as { id?: unknown; reason?: unknown } | null;
  if (!body || typeof body.id !== 'string') {
    return Response.json(err('id-required'), { status: 400 });
  }
  const id = body.id;
  const reason = typeof body.reason === 'string' ? body.reason : 'manual-reject';

  const post = await getPostById(id);
  if (!post) return Response.json(err('not-found'), { status: 404 });
  if (post.status !== 'queued') return Response.json(err(`post is ${post.status}`), { status: 409 });

  await updatePostStatus(id, { status: 'rejected', reason });

  if (post.slack_message_ts) {
    try {
      await updateSlackMessage(post.slack_message_ts, `❌ Rejected: ${reason}`);
    } catch (e) {
      log('warn', 'slack update failed', { error: String(e) });
    }
  }
  return Response.json(ok({ status: 'rejected' }));
}
