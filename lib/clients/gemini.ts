import { z } from 'zod';
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  type GenerationConfig,
  type Tool,
} from '@google/generative-ai';
import type { AgentType } from '../../types/index.js';
import { recordApiLog } from '../utils/logger.js';

// =====================================================================
// Typed errors
// =====================================================================

export class GeminiQuotaExhaustedError extends Error {
  constructor(public readonly quotaType: 'RPM' | 'RPD') {
    super(`Gemini quota exhausted: ${quotaType}`);
    this.name = 'GeminiQuotaExhaustedError';
  }
}

export class GeminiValidationError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = 'GeminiValidationError';
  }
}

// =====================================================================
// Public interfaces
// =====================================================================

export interface GeminiCallOpts<T> {
  model?: string;
  system: string;
  user: string;
  jsonSchema?: z.ZodType<T>;
  enableGoogleSearch?: boolean;
  agentType: AgentType;
  postId?: string;
  temperature?: number;
}

export interface GeminiCallResult<T> {
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
// Pricing constants (Gemini 2.5 Flash, late 2025/2026)
// Prices in USD per 1 million tokens.
// =====================================================================

const PRICE_INPUT_PER_M = 0.075;
const PRICE_OUTPUT_PER_M = 0.30;
const PRICE_CACHED_INPUT_PER_M = 0.01875; // ~75% discount

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

function isRpmError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes('429') &&
    (msg.includes('rpm') || msg.includes('rate') || msg.includes('per minute'))
  );
}

function isRpdError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes('429') &&
    (msg.includes('rpd') || msg.includes('per day') || msg.includes('daily'))
  );
}

function is5xxError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return /\b5\d{2}\b/.test(msg);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================================================================
// Core call
// =====================================================================

export async function geminiCall<T = string>(
  opts: GeminiCallOpts<T>,
): Promise<GeminiCallResult<T>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Add it to your .env.local file.',
    );
  }

  const modelName = opts.model ?? 'gemini-2.5-flash';
  const temperature = opts.temperature ?? 0.7;

  const genAI = new GoogleGenerativeAI(apiKey);

  // Build system instruction — if JSON mode, append schema instruction
  let systemInstruction = opts.system;
  if (opts.jsonSchema) {
    const schemaDescription = JSON.stringify(
      zodToJsonSchema(opts.jsonSchema),
      null,
      2,
    );
    systemInstruction +=
      `\n\nRespond with strict JSON matching this schema exactly. No prose before or after the JSON object.\n${schemaDescription}`;
  }

  // Build generation config
  const generationConfig: GenerationConfig = {
    temperature,
    ...(opts.jsonSchema ? { responseMimeType: 'application/json' } : {}),
  };

  // Build tools
  const tools: Tool[] = [];
  if (opts.enableGoogleSearch) {
    tools.push({ googleSearch: {} } as Tool);
  }

  const safetySettings = [
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
  ];

  const modelInstance = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction,
    generationConfig,
    ...(tools.length > 0 ? { tools } : {}),
    safetySettings,
  });

  // Retry loop: RPM gets one internal retry after 7s; 5xx gets 3 attempts
  const maxAttempts = 3;
  const backoffs = [1000, 2000, 4000];

  let lastError: unknown;
  let attemptedRpmRetry = false;
  const t0 = performance.now();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await modelInstance.generateContent(opts.user);
      const duration_ms = Math.round(performance.now() - t0);

      const response = result.response;
      const raw_text = response.text();

      // Token usage
      const usageMeta = response.usageMetadata;
      const input_tokens = usageMeta?.promptTokenCount ?? 0;
      const output_tokens = usageMeta?.candidatesTokenCount ?? 0;
      // Gemini SDK doesn't expose cached tokens directly yet — default 0
      const cached_input_tokens = 0;
      const cost_usd = computeCost(input_tokens, cached_input_tokens, output_tokens);

      const usage = { input_tokens, cached_input_tokens, output_tokens, cost_usd };

      // Parse and validate
      let data: T;
      if (opts.jsonSchema) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw_text);
        } catch {
          throw new GeminiValidationError(
            `Gemini returned invalid JSON: ${raw_text.slice(0, 200)}`,
            raw_text,
          );
        }
        const validated = opts.jsonSchema.safeParse(parsed);
        if (!validated.success) {
          throw new GeminiValidationError(
            `Gemini JSON failed schema validation: ${validated.error.message}`,
            raw_text,
          );
        }
        data = validated.data;
      } else {
        data = raw_text as unknown as T;
      }

      // Log (fire-and-forget, never throws)
      try {
        await recordApiLog({
          provider: 'gemini',
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

      // RPD exhaustion — no retry, throw immediately
      if (isRpdError(err)) {
        const quotaErr = new GeminiQuotaExhaustedError('RPD');
        try {
          await recordApiLog({
            provider: 'gemini',
            model: modelName,
            agent_type: opts.agentType,
            post_id: opts.postId ?? null,
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
            duration_ms: Math.round(performance.now() - t0),
            error: quotaErr.message,
          });
        } catch {}
        throw quotaErr;
      }

      // RPM — wait 7s and retry once (only once total)
      if (isRpmError(err) && !attemptedRpmRetry) {
        attemptedRpmRetry = true;
        await sleep(7000);
        attempt--; // don't count this against the 5xx attempt budget
        continue;
      }

      // 5xx — exponential backoff, up to 3 attempts
      if (is5xxError(err) && attempt < maxAttempts - 1) {
        await sleep(backoffs[attempt] ?? 4000);
        continue;
      }

      // Validation errors or schema errors — throw immediately
      if (err instanceof GeminiValidationError) {
        try {
          await recordApiLog({
            provider: 'gemini',
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

      // Other errors — don't retry
      break;
    }
  }

  // Log the final failure
  const finalErr = lastError instanceof Error ? lastError : new Error(String(lastError));
  try {
    await recordApiLog({
      provider: 'gemini',
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
// Minimal zod → JSON Schema converter (enough for Gemini's schema hint)
// =====================================================================

function zodToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  // Use zod's _def to extract a rough JSON schema for prompt injection.
  // This is intentionally simple — just enough for the LLM to understand the shape.
  // zod's internal `_def` shape varies by node type; we cast through `unknown` to
  // a permissive shape since the public TS types don't expose all variant fields.
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
