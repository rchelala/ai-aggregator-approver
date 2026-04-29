import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentType } from '../../types/index.js';
import { recordApiLog } from '../utils/logger.js';

// =====================================================================
// Typed errors
// =====================================================================

export class AnthropicValidationError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = 'AnthropicValidationError';
  }
}

// =====================================================================
// Public interfaces
// =====================================================================

export interface AnthropicCallOpts<T> {
  model?: string;
  system: string;
  user: string;
  jsonSchema?: z.ZodType<T>;
  agentType: AgentType;
  postId?: string;
  useCache?: boolean;
  maxTokens?: number;
}

export interface AnthropicCallResult<T> {
  data: T;
  raw_text: string;
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
  duration_ms: number;
}

// =====================================================================
// Pricing constants (Haiku 4.5, approximate late 2025/2026)
// Prices in USD per 1 million tokens.
// =====================================================================

const PRICE_INPUT_PER_M = 1.0;
const PRICE_OUTPUT_PER_M = 5.0;
const PRICE_CACHED_INPUT_PER_M = 0.1;

// =====================================================================
// Helpers
// =====================================================================

function computeCost(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  const billableInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (billableInput / 1_000_000) * PRICE_INPUT_PER_M +
    (cachedInputTokens / 1_000_000) * PRICE_CACHED_INPUT_PER_M +
    (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M
  );
}

function is429(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) return err.status === 429;
  return String(err instanceof Error ? err.message : err).includes('429');
}

function is5xx(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) return (err.status ?? 0) >= 500;
  return /\b5\d{2}\b/.test(String(err instanceof Error ? err.message : err));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================================================================
// Core call
// =====================================================================

export async function anthropicCall<T = string>(
  opts: AnthropicCallOpts<T>,
): Promise<AnthropicCallResult<T>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to your .env.local file.',
    );
  }

  const modelName = opts.model ?? 'claude-haiku-4-5-20251001';
  const maxTokens = opts.maxTokens ?? 2048;
  const useCache = opts.useCache !== false; // default true

  const client = new Anthropic({ apiKey });

  // Build system content — optionally with cache control
  let systemText = opts.system;
  if (opts.jsonSchema) {
    const schemaStr = JSON.stringify(zodToJsonSchema(opts.jsonSchema), null, 2);
    systemText +=
      `\n\nRespond with valid JSON matching this exact shape. No prose before or after the JSON object.\n${schemaStr}`;
  }

  type SystemParam = Anthropic.TextBlockParam & {
    cache_control?: { type: 'ephemeral' };
  };

  const systemParam: SystemParam = useCache
    ? { type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }
    : { type: 'text', text: systemText };

  const maxAttempts = 4;
  const backoffs = [1000, 2000, 4000, 8000];

  let lastError: unknown;
  const t0 = performance.now();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await client.messages.create({
        model: modelName,
        max_tokens: maxTokens,
        system: [systemParam],
        messages: [{ role: 'user', content: opts.user }],
      });

      const duration_ms = Math.round(performance.now() - t0);

      // Extract text
      const textBlock = response.content.find((b) => b.type === 'text');
      const raw_text = textBlock?.type === 'text' ? textBlock.text : '';

      // Token usage
      const input_tokens = response.usage.input_tokens;
      const output_tokens = response.usage.output_tokens;
      const cached_input_tokens =
        (response.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0;
      const cost_usd = computeCost(input_tokens, cached_input_tokens, output_tokens);

      const usage = { input_tokens, cached_input_tokens, output_tokens, cost_usd };

      // Parse and validate
      let data: T;
      if (opts.jsonSchema) {
        let parsed: unknown;
        try {
          // Strip any accidental markdown fences
          const cleaned = raw_text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
          parsed = JSON.parse(cleaned);
        } catch {
          throw new AnthropicValidationError(
            `Anthropic returned invalid JSON: ${raw_text.slice(0, 200)}`,
            raw_text,
          );
        }
        const validated = opts.jsonSchema.safeParse(parsed);
        if (!validated.success) {
          throw new AnthropicValidationError(
            `Anthropic JSON failed schema validation: ${validated.error.message}`,
            raw_text,
          );
        }
        data = validated.data;
      } else {
        data = raw_text as unknown as T;
      }

      // Log (fire-and-forget)
      try {
        await recordApiLog({
          provider: 'anthropic',
          model: modelName,
          agent_type: opts.agentType,
          post_id: opts.postId ?? null,
          input_tokens,
          cached_input_tokens,
          output_tokens,
          cost_usd,
          duration_ms,
          error: null,
        });
      } catch {}

      return { data, raw_text, usage, duration_ms };
    } catch (err) {
      lastError = err;

      // Validation errors — don't retry
      if (err instanceof AnthropicValidationError) {
        try {
          await recordApiLog({
            provider: 'anthropic',
            model: modelName,
            agent_type: opts.agentType,
            post_id: opts.postId ?? null,
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
            duration_ms: Math.round(performance.now() - t0),
            error: err.message,
          });
        } catch {}
        throw err;
      }

      // 429 or 5xx — backoff and retry
      if ((is429(err) || is5xx(err)) && attempt < maxAttempts - 1) {
        await sleep(backoffs[attempt] ?? 8000);
        continue;
      }

      // Other errors — throw immediately
      break;
    }
  }

  // Log final failure
  const finalErr = lastError instanceof Error ? lastError : new Error(String(lastError));
  try {
    await recordApiLog({
      provider: 'anthropic',
      model: modelName,
      agent_type: opts.agentType,
      post_id: opts.postId ?? null,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      duration_ms: Math.round(performance.now() - t0),
      error: finalErr.message,
    });
  } catch {}

  throw finalErr;
}

// =====================================================================
// Minimal zod → JSON Schema converter (shared pattern with gemini.ts)
// =====================================================================

// zod's internal `_def` shape varies by node type. We read it dynamically here;
// runtime is fine but the public TS types don't expose all the variant fields, so
// we cast through `unknown` to a permissive shape.
type ZodDefAny = {
  typeName: string;
  shape?: () => Record<string, z.ZodTypeAny>;
  type?: z.ZodTypeAny;
  innerType?: z.ZodTypeAny;
  values?: readonly string[];
  value?: unknown;
  options?: z.ZodTypeAny[];
  optionsMap?: Map<unknown, z.ZodTypeAny>;
};

function zodToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const def = schema._def as unknown as ZodDefAny;

  if (def.typeName === 'ZodObject' && def.shape) {
    const shape = def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(val);
      const innerDef = val._def as unknown as ZodDefAny;
      if (innerDef.typeName !== 'ZodOptional') required.push(key);
    }
    return { type: 'object', properties, required };
  }
  if (def.typeName === 'ZodArray' && def.type) {
    return { type: 'array', items: zodToJsonSchema(def.type) };
  }
  if (def.typeName === 'ZodString') return { type: 'string' };
  if (def.typeName === 'ZodNumber') return { type: 'number' };
  if (def.typeName === 'ZodBoolean') return { type: 'boolean' };
  if (def.typeName === 'ZodOptional' && def.innerType) {
    return zodToJsonSchema(def.innerType);
  }
  if (def.typeName === 'ZodEnum' && def.values) {
    return { type: 'string', enum: [...def.values] };
  }
  if (def.typeName === 'ZodLiteral') return { const: def.value };
  if (def.typeName === 'ZodUnion' && def.options) {
    return { oneOf: def.options.map(zodToJsonSchema) };
  }
  if (def.typeName === 'ZodDiscriminatedUnion' && def.optionsMap) {
    return {
      oneOf: [...def.optionsMap.values()].map(zodToJsonSchema),
    };
  }
  return {};
}
