import type { Request } from 'express';
import { GatewayTimeoutException } from '@nestjs/common';

// Aggregate identity acquisition cap, including both verified document reads.
// The Portfolio identity proxy allows 250s so this 504 can reach the browser.
export const PROFILE_IDENTITY_PREVIEW_TIMEOUT_MS = 240_000;

/** Match the existing Meri HTTP disconnect policy for bounded stateless previews. */
export async function withProfilePreviewAbort<T>(
  request: Request,
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const controller = new AbortController(),
    response = request.res;
  const abort = () => controller.abort(new DOMException('Client disconnected', 'AbortError'));
  const close = () => {
    if (!response?.writableEnded) abort();
  };
  request.once('aborted', abort);
  response?.once('close', close);
  response?.once('error', abort);
  if (request.aborted || response?.destroyed) abort();
  let rejectAbort: (() => void) | undefined;
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(
            new GatewayTimeoutException('The company identity preview timed out. Please retry.'),
          );
        }, timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    // A disconnected or expired request must settle even when a source ignores
    // cancellation. Source owners still check the signal before subsequent work.
    return await Promise.race([work(controller.signal), cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    request.removeListener('aborted', abort);
    response?.removeListener('close', close);
    response?.removeListener('error', abort);
  }
}
