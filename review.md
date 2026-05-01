# Project Review Log

A running record of session-level context: what got done and what's still broken. Updated at the end of each session before context clears, so the next session can pick up state without re-deriving it from git history.

## How to update
- Add a new dated block at the **top** of the Sessions section: `### YYYY-MM-DD — <one-line summary>`
- Each block has two subsections: `**Done**` and `**Known issues**`
- If an issue persists across multiple sessions, promote it to `Standing known issues` at the bottom
- Don't restate things that are obvious from `CLAUDE.md` or `git log` — record the *non-obvious*: diagnoses, env quirks, doc drift, things observed but not committed

---

## Project Snapshot
- **Repo:** `ai-aggregator-approver` (https://github.com/rchelala/ai-aggregator-approver.git)
- **Deploy:** https://ai-aggregator-approver.vercel.app
- **Stack:** Node 20, TypeScript (ESM, strict), Vercel functions + cron, Neon Postgres (pooled), Anthropic Claude, X API v2
- **Branch:** `main` (Vercel auto-deploys on push)

---

## Sessions

### 2026-05-01 — Doc reconciliation + prod hang still unresolved
**Done**
- Verified the `prepare: false` fix is correct in isolation: `scripts/diag-neon.mjs` connects to Neon with the same URL and options the app uses, runs the `cost` query in 108ms, ping in ~1.4s
- Reconciled `CLAUDE.md` with the actual stack: Supabase → Neon throughout (Storage line, architecture diagram, file tree, schema header, env vars, `api_logs` reference)
- Cron section now matches the deployed `0 0 * * *` (was documented as `0 16,22 * * *`); intent recorded that doc and `vercel.json` should be updated together going forward
- Project Structure expanded to cover the previously undocumented surface: `/api/internal/health.ts`, `/api/internal/cost.ts`, `reject.ts`, `list-queue.ts`, `slack-action.ts`, `lib/clients/slack.ts`, `lib/clients/gemini.ts`, `scripts/diag-neon.mjs`
- Env vars section rewritten to reflect what the code actually reads (`DATABASE_URL`, Slack trio + `SLACK_CHANNEL`, `GEMINI_API_KEY`, `DRY_RUN`, `LOG_LEVEL`); added a callout that `prepare: false` is load-bearing — re-enabling prepared statements reintroduces the prod hang from `e65899b`
- Added `scripts/diag-neon.mjs` as a reusable connection-test (parses `.env.local` itself, no `dotenv` dep)

**Known issues**
- **Prod still hangs.** `/api/internal/health` and `/api/internal/cost` return `FUNCTION_INVOCATION_TIMEOUT` after 300s. Local connect with the same URL+options succeeds in <2s, so the bug is not in our code. Most likely cause: the Vercel production build is still serving a pre-`e65899b` snapshot, or Vercel's `DATABASE_URL` env var doesn't match `.env.local`. Pushing this docs commit will trigger a fresh deploy — re-curl after Vercel finishes.
- If the redeploy doesn't fix it, next steps: open the Vercel dashboard, confirm the live deployment SHA is `e65899b` or later, and confirm production `DATABASE_URL` matches the working local one. `gh` CLI is not installed on this machine, so deployment status can't be queried from here.

### 2026-05-01 — Health/cost endpoint hang fix
**Done**
- Diagnosed `/api/internal/health` and `/api/internal/cost` hanging in production (30s+ timeouts, 0 bytes returned)
- Root cause: `DATABASE_URL` points at the Neon **pooled** endpoint (`-pooler` host = PgBouncer in transaction mode), which doesn't support session-level prepared statements that the `postgres` npm package uses by default
- Fix: added `prepare: false` to `postgres()` options at `lib/clients/neon.ts:15`
- Typecheck passed (`npx tsc --noEmit`), committed as `e65899b`, pushed to `main`

**Known issues**
- Fix not yet re-verified by curling the deployed endpoint after Vercel finished its deploy
- `CLAUDE.md` documents Supabase as the storage layer, but the code actually uses Neon (`lib/clients/neon.ts`) — doc drift, pick one source of truth
- `CLAUDE.md`'s schema and env-var sections still reference `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`; production is using `DATABASE_URL` instead

---

## Standing known issues
_(none — Supabase/Neon doc drift was resolved on 2026-05-01.)_
