import type { IncomingMessage, ServerResponse } from 'node:http';

export function vercelHandler(
  handler: (req: Request) => Response | Promise<Response>,
) {
  return async function (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks);

    const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
    const host = (req.headers['x-forwarded-host'] as string) ?? req.headers['host'] ?? 'localhost';
    const url = new URL(req.url ?? '/', `${proto}://${host}`);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((s) => headers.append(k, s));
      else headers.set(k, v);
    }

    const webReq = new Request(url.toString(), {
      method: req.method ?? 'GET',
      headers,
      body: rawBody.length > 0 ? rawBody : undefined,
    });

    try {
      const response = await handler(webReq);
      res.statusCode = response.status;
      response.headers.forEach((val, key) => res.setHeader(key, val));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  };
}
