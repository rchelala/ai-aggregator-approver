export default function handler(_req: Request): Response {
  return Response.json({ ok: true, ts: Date.now() });
}
