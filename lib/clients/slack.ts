import crypto from 'crypto';
import { URLSearchParams } from 'url';
import type { PostRow, SlackAction } from '../../types/index.js';
import { SlackActionSchema } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWebhookUrl(): string {
  const url = process.env['SLACK_WEBHOOK_URL'];
  if (!url) throw new Error('Missing env var: SLACK_WEBHOOK_URL');
  return url;
}

function getSigningSecret(): string {
  const secret = process.env['SLACK_SIGNING_SECRET'];
  if (!secret) throw new Error('Missing env var: SLACK_SIGNING_SECRET');
  return secret;
}

function getBotToken(): string | undefined {
  return process.env['SLACK_BOT_TOKEN'];
}

function getChannel(): string {
  return process.env['SLACK_CHANNEL'] ?? '#general';
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const val = headers[key] ?? headers[key.toLowerCase()];
  if (Array.isArray(val)) return val[0];
  return val;
}

// ---------------------------------------------------------------------------
// postDraftToSlack
// ---------------------------------------------------------------------------

export async function postDraftToSlack(
  post: PostRow,
  scoresSummary: {
    overall: number;
    chars: number;
    bulletCount: number;
    bulletScores: number[];
  },
): Promise<{ message_ts: string }> {
  const { overall, chars, bulletCount, bulletScores } = scoresSummary;

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🟦 Draft ready — today in ai',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`\`\`\n${post.selected_variant ?? '(no text)'}\n\`\`\``,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Overall: ${overall}/10 · ${chars} chars · ${bulletCount} bullets · Bullets: ${bulletScores.join(' · ')}`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve', emoji: false },
          style: 'primary',
          action_id: 'approve',
          value: post.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject', emoji: false },
          style: 'danger',
          action_id: 'reject',
          value: post.id,
        },
      ],
    },
  ];

  const botToken = getBotToken();

  if (botToken) {
    // Use Web API so we get message_ts back
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel: getChannel(), blocks }),
    });

    const json = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    if (!json.ok) {
      throw new Error(`Slack chat.postMessage failed: ${json.error ?? 'unknown error'}`);
    }
    return { message_ts: json.ts ?? 'unknown' };
  }

  // Fallback: incoming webhook (no message_ts available)
  const webhookUrl = getWebhookUrl();
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook failed (${res.status}): ${body}`);
  }

  return { message_ts: 'webhook-fallback' };
}

// ---------------------------------------------------------------------------
// updateSlackMessage
// ---------------------------------------------------------------------------

export async function updateSlackMessage(
  messageTs: string,
  newText: string,
): Promise<void> {
  const botToken = getBotToken();

  if (botToken && messageTs !== 'webhook-fallback') {
    const res = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: getChannel(),
        ts: messageTs,
        text: newText,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: newText },
          },
        ],
      }),
    });

    const json = (await res.json()) as { ok: boolean; error?: string };
    if (!json.ok) {
      throw new Error(`Slack chat.update failed: ${json.error ?? 'unknown error'}`);
    }
    return;
  }

  // Fallback: post a follow-up webhook message
  const webhookUrl = getWebhookUrl();
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: newText }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook follow-up failed (${res.status}): ${body}`);
  }
}

// ---------------------------------------------------------------------------
// verifySlackSignature
// ---------------------------------------------------------------------------

export function verifySlackSignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
): boolean {
  try {
    const signingSecret = getSigningSecret();
    const signature = headerValue(headers, 'x-slack-signature');
    const timestampStr = headerValue(headers, 'x-slack-request-timestamp');

    if (!signature || !timestampStr) return false;

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) return false;

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - timestamp) > 300) return false;

    const sigBase = `v0:${timestamp}:${rawBody}`;
    const hmac = crypto.createHmac('sha256', signingSecret);
    hmac.update(sigBase);
    const computed = `v0=${hmac.digest('hex')}`;

    const computedBuf = Buffer.from(computed, 'utf8');
    const providedBuf = Buffer.from(signature, 'utf8');

    if (computedBuf.length !== providedBuf.length) return false;

    return crypto.timingSafeEqual(computedBuf, providedBuf);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// parseSlackActionPayload
// ---------------------------------------------------------------------------

export function parseSlackActionPayload(rawBody: string): SlackAction | null {
  try {
    const params = new URLSearchParams(rawBody);
    const payloadStr = params.get('payload');
    if (!payloadStr) return null;

    const payload = JSON.parse(payloadStr) as {
      actions?: Array<{ action_id?: string; value?: string }>;
      user?: { id?: string };
      message?: { ts?: string };
      response_url?: string;
    };

    const action = payload.actions?.[0];
    if (!action) return null;

    const raw = {
      action: action.action_id,
      post_id: action.value,
      user_id: payload.user?.id,
      message_ts: payload.message?.ts,
      response_url: payload.response_url,
    };

    const result = SlackActionSchema.safeParse(raw);
    if (!result.success) return null;

    return result.data;
  } catch {
    return null;
  }
}
