import { ok, err } from '../../types/index.js';
import { get7DayCost } from '../../lib/clients/neon.js';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return Response.json(err('method-not-allowed'), { status: 405 });
  const cost = await get7DayCost();
  return Response.json(ok(cost));
}
