import { ok, err } from '../../types/index.js';
import type { DraftVariant } from '../../types/index.js';
import { runResearch, EmptyResearchError } from '../../lib/agents/research.js';
import { runDraft, DraftFailedError } from '../../lib/agents/draft.js';
import { runReview } from '../../lib/agents/review.js';
import {
  createPost,
  updatePostStatus,
  expireOldQueued,
  alreadyRanToday,
  getRecent7DaysPostedTexts,
} from '../../lib/clients/neon.js';
import { tweet, TwitterAuthError } from '../../lib/clients/twitter.js';
import { postDraftToSlack } from '../../lib/clients/slack.js';
import { GeminiQuotaExhaustedError } from '../../lib/clients/gemini.js';
import { validateDraft } from '../../lib/utils/validate.js';
import { isDuplicate } from '../../lib/utils/dedup.js';
import { log } from '../../lib/utils/logger.js';
import { checkDailyPostQuota } from '../../lib/utils/rate-limit.js';

export default async function handler(_req: Request): Promise<Response> {
  if (process.env.PAUSE_POSTING === 'true') {
    log('info', 'pipeline paused via PAUSE_POSTING env var');
    return Response.json(ok({ status: 'paused' }));
  }

  try {
    const expired = await expireOldQueued();
    if (expired > 0) log('info', `expired ${expired} stale queued posts`);
  } catch (e) {
    log('error', 'expiry sweep failed', { error: String(e) });
  }

  if (await alreadyRanToday()) {
    log('info', 'today already ran, skipping');
    return Response.json(ok({ status: 'already_ran' }));
  }

  const quota = await checkDailyPostQuota();
  if (!quota.ok) {
    log('warn', 'daily post quota exceeded', quota);
    return Response.json(ok({ status: 'quota_exceeded', quota }));
  }

  try {
    const research = await runResearch();
    log('info', 'research complete', { item_count: research.items.length });

    const recentTexts = await getRecent7DaysPostedTexts();
    const draft = await runDraft(research, recentTexts);
    log('info', 'draft complete', { variant_count: draft.variants.length });

    const survivingVariants: DraftVariant[] = [];
    for (const v of draft.variants) {
      const validation = validateDraft(v.rendered_text);
      if (!validation.valid) {
        log('warn', 'variant failed validate.ts', { violations: validation.violations });
        continue;
      }
      const dedup = isDuplicate(v.rendered_text, recentTexts);
      if (dedup.duplicate) {
        log('warn', 'variant rejected as near-duplicate', { overlap: dedup.overlap });
        continue;
      }
      survivingVariants.push(v);
    }

    if (survivingVariants.length === 0) {
      log('info', 'all variants failed pre-filter, skipping day');
      return Response.json(ok({ status: 'all_variants_filtered' }));
    }

    const decision = await runReview({ variants: survivingVariants });
    log('info', 'review complete', { outcome: decision.outcome });

    const firstHeadline = research.items[0]?.headline ?? 'unknown';
    const researchSummary = JSON.stringify(research.items.map((i) => i.headline));

    if (decision.outcome === 'rejected') {
      const post = await createPost({
        topic: firstHeadline,
        research_summary: researchSummary,
        draft_variants: survivingVariants,
        selected_variant: null,
        bullet_breakdown: { reviews: decision.reviews },
        status: 'rejected',
        reason: decision.reason,
      });
      log('info', 'all variants below quality bar', {
        post_id: post.id,
        reason: decision.reason,
      });
      return Response.json(ok({ status: 'quality_below_bar', post_id: post.id }));
    }

    const winner = survivingVariants[decision.winner_index];
    if (!winner) {
      throw new Error(`review picked invalid winner_index ${decision.winner_index}`);
    }

    const post = await createPost({
      topic: firstHeadline,
      research_summary: researchSummary,
      draft_variants: survivingVariants,
      selected_variant: winner.rendered_text,
      bullet_breakdown: {
        winner_index: decision.winner_index,
        reviews: decision.reviews,
        bullets: winner.bullets,
      },
      status: 'queued',
    });
    log('info', 'draft queued', { post_id: post.id });

    const mode = process.env.APPROVAL_MODE === 'auto' ? 'auto' : 'manual';
    if (mode === 'auto') {
      const tweetResult = await tweet(winner.rendered_text);
      await updatePostStatus(post.id, {
        status: 'posted',
        posted: true,
        posted_at: new Date(),
        tweet_id: tweetResult.tweet_id,
      });
      log('info', 'auto-posted', {
        post_id: post.id,
        tweet_url: tweetResult.url,
      });
      return Response.json(
        ok({ status: 'posted', post_id: post.id, tweet_url: tweetResult.url }),
      );
    }

    const winnerReview = decision.reviews.find(
      (r) => r.variant_index === decision.winner_index,
    );
    const slackResult = await postDraftToSlack(post, {
      overall: winnerReview?.overall_score ?? 0,
      chars: winner.rendered_text.length,
      bulletCount: winner.bullets.length,
      bulletScores: winnerReview?.bullet_scores.map((b) => b.score) ?? [],
    });
    await updatePostStatus(post.id, { slack_message_ts: slackResult.message_ts });
    return Response.json(ok({ status: 'queued_for_approval', post_id: post.id }));
  } catch (e) {
    if (e instanceof TwitterAuthError) {
      log('error', 'twitter auth failed, pipeline should be paused', {
        error: String(e),
      });
      return Response.json(err('twitter_auth_failed_set_PAUSE_POSTING'), { status: 500 });
    }
    if (e instanceof GeminiQuotaExhaustedError) {
      log('warn', 'gemini RPD exhausted, skipping day', { error: String(e) });
      return Response.json(ok({ status: 'gemini_quota_exhausted' }));
    }
    if (e instanceof EmptyResearchError) {
      log('info', 'no research items found, skipping day');
      return Response.json(ok({ status: 'no_research_items' }));
    }
    if (e instanceof DraftFailedError) {
      log('warn', 'all drafts failed, skipping day', { error: String(e) });
      return Response.json(ok({ status: 'draft_failed' }));
    }
    log('error', 'pipeline error', {
      error: String(e),
      stack: e instanceof Error ? e.stack : undefined,
    });
    return Response.json(err(String(e)), { status: 500 });
  }
}
