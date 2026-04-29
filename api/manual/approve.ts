import { ok, err } from '../../types/index.js';
import { getPostById, updatePostStatus } from '../../lib/clients/neon.js';
import {
  tweet,
  TwitterAuthError,
  TwitterDuplicateError,
} from '../../lib/clients/twitter.js';
import { updateSlackMessage } from '../../lib/clients/slack.js';
import { validateDraft } from '../../lib/utils/validate.js';
import { log } from '../../lib/utils/logger.js';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return Response.json(err('method-not-allowed'), { status: 405 });

  let id: string;
  try {
    const body = (await req.json()) as unknown;
    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as { id?: unknown }).id !== 'string'
    ) {
      throw new Error('id required');
    }
    id = (body as { id: string }).id;
  } catch {
    return Response.json(err('invalid-body'), { status: 400 });
  }

  const post = await getPostById(id);
  if (!post) return Response.json(err('not-found'), { status: 404 });
  if (post.status !== 'queued') {
    return Response.json(err(`post is ${post.status}, cannot approve`), { status: 409 });
  }
  if (!post.selected_variant) {
    return Response.json(err('no selected variant'), { status: 500 });
  }

  const validation = validateDraft(post.selected_variant);
  if (!validation.valid) {
    await updatePostStatus(id, {
      status: 'rejected',
      reason: `revalidation-failed: ${validation.violations.join(', ')}`,
    });
    return Response.json(
      err(`revalidation-failed: ${validation.violations.join(', ')}`),
      { status: 400 },
    );
  }

  try {
    const result = await tweet(post.selected_variant);
    await updatePostStatus(id, {
      status: 'posted',
      posted: true,
      posted_at: new Date(),
      tweet_id: result.tweet_id,
    });
    if (post.slack_message_ts) {
      try {
        await updateSlackMessage(post.slack_message_ts, `✅ Posted: ${result.url}`);
      } catch (e) {
        log('warn', 'slack message update failed', { error: String(e) });
      }
    }
    return Response.json(ok({ tweet_id: result.tweet_id, url: result.url }));
  } catch (e) {
    if (e instanceof TwitterDuplicateError) {
      await updatePostStatus(id, { status: 'failed', reason: 'duplicate-content' });
      return Response.json(err('duplicate-content'), { status: 400 });
    }
    if (e instanceof TwitterAuthError) {
      await updatePostStatus(id, { status: 'failed', reason: 'twitter-auth' });
      return Response.json(
        err('twitter-auth-failed-set-PAUSE_POSTING'),
        { status: 500 },
      );
    }
    await updatePostStatus(id, { status: 'failed', reason: String(e) });
    return Response.json(err(String(e)), { status: 500 });
  }
}
