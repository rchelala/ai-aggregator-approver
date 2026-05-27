import { ok, err } from '../../types/index.js';

export default async function handler(_req: Request): Promise<Response> {
  const steps: { step: string; ms: number }[] = [];
  const t0 = Date.now();

  // Step 1: HN fetch
  try {
    const since = Math.floor(Date.now() / 1000) - 86400;
    const res = await fetch(
      `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=AI&hitsPerPage=5&numericFilters=created_at_i>${since}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const data = await res.json() as { hits: unknown[] };
    steps.push({ step: `HN fetch (${data.hits.length} hits)`, ms: Date.now() - t0 });
  } catch (e) {
    steps.push({ step: `HN fetch ERROR: ${e}`, ms: Date.now() - t0 });
  }

  // Step 2: Neon ping
  const t1 = Date.now();
  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env['DATABASE_URL']!.replace(/[?&]channel_binding=[^&]*/i, '').replace(/\?&/, '?').replace(/[?&]$/, ''));
    await sql`SELECT 1 AS ping`;
    steps.push({ step: 'Neon ping', ms: Date.now() - t1 });
  } catch (e) {
    steps.push({ step: `Neon ping ERROR: ${e}`, ms: Date.now() - t1 });
  }

  // Step 3: Gemini ping (minimal call)
  const t2 = Date.now();
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent('Say "ok" and nothing else.');
    const text = result.response.text().slice(0, 20);
    steps.push({ step: `Gemini 2.0-flash: "${text}"`, ms: Date.now() - t2 });
  } catch (e) {
    steps.push({ step: `Gemini ERROR: ${e}`, ms: Date.now() - t2 });
  }

  return Response.json(ok({ total_ms: Date.now() - t0, steps }));
}
