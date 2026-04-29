# AI Twitter Aggregator

Automated daily-digest poster for an AI news/aggregator account on X. Once a day, the pipeline researches what happened in AI in the last 24 hours, drafts a "today in ai:" tweet with 2-3 specific bullets and sharp interpretation, scores it, and either queues it for Slack approval (manual mode) or posts directly (auto mode).

See `CLAUDE.md` for the full project specification and `SETUP.md` (created during setup) for the credential walkthrough.

## Architecture in one paragraph

Vercel cron fires at 0000 UTC. Three LLM calls produce one tweet: **(1) research** with `gemini-2.5-flash` + Google Search grounding finds 3-5 fresh AI items; **(2) draft** with `gemini-2.5-flash` produces 2 digest variants; **(3) review** with `claude-haiku-4-5-20251001` scores variants and picks a winner (or rejects all and skips the day). Winner gets stored in Neon Postgres with `status='queued'`, a Slack webhook pings with Approve/Reject buttons, and on approval the post goes to X via `twitter-api-v2`. Hybrid LLM choice keeps cost ~$0.03/month — Gemini Flash is free under 250 RPD, Haiku review is the only paid call.

## Quick start

```bash
npm install
cp .env.example .env.local      # fill in real values; see SETUP.md
npm run typecheck               # strict TS check, must pass clean
npm run test                    # validate.ts unit tests
npm run dev                     # boots vercel dev locally
```

Once running:

```bash
curl http://localhost:3000/api/manual/draft-now            # one-off draft, returns variants
curl -X POST http://localhost:3000/api/manual/approve \
  -H 'content-type: application/json' \
  -d '{"id":"<post-uuid>"}'
```

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` strict-mode pass |
| `npm run test` | runs vitest (validate.ts hard-rule tests) |
| `npm run dev` | `vercel dev` — local server with cron + functions |
| `curl /api/manual/draft-now` | runs the pipeline, returns variants without queueing |
| `curl /api/manual/list-queue` | lists pending drafts |
| `curl /api/internal/health` | last-post, skip rate, 7-day cost |

## Cost note

Steady-state ~$0.03/month: Gemini Flash research + draft are free (we use 1 of 250 daily requests), Haiku review is ~$0.001/run × 30 days. Set `PAUSE_POSTING=true` in Vercel env vars at any time to kill the pipeline immediately — no redeploy needed.

## Voice

Sharp curator. Third-person, lowercase, colon-separated headline:take. No em-dashes (the #1 AI-generated-content tell on Twitter). No corporate buzzwords. Skip the day rather than post filler. Full rules live in `lib/config/voice.ts`.
