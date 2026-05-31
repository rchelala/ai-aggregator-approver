import { vercelHandler } from '../../lib/utils/vercel-handler.js';

export const config = { api: { bodyParser: false } };

function handler(_req: Request): Response {
  return Response.json({
    ok: true,
    ts: Date.now(),
    dry_run_raw: process.env['DRY_RUN'] ?? '(not set)',
    approval_mode: process.env['APPROVAL_MODE'] ?? '(not set)',
  });
}

export default vercelHandler(handler);
