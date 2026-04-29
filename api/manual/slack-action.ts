import { waitUntil } from '@vercel/functions';
import { getPostById, updatePostStatus } from '../../lib/clients/neon.js';
import {
  verifySlackSignature,
  parseSlackActionPayload,
  updateSlackMessage,
} from '../../lib/clients/slack.js';
import { tweet } from '../../lib/clients/twitter.js';
import { validateDraft } from '../../lib/utils/validate.js';
import { log } from '../../lib/utils/logger.js';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('method-not-allowed', { status: 405 });

  const rawBody = await req.text();
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of req.headers.entries()) headers[k] = v;

  if (!verifySlackSignature(headers, rawBody)) {
    log('warn', 'slack signature verification failed');
    return new Response('unauthorized', { status: 401 });
  }

  const action = parseSlackActionPayload(rawBody);
  if (!action) return new Response('bad-payload', { status: 400 });

  waitUntil(
    (async () => {
      try {
        const post = await getPostById(action.post_id);
        if (!post) {
          log('warn', 'slack action references missing post', { post_id: action.post_id });
          return;
        }
        if (post.status !== 'queued') {
          log('info', 'slack action on non-queued post, ignoring', {
            post_id: action.post_id,
            status: post.status,
          });
          return;
        }

        if (action.action === 'approve') {
          if (!post.selected_variant) {
            log('error', 'queued post missing selected_variant', { post_id: action.post_id });
            return;
          }
          const validation = validateDraft(post.selected_variant);
          if (!validation.valid) {
            await updatePostStatus(post.id, {
              status: 'rejected',
              reason: `revalidation-failed: ${validation.violations.join(', ')}`,
            });
            if (post.slack_message_ts) {
              await updateSlackMessage(
                post.slack_message_ts,
                `❌ Auto-rejected on approve: revalidation failed (${validation.violations.join(', ')})`,
              );
            }
            return;
          }
          try {
            const result = await tweet(post.selected_variant);
            await updatePostStatus(post.id, {
              status: 'posted',
              posted: true,
              posted_at: new Date(),
              tweet_id: result.tweet_id,
            });
            if (post.slack_message_ts) {
              await updateSlackMessage(post.slack_message_ts, `✅ Posted: ${result.url}`);
            }
          } catch (e) {
            await updatePostStatus(post.id, { status: 'failed', reason: String(e) });
            if (post.slack_message_ts) {
              await updateSlackMessage(post.slack_message_ts, `❌ Failed to post: ${String(e)}`);
            }
          }
          return;
        }

        if (action.action === 'reject') {
          await updatePostStatus(post.id, {
            status: 'rejected',
            reason: `slack-reject by user ${action.user_id}`,
          });
          if (post.slack_message_ts) {
            await updateSlackMessage(post.slack_message_ts, `❌ Rejected by <@${action.user_id}>`);
          }
        }
      } catch (e) {
        log('error', 'slack-action background work failed', { error: String(e) });
      }
    })(),
  );

  return new Response('', { status: 200 });
}
