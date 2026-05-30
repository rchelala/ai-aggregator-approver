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

    const bodyText = rawBody.length > 0 ? rawBody.toString('utf-8') : null;

    const webReq = new Request(url.toString(), {
      method: req.method ?? 'GET',
      headers,
      body: bodyText ?? undefined,
    });

    // Patch body readers: undici's Request body stream is unreliable when
    // constructed from raw bytes. We've already read the bytes, so serve them
    // directly from the pre-read string.
    if (bodyText !== null) {
      Object.defineProperty(webReq, 'text', { value: () => Promise.resolve(bodyText) });
      Object.defineProperty(webReq, 'json', { value: () => Promise.resolve(JSON.parse(bodyText)) });
    }

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
