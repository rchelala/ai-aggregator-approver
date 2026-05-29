import { ok, err } from '../../types/index.js';
import { listQueuedPosts } from '../../lib/clients/neon.js';
import { vercelHandler } from '../../lib/utils/vercel-handler.js';

export const config = { api: { bodyParser: false } };

async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return Response.json(err('method-not-allowed'), { status: 405 });
  const queued = await listQueuedPosts();
  return Response.json(ok({ count: queued.length, posts: queued }));
}

export default vercelHandler(handler);
