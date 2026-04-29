import { ok, err } from '../../types/index.js';
import { getHealthInfo } from '../../lib/clients/neon.js';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return Response.json(err('method-not-allowed'), { status: 405 });
  const info = await getHealthInfo();
  return Response.json(ok(info));
}
