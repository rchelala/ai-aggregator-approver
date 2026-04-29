# Setup Walkthrough

End-to-end credential and infrastructure setup. Plan on ~60 minutes total. Twitter developer access is the only step that can take longer than that — it's a one-time approval process out of your control.

## 0. Prerequisites

- Node.js 20+ installed (check: `node -v`)
- A GitHub account (for Vercel signup)
- A working email for the various signups

## 1. Install local dependencies

```bash
cd "C:/Users/rober/OneDrive/Documents/Social Media Auto Post"
npm install
```

After install, verify TypeScript types compile cleanly:

```bash
npm run typecheck
```

Run unit tests:

```bash
npm run test
```

## 2. Gemini API key (free tier)

1. Go to <https://aistudio.google.com/app/apikey>
2. Sign in with a Google account
3. Click "Get API key" → "Create API key in new project" (or use an existing project)
4. Copy the key — it starts with `AIza...`
5. Save it to `.env.local`:
   ```
   GEMINI_API_KEY=AIza...
   ```

**Free tier limits:** 10 requests/minute, 250 requests/day. We use 2 requests/day, well under the cap.

**Privacy note:** Google's free Gemini tier reserves the right to use your prompts for model improvement. For this project (public AI news in, public Twitter posts out) that's fine, but worth knowing.

## 3. Anthropic API key

1. Go to <https://console.anthropic.com/>
2. Sign up / sign in
3. Settings → API Keys → Create Key
4. Copy the key (starts with `sk-ant-...`)
5. Add to `.env.local`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
6. **Add billing:** Settings → Billing → Add payment method. Anthropic gives new accounts $5 free credit which covers ~50 days at our spend (~$0.001/day for Haiku review only).

## 4. Neon Postgres

1. Go to <https://neon.tech>
2. Sign up with GitHub (fastest)
3. Create a new project — pick the region closest to your Vercel functions (typically "us-east-1" if you're posting from the US)
4. From the project dashboard, copy the **pooled connection string** (it ends with `?sslmode=require`)
5. Add to `.env.local`:
   ```
   DATABASE_URL=postgresql://...
   ```
6. Apply the schema:
   ```bash
   psql "$DATABASE_URL" -f db/migrations/0001_init.sql
   ```
   (If you don't have `psql` locally, you can paste the contents of `db/migrations/0001_init.sql` directly into Neon's SQL Editor in the web UI.)

**Free tier:** 0.5 GB storage, no time limit. This project uses kilobytes.

## 5. Twitter / X API credentials (the slow one)

1. Go to <https://developer.x.com/en/portal/dashboard>
2. Apply for a Developer Account if you don't have one. Approval can take hours to days.
3. Once approved: create a new App in the portal
4. Under the App settings:
   - **User authentication settings** → Set up: enable OAuth 1.0a, set "App permissions" to **Read and write** (you need write to post tweets)
   - Save the **API Key** and **API Key Secret** (these are the consumer keys)
   - Generate **Access Token** and **Access Token Secret** (these authorize posting on your behalf)
5. Add all four to `.env.local`:
   ```
   TWITTER_API_KEY=...
   TWITTER_API_SECRET=...
   TWITTER_ACCESS_TOKEN=...
   TWITTER_ACCESS_SECRET=...
   ```

**Free tier:** 17 posts/day, 100 reads/day. This project posts 1/day, well under the cap.

**Important:** if you ever rotate the access tokens (e.g. after a security review), your pipeline will start hitting `TwitterAuthError`. The orchestrator logs this and skips the day, but you'll need to update the env vars and the pipeline will recover on the next run.

## 6. Slack app (for approval pings)

1. Go to <https://api.slack.com/apps> → "Create New App" → "From scratch"
2. Name it (e.g. "AI Aggregator Approver"), pick the workspace you want notifications in
3. Sidebar → "Incoming Webhooks" → toggle on → "Add New Webhook to Workspace" → pick the channel you want drafts to ping → copy the webhook URL
4. Sidebar → "Interactivity & Shortcuts" → toggle Interactivity on → set Request URL to `https://<your-vercel-app>.vercel.app/api/manual/slack-action` (you'll fill this after step 7) → Save
5. Sidebar → "Basic Information" → scroll to "App Credentials" → copy the **Signing Secret**
6. (Optional but recommended) Sidebar → "OAuth & Permissions" → scroll to "Bot Token Scopes" → add `chat:write` → "Install App to Workspace" → copy the **Bot User OAuth Token** (starts with `xoxb-`). This lets the pipeline edit/update Slack messages instead of just posting follow-ups.
7. Add to `.env.local`:
   ```
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
   SLACK_SIGNING_SECRET=...
   SLACK_BOT_TOKEN=xoxb-...   # optional, enables in-place message updates
   ```

## 7. Deploy to Vercel

1. Go to <https://vercel.com> and sign in with GitHub
2. (One-time) Initialize git in this repo:
   ```bash
   git init
   git add .
   git commit -m "initial scaffold"
   ```
3. Push to a private GitHub repo, then import it on Vercel.
   Or use the Vercel CLI:
   ```bash
   npx vercel link
   npx vercel deploy
   ```
4. In the Vercel dashboard for this project: Settings → Environment Variables → add every var from your `.env.local` file. Set scope to "Production" and "Preview".
5. Set `APPROVAL_MODE=manual` (this is your default for the first 2 weeks).
6. Note your production URL (e.g. `https://ai-twitter-aggregator-yourname.vercel.app`).
7. Go back to Slack app interactivity settings (step 6.4) and update the Request URL to use this real Vercel URL.
8. Deploy:
   ```bash
   npx vercel --prod
   ```

The cron is configured in `vercel.json` to fire daily at 0000 UTC. After deploy, you can verify it's registered under "Crons" in the Vercel dashboard.

## 8. Verification ladder

Per the original plan, walk through these checks before letting the cron run unattended.

### Pre-deploy
- [x] `npm run typecheck` passes
- [x] `npm run test` — `validate.ts` rejects all 5+ deliberately-bad fixtures
- [ ] `npx vercel dev` boots; `curl http://localhost:3000/api/manual/draft-now` returns 2 variants + decision JSON. Inspect for: ≤280 chars, no em-dashes, no banned words, every bullet specific
- [ ] **5-day human grading:** run `draft-now` once a day for 5 days. Grade each variant 1–10 in a notes file. Target: ≥3 of 5 you'd actually post. If <3, tune `lib/config/voice.ts` and the prompt in `lib/agents/draft.ts` before going live

### Going live
- [ ] **DRY_RUN test:** set `DRY_RUN=true` in Vercel env. Trigger the cron manually:
  ```bash
  curl -X POST https://<your-vercel-url>/api/cron/post-tweet
  ```
  Verify Slack ping arrives, tap Approve, verify HMAC check passes (in Vercel function logs), verify no actual tweet was posted (DRY_RUN gate)
- [ ] **First handwritten live post:** unset `DRY_RUN`, manually insert a row in Neon with a digest you wrote yourself, hit `/api/manual/approve` with that id. Confirm the tweet appears on X with byte-equal text. This validates Twitter auth without involving the LLM pipeline
- [ ] **First fully-automated cron run:** wait for 0000 UTC (or trigger via the Vercel CLI). Full path: row created → Slack pings → tap Approve → tweet posts → metadata populated

### After live
- [ ] Cost check after 24h:
  ```bash
  curl https://<your-vercel-url>/api/internal/cost
  ```
  Expect ~$0.001/day (Haiku review only). >$0.10/day means a runaway prompt or a quota fallback misfiring
- [ ] Calibration phase (weeks 1–2): track in a notes file how many variants scoring ≥7 you still rejected manually. Tune until <20% rejection-of-passing-drafts. Then flip `APPROVAL_MODE=auto`
- [ ] Auto-mode runtime: hit `/api/internal/health` weekly for the first month. If skip rate >15% sustained, intervene

## 9. Troubleshooting

### "Pipeline paused" responses
You set `PAUSE_POSTING=true` somewhere. Vercel → Settings → Environment Variables → remove it.

### `TwitterAuthError` in logs
Tokens expired or were rotated. Generate new Access Token / Secret in the X developer portal (step 5.4) and update both env vars in Vercel.

### Gemini "RPD exhausted"
You burned through 250 requests in a day. The pipeline only uses 2/day, so this means something's looped. Check `/api/internal/cost` for an unusual spike, then check Vercel function logs for repeated invocations.

### Slack signature verification failing
Confirm `SLACK_SIGNING_SECRET` matches "Basic Information → Signing Secret" in the Slack app dashboard. If they match and it's still failing, check that Vercel hasn't truncated the header — the signing payload uses the raw request body, so any middleware mutation would break the HMAC.

### `validate.ts` rejecting drafts that look fine
Probably an em-dash you missed. Run `node -e "console.log(/—|–/.test(YOUR_TEXT))"` to spot-check. Em-dashes can sneak in from auto-correct on macOS or from copy-paste of formatted text.
