import type { Request } from 'express';

/** Match the existing Meri HTTP disconnect policy for bounded stateless previews. */
export async function withProfilePreviewAbort<T>(
  request: Request,
  work: (signal: AbortSignal) => Promise<T>,
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
  try {
    return await work(controller.signal);
  } finally {
    request.removeListener('aborted', abort);
    response?.removeListener('close', close);
    response?.removeListener('error', abort);
  }
}
