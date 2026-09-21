const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface CongressHttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type CongressFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<CongressHttpResponse>;

export interface FetchCongressJsonOptions {
  fetchImpl?: CongressFetch;
  sleep?: (ms: number) => Promise<void>;
  createDeadlineSignal?: (timeoutMs: number) => AbortSignal;
  requestTimeoutMs?: number;
  maxRetries?: number;
  warn?: (message: string) => void;
}

export function congressRequestTimeoutMs(
  raw: string | undefined = process.env.CONGRESS_REQUEST_TIMEOUT_MS,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(Math.trunc(parsed), MAX_REQUEST_TIMEOUT_MS);
}

function redactKey(value: string): string {
  return value.replace(/(api_key=)[^&\s]+/gi, '$1[REDACTED]');
}

function errorMessage(error: unknown): string {
  return redactKey(error instanceof Error ? error.message : String(error));
}

function requestError(url: string, error: unknown): Error {
  return new Error(`GET ${redactKey(url)}: ${errorMessage(error)}`);
}

/**
 * Fetch one Congress.gov JSON payload with bounded attempts.
 *
 * The deadline remains active while the response body is read, and a failed or
 * truncated body is retried just like a connection failure. HTTP semantics are
 * intentionally the same as the original sync helper: 404 is an authoritative
 * absence, ordinary 4xx responses fail immediately, and 429/5xx responses use
 * Retry-After or exponential backoff.
 */
export async function fetchCongressJson<T>(
  url: string,
  options: FetchCongressJsonOptions = {},
): Promise<T | null> {
  const fetchImpl = options.fetchImpl ?? (fetch as CongressFetch);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const createDeadlineSignal =
    options.createDeadlineSignal ?? ((timeoutMs: number) => AbortSignal.timeout(timeoutMs));
  const requestTimeoutMs = options.requestTimeoutMs ?? congressRequestTimeoutMs();
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('Congress request timeout must be a positive number');
  }
  if (!Number.isInteger(maxRetries) || maxRetries <= 0) {
    throw new Error('Congress max retries must be a positive integer');
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let response: CongressHttpResponse;
    const signal = createDeadlineSignal(requestTimeoutMs);

    try {
      response = await fetchImpl(url, { signal });
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw requestError(url, error);
    }

    if (response.status === 404) return null;

    if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** (attempt - 1);
      warn(
        `[congress-sync] ${response.status} on ${redactKey(url)} — retry ${attempt}/${maxRetries} in ${waitMs}ms`,
      );
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `GET ${redactKey(url)}: ${response.status} ${redactKey(response.statusText)}`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw requestError(url, error);
    }
  }

  throw new Error(`GET ${redactKey(url)}: exhausted ${maxRetries} retries`);
}
