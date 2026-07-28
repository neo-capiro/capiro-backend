/*
 * Phase 5 §3.2 — bounded retry for transient draft-context loads. A small,
 * generic wrapper: up to 2 retries (3 attempts total) with exponential backoff
 * + small jitter, but ONLY for errors that look transient (network/timeout/
 * 5xx/pool). Validation, not-found, authorization, malformed-source, and
 * explicit-empty-data are final on attempt one — retrying them only delays an
 * answer that will not change. Never logs source content, only the source
 * NAME (a short correlation label the caller supplies) and the error's own
 * message.
 */
import { Logger } from '@nestjs/common';

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 200;
const MAX_JITTER_MS = 75;

const logger = new Logger('ContextLoad');

/**
 * True for errors worth retrying: Prisma pool/connection codes, abort/timeout,
 * common Node network error codes, or an HTTP 5xx status. Everything else
 * (validation errors, 4xx, not-found, malformed-source) is treated as final —
 * retrying a bad request just produces the same bad request three times.
 */
export function isTransientLoadError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; name?: unknown; message?: unknown; status?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : '';
  const status = typeof e.status === 'number' ? e.status : undefined;
  // Prisma: P1001 can't reach DB, P1008 op timeout, P1017 server closed the
  // connection, P2024 pool timeout, P2028 transaction API error.
  if (/^P(1001|1008|1017|2024|2028)$/.test(code)) return true;
  if (name === 'AbortError') return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up/i.test(message)) return true;
  if (/\btimed?\s?out\b|\btimeout\b/i.test(message)) return true;
  if (typeof status === 'number' && status >= 500) return true;
  return false;
}

function jitteredDelay(attempt: number): number {
  return BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * MAX_JITTER_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn`, retrying up to MAX_RETRIES additional times (3 attempts total)
 * ONLY when the thrown error is transient. A non-transient error, or the final
 * transient attempt, rethrows immediately — this helper never swallows a
 * failure; each caller keeps its own fail-soft/fail-hard policy on top of it.
 * `source` is a short correlation label ONLY ('firm-phases', 'steward-health')
 * — never the loaded content itself.
 */
export async function withContextRetry<T>(source: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const value = await fn();
      // Phase 6 §6 ("context-load retry count / source class"): the per-attempt
      // warnings above say a retry HAPPENED; without this line nothing says
      // whether it worked, so a source that is chronically flaky-but-recovering
      // is indistinguishable from one that never retries at all.
      if (attempt > 0) {
        logger.log(`${source}: recovered after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
      }
      return value;
    } catch (err) {
      if (!isTransientLoadError(err) || attempt >= MAX_RETRIES) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `${source}: transient load failure (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying — ${message}`,
      );
      await sleep(jitteredDelay(attempt));
    }
  }
}
