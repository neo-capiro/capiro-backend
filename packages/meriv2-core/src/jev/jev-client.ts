import { z } from 'zod';
import type { JevQuestion } from './decision-contract';

const MAX_REQUEST_BYTES = 64_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_RETRY_DELAY_MS = 30_000;
/** The TypeSafe HTTP contract retries rate limiting and overload only. */
const RETRYABLE_STATUS = new Set([429, 529]);

export interface JevSystemOneRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
}

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevNoulAnswer {
  type: 'noul';
  /** Probability that the answer is yes. */
  noul: number;
}

export interface JevScoreAnswer {
  type: 'score';
  /** One of the question's declared `levels` keys. */
  level: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

export interface JevSystemOneResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface JevClientResult {
  response: JevSystemOneResponse;
  latencyMs: number;
  attempts: number;
}

export type JevFetch = typeof globalThis.fetch;

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  fetchImpl?: JevFetch;
  /**
   * Replaces the built-in timer for the 429/529 backoff wait (tests). The wait is
   * still refused when it cannot fit before `deadlineAt` and raced against `signal`.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface JevCallOptions {
  signal?: AbortSignal;
  /** Absolute time (same clock as `now`) after which no attempt or backoff may run. */
  deadlineAt?: number;
  /** Hard per-call attempt ceiling; it can only reduce the client's configured maximum. */
  maxAttempts?: number;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class JevAuthError extends JevError {
  constructor() {
    super('Jev authentication failed', 'auth_failed', 401);
  }
}
export class JevRequestError extends JevError {
  constructor(message = 'Jev rejected the request') {
    super(message, 'request_rejected', 422);
  }
}
export class JevRateLimitError extends JevError {
  constructor() {
    super('Jev rate limit exceeded', 'rate_limited', 429);
  }
}
export class JevOverloadedError extends JevError {
  constructor() {
    super('Jev service overloaded', 'overloaded', 529);
  }
}
export class JevTimeoutError extends JevError {
  constructor() {
    super('Jev request timed out', 'timeout');
  }
}
export class JevCancelledError extends JevError {
  constructor() {
    super('Jev request cancelled', 'cancelled');
  }
}
export class JevMalformedResponseError extends JevError {
  constructor(message = 'Jev returned a malformed response') {
    super(message, 'malformed_response');
  }
}
export class JevScopeError extends JevError {
  constructor() {
    super('Jev request is outside the configured scope', 'scope_refused');
  }
}

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

function validateResponse(
  value: unknown,
  questions: Record<string, JevQuestion>,
  model: string,
): JevSystemOneResponse {
  const root = z
    .object({ model: z.literal(model), answers: z.record(z.unknown()), usage: usageSchema })
    .safeParse(value);
  if (!root.success) throw new JevMalformedResponseError();
  const questionIds = Object.keys(questions).sort();
  if (JSON.stringify(Object.keys(root.data.answers).sort()) !== JSON.stringify(questionIds)) {
    throw new JevMalformedResponseError();
  }
  const answers: Record<string, JevAnswer> = {};
  for (const id of questionIds) {
    const question = questions[id];
    if (!question) throw new JevMalformedResponseError();
    if (question.type === 'noul') {
      const parsed = z.object({
        type: z.literal('noul'),
        noul: z.number().finite().min(0).max(1),
      }).safeParse(root.data.answers[id]);
      if (!parsed.success) throw new JevMalformedResponseError();
      answers[id] = parsed.data;
      continue;
    }
    if (question.type === 'score') {
      const levels = Object.keys(question.levels).sort();
      const parsed = z
        .object({
          type: z.literal('score'),
          level: z.string(),
          probabilities: z.record(z.number().finite().min(0).max(1)),
          confidence: z.number().finite().min(0).max(1),
        })
        .safeParse(root.data.answers[id]);
      if (!parsed.success || !levels.includes(parsed.data.level)) {
        throw new JevMalformedResponseError();
      }
      const levelKeys = Object.keys(parsed.data.probabilities).sort();
      const levelSum = Object.values(parsed.data.probabilities).reduce((total, value) => total + value, 0);
      if (JSON.stringify(levelKeys) !== JSON.stringify(levels) || Math.abs(levelSum - 1) > 0.02) {
        throw new JevMalformedResponseError();
      }
      answers[id] = parsed.data;
      continue;
    }
    const criteria = Object.keys(question.criteria).sort();
    const parsed = z
      .object({
        type: z.literal('choice'),
        choice: z.string(),
        probabilities: z.record(z.number().finite().min(0).max(1)),
        confidence: z.number().finite().min(0).max(1),
      })
      .safeParse(root.data.answers[id]);
    if (!parsed.success || !criteria.includes(parsed.data.choice)) {
      throw new JevMalformedResponseError();
    }
    const probabilityKeys = Object.keys(parsed.data.probabilities).sort();
    const sum = Object.values(parsed.data.probabilities).reduce((total, value) => total + value, 0);
    if (JSON.stringify(probabilityKeys) !== JSON.stringify(criteria) || Math.abs(sum - 1) > 0.02) {
      throw new JevMalformedResponseError();
    }
    answers[id] = parsed.data;
  }
  return { model: root.data.model, answers, usage: root.data.usage };
}

function retryAfterMs(response: Response, attempt: number, now: number): number {
  const rawMilliseconds = response.headers.get('retry-after-ms');
  const milliseconds = Number(rawMilliseconds);
  if (rawMilliseconds != null && rawMilliseconds.trim() !== '' && Number.isFinite(milliseconds) && milliseconds >= 0) {
    return Math.min(milliseconds, MAX_RETRY_DELAY_MS);
  }
  const raw = response.headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
    }
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - now), MAX_RETRY_DELAY_MS);
  }
  return Math.min(500 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

/**
 * Wait `ms` before a retry, rejecting with JevCancelledError the moment `signal`
 * aborts. The built-in timer is cleared on abort so nothing keeps the process or a
 * turn alive; an injected `sleep` keeps its single-argument contract and is raced.
 */
function waitForRetry(
  ms: number,
  signal: AbortSignal | undefined,
  sleep: ((ms: number) => Promise<void>) | undefined,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new JevCancelledError());
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new JevCancelledError());
    };
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (sleep) {
      sleep(ms).then(done, (error: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
    } else {
      timer = setTimeout(done, ms);
    }
  });
}

async function responseText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new JevMalformedResponseError('Jev response exceeds the byte limit');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function httpError(status: number): JevError {
  if (status === 401) return new JevAuthError();
  if (status === 422) return new JevRequestError();
  if (status === 429) return new JevRateLimitError();
  if (status === 529) return new JevOverloadedError();
  return new JevError(`Jev HTTP request failed with status ${status}`, 'http_error', status);
}

export function createJevClient(options: JevClientOptions): {
  systemOne(request: JevSystemOneRequest, callOptions?: JevCallOptions): Promise<JevClientResult>;
} {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const baseUrl = (options.baseUrl ?? 'https://api.typesafe.ai').replace(/\/$/, '');
  if (!/^https:\/\/[^/]+$/i.test(baseUrl)) throw new JevRequestError('Jev base URL must be an HTTPS origin');
  if (!options.apiKey.trim()) throw new JevAuthError();

  return {
    async systemOne(request, callOptions = {}) {
      const startedAt = now();
      const body = JSON.stringify({ ...request, model: options.model });
      if (body.includes(options.apiKey)) {
        throw new JevRequestError('Refusing to send a Jev request body containing the API key');
      }
      if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
        throw new JevRequestError('Jev request exceeds the byte limit');
      }
      if (callOptions.maxAttempts !== undefined
        && (!Number.isInteger(callOptions.maxAttempts) || callOptions.maxAttempts < 1)) {
        throw new JevRequestError('Jev call maxAttempts must be a positive integer');
      }
      const maxAttempts = Math.min(options.maxAttempts, callOptions.maxAttempts ?? options.maxAttempts);
      const remainingMs = () => (callOptions.deadlineAt == null ? Infinity : callOptions.deadlineAt - now());
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (callOptions.signal?.aborted) throw new JevCancelledError();
        const remaining = remainingMs();
        if (remaining <= 0) throw new JevTimeoutError();
        const controller = new AbortController();
        const cancel = () => controller.abort(callOptions.signal?.reason);
        callOptions.signal?.addEventListener('abort', cancel, { once: true });
        const timeout = setTimeout(() => controller.abort(), Math.min(options.timeoutMs, remaining));
        let retry: { status: number; delayMs: number };
        try {
          const response = await fetchImpl(`${baseUrl}/v1/systemone`, {
            method: 'POST',
            redirect: 'error',
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body,
            signal: controller.signal,
          });
          const text = await responseText(response);
          if (response.ok) {
            if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
              throw new JevMalformedResponseError();
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              throw new JevMalformedResponseError();
            }
            return {
              response: validateResponse(parsed, request.questions, options.model),
              latencyMs: Math.max(0, now() - startedAt),
              attempts: attempt,
            };
          }
          if (!RETRYABLE_STATUS.has(response.status) || attempt >= maxAttempts) {
            throw httpError(response.status);
          }
          retry = { status: response.status, delayMs: retryAfterMs(response, attempt, now()) };
        } catch (error) {
          if (error instanceof JevError) throw error;
          if (callOptions.signal?.aborted) throw new JevCancelledError();
          if (controller.signal.aborted) throw new JevTimeoutError();
          // Transport failures are not retried: the contract retries 429/529 only, and a
          // POST that failed after its bytes left may already have been processed and
          // billed. The caller's fallback owns this case.
          throw new JevError('Jev network request failed', 'network_error');
        } finally {
          clearTimeout(timeout);
          callOptions.signal?.removeEventListener('abort', cancel);
        }
        // Only a retryable 429/529 reaches this point. The backoff has to fit inside the
        // caller's deadline: a retry that could not even start before it is refused now,
        // with the rate-limit/overload error, instead of sleeping the turn's budget away.
        const budget = remainingMs();
        if (budget <= 0) throw new JevTimeoutError();
        if (retry.delayMs >= budget) throw httpError(retry.status);
        await waitForRetry(retry.delayMs, callOptions.signal, options.sleepImpl);
      }
      throw new JevError('Jev request failed', 'network_error');
    },
  };
}

export type JevClient = ReturnType<typeof createJevClient>;
