# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
Automated Twitter/X posting pipeline. Claude researches topics, drafts posts, and publishes to a designated Twitter account on a schedule (or on-demand). Goal: hands-off content generation with human-quality voice and zero generic AI slop.

## Tech Stack
- **Runtime:** Node.js 20+ (TypeScript)
- **Scheduler:** Vercel Cron
- **AI:** Anthropic Claude API (`claude-sonnet-4-6` for drafting, `claude-haiku-4-5-20251001` for filtering/scoring)
- **Twitter:** X API v2 via `twitter-api-v2` npm package
- **Research:** Claude's `web_search` tool (built-in, no separate search API needed)
- **Storage:** Supabase (post history, topic queue, analytics)
- **Hosting:** Vercel (serverless functions + cron)

## Development Commands

```bash
# Install dependencies
npm install

# Type check
npx tsc --noEmit

# Run locally (Vercel dev server)
npx vercel dev

# Trigger a manual draft (no posting)
curl http://localhost:3000/api/manual/draft-now

# Approve a queued draft
curl -X POST http://localhost:3000/api/manual/approve -d '{"id":"<post-id>"}'

# Run the cron handler manually
curl http://localhost:3000/api/cron/post-tweet
```

## Architecture

```
[Cron trigger] → [Research agent] → [Draft agent] → [Review/Score] → [Post to X] → [Log to Supabase]
```

Three Claude calls per post:
1. **Research** — Claude with `web_search` finds 3–5 fresh, relevant items in the niche
2. **Draft** — Claude writes 2–3 tweet variants in the configured voice
3. **Review** — Claude (Haiku) scores variants and picks the best, or rejects all if quality is low

## Project Structure

```
/api
  /cron
    post-tweet.ts          # Vercel cron entrypoint
  /manual
    draft-now.ts           # On-demand draft (returns variants, no auto-post)
    approve.ts             # Approve a queued draft and post it
/lib
  /agents
    research.ts            # Research agent (Claude + web_search)
    draft.ts               # Draft agent (variants)
    review.ts              # Review/score agent
  /clients
    anthropic.ts           # Claude API wrapper
    twitter.ts             # X API wrapper
    supabase.ts            # DB client
  /config
    voice.ts               # Voice/style guide (tone, do's, don'ts)
    topics.ts              # Topic seeds and niche definition
  /utils
    rate-limit.ts          # Respect X API limits
    logger.ts              # Structured logging
/types
  index.ts                 # Shared TS types
.env.local                 # Secrets (never commit)
vercel.json                # Cron schedule
```

## Environment Variables
```
ANTHROPIC_API_KEY=
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
APPROVAL_MODE=auto|manual    # auto = post directly, manual = queue for approval
PAUSE_POSTING=               # Set to "true" as kill switch
```

## Voice & Style Rules
Defined in `/lib/config/voice.ts`. Hard rules — Claude must follow on every draft:
- **No em-dashes.** Use commas, periods, or parentheses instead.
- **No "It's not just X, it's Y" constructions.**
- **No corporate buzzwords:** delve, leverage, unlock, harness, navigate the landscape.
- **No emojis** unless the voice config explicitly enables them.
- **No hashtag stuffing.** Max 1 hashtag per tweet, only if it adds reach.
- **Lowercase-friendly** if voice config sets `casual: true`.
- **Under 280 chars.** Always validate before posting.
- **Specific over generic.** Concrete numbers, names, examples beat vague claims.

## Post Quality Bar
Every draft must pass review with score ≥ 7/10 on:
1. **Hook** — does the first line make you want to read the second?
2. **Voice match** — does it sound like the configured voice, not Claude?
3. **Substance** — does it say something, or is it filler?
4. **Originality** — is this a take, not a recap?

If no variant scores ≥ 7, the run is logged and skipped.

## Database Schema (Supabase)

```sql
create table posts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  topic text not null,
  research_summary text,
  draft_variants jsonb,        -- array of {text, score, reasoning}
  selected_variant text,
  posted boolean default false,
  posted_at timestamptz,
  tweet_id text,
  status text                  -- 'queued', 'posted', 'rejected', 'failed'
);

create table topics (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  priority int default 5,      -- 1-10
  last_used_at timestamptz,
  active boolean default true
);
```

## Approval Modes
- **`auto`** — Cron runs end-to-end, posts directly. Use only after voice is dialed in.
- **`manual`** — Cron drafts and queues. Review via dashboard or notification, then call `/api/manual/approve` to post.

Start in `manual` for the first 2 weeks. Switch to `auto` only after consistent quality.

## Cron Schedule
Configured in `vercel.json`. Default: 2x/day at 9am and 3pm Phoenix time (16:00 and 22:00 UTC).
```json
{
  "crons": [
    { "path": "/api/cron/post-tweet", "schedule": "0 16,22 * * *" }
  ]
}
```

## Rate Limits & Safety
- X API free tier: 17 posts/day. Stay well under (max 4/day).
- Claude API: handle 429s with exponential backoff (1s, 2s, 4s, 8s).
- Never post the same topic twice within 7 days — check `posts` table before drafting.
- Kill switch: `PAUSE_POSTING=true` short-circuits the cron immediately.

## Coding Conventions
- TypeScript strict mode on.
- All API routes return `{ ok: boolean, data?, error? }` shape.
- Log every Claude call with token usage to Supabase `api_logs` table.
- No secrets in client code — all Claude/Twitter calls happen server-side only.
- Use `zod` to validate Claude's structured outputs before trusting them.

## Constraints
- Don't auto-post replies or DMs. Original posts only.
- Don't engage with trending political topics unless explicitly in scope.
- Don't let Claude pick the niche — niche is fixed in `topics.ts`.
- Don't post during major news events without manual review (configurable circuit breaker).

## Open Questions
1. What's the niche/topic area for this account?
2. Voice reference — link 5–10 example tweets that nail the tone.
3. Approval flow — Slack notification, email, or small web dashboard?
4. Account handle and X API access tier (free vs basic $100/mo)?
