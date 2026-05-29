import { vercelHandler } from '../../lib/utils/vercel-handler.js';

export const config = { api: { bodyParser: false } };

function handler(_req: Request): Response {
  return Response.json({ ok: true, ts: Date.now() });
}

export default vercelHandler(handler);
