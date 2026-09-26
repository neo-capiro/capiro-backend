import type { Request } from 'express';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A correlation token only: never use this untrusted header for authorization. */
export function meriDelegatedRequestId(req: Pick<Request, 'headers'>): string | null {
  const value = req.headers['x-meri-delegated-request-id'];
  return typeof value === 'string' && UUID.test(value) ? value : null;
}
