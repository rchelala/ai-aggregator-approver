import { ok, err } from '../../types/index.js';
import { listQueuedPosts } from '../../lib/clients/neon.js';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return Response.json(err('method-not-allowed'), { status: 405 });
  const queued = await listQueuedPosts();
  return Response.json(ok({ count: queued.length, posts: queued }));
}
