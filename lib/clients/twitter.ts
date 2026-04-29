import { TwitterApi, ApiResponseError } from 'twitter-api-v2';
import { randomUUID } from 'crypto';

export class TwitterAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwitterAuthError';
  }
}

export class TwitterDuplicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwitterDuplicateError';
  }
}

function getClient(): TwitterApi {
  const apiKey = process.env['TWITTER_API_KEY'];
  const apiSecret = process.env['TWITTER_API_SECRET'];
  const accessToken = process.env['TWITTER_ACCESS_TOKEN'];
  const accessSecret = process.env['TWITTER_ACCESS_SECRET'];

  if (!apiKey) throw new Error('Missing env var: TWITTER_API_KEY');
  if (!apiSecret) throw new Error('Missing env var: TWITTER_API_SECRET');
  if (!accessToken) throw new Error('Missing env var: TWITTER_ACCESS_TOKEN');
  if (!accessSecret) throw new Error('Missing env var: TWITTER_ACCESS_SECRET');

  return new TwitterApi({
    appKey: apiKey,
    appSecret: apiSecret,
    accessToken,
    accessSecret,
  });
}

export async function tweet(text: string): Promise<{ tweet_id: string; url: string }> {
  if (text.length > 280) {
    throw new Error(`Tweet text exceeds 280 characters (got ${text.length})`);
  }

  // Dry-run mode — skip real API call
  if (process.env['DRY_RUN'] === 'true') {
    const fakeId = randomUUID();
    console.log('[twitter] DRY_RUN — skipping real post. Text:', text);
    return {
      tweet_id: `dry-run-${fakeId}`,
      url: 'https://example.com/dry-run',
    };
  }

  const client = getClient();

  try {
    const response = await client.v2.tweet(text);
    const tweetId = response.data.id;
    return {
      tweet_id: tweetId,
      url: `https://x.com/i/web/status/${tweetId}`,
    };
  } catch (err) {
    if (err instanceof ApiResponseError) {
      if (err.code === 401) {
        throw new TwitterAuthError(
          'Twitter API returned 401 Unauthorized — check credentials and consider setting PAUSE_POSTING=true',
        );
      }

      if (err.code === 403) {
        // Duplicate content error code from Twitter API
        const twitterCode = err.data?.detail ?? err.message ?? '';
        const errorList = (err.data?.errors ?? []) as Array<{ code?: number }>;
        const isDuplicate =
          String(twitterCode).toLowerCase().includes('duplicate') ||
          errorList.some((e) => e.code === 187); // Twitter duplicate status code
        if (isDuplicate) {
          throw new TwitterDuplicateError(
            'Twitter rejected the tweet as duplicate content',
          );
        }
        throw new Error(`Twitter API returned 403 Forbidden: ${twitterCode}`);
      }

      if (err.code === 429) {
        throw new Error(
          'Twitter API rate limit hit (429). Back off and retry after the reset window.',
        );
      }
    }
    throw err;
  }
}
