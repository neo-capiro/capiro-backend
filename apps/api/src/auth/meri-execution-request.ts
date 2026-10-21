import { mountedRequestPath } from './mounted-request-path.js';
import type { Request } from 'express';
import { isMeriExecutionBearer } from './core-ed25519-key-config.js';

/**
 * The single Core route that accepts a Meri execution capability as its
 * bearer: Meri's executor posts the approved `task.create` command's tool body
 * to `create_task` with the capability and the verified service identity
 * (meri-greenfield 1cc5a554 `execution-composition.mjs`). Nothing else does;
 * any other path gets the ordinary Clerk verification and fails.
 */
export const MERI_EXECUTION_RECEIVER_PATH = '/clio/tools/create_task';

export interface MeriExecutionRequestIdentity {
  token: string;
  tenantId: string;
  actorId: string;
  jti: string;
  expMs: number;
}

const requests = new WeakMap<Request, MeriExecutionRequestIdentity>();

/** Exact path and method, parsed target equal to the original, and the
 * execution capability token type in the Bearer header. */
export function isMeriExecutionCapabilityPost(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const parsed = mountedRequestPath(req);
  const original = (req.originalUrl ?? req.url ?? '').split('?')[0];
  if (parsed !== original || (req.originalUrl ?? '').includes('?')) return false;
  if ((parsed.startsWith('/api/') ? parsed.slice(4) : parsed) !== MERI_EXECUTION_RECEIVER_PATH) return false;
  return isMeriExecutionBearer(req.headers.authorization);
}

/** Meri's unattended routine firing grant (wire C, D016-A item 5): the one Core
 * route reached with the verified service identity and NO bearer. Exact path
 * and method, parsed target equal to the original, no query and no
 * Authorization header; anything else stays on Clerk verification. */
export const MERI_ROUTINE_UNATTENDED_GRANT_PATH = '/clio/routines/unattended-grant';

export function isMeriRoutineUnattendedGrantPost(req: Request): boolean {
  if (req.method !== 'POST' || req.headers.authorization !== undefined) return false;
  const parsed = mountedRequestPath(req);
  const original = (req.originalUrl ?? req.url ?? '').split('?')[0];
  if (parsed !== original || (req.originalUrl ?? '').includes('?')) return false;
  return (parsed.startsWith('/api/') ? parsed.slice(4) : parsed) === MERI_ROUTINE_UNATTENDED_GRANT_PATH;
}

/** Set only by the tenant middleware after the signature and member checks. */
export function markMeriExecutionRequest(req: Request, identity: MeriExecutionRequestIdentity): void {
  requests.set(req, Object.freeze({ ...identity }));
}

export function meriExecutionRequestOf(req: Request): MeriExecutionRequestIdentity | undefined {
  return requests.get(req);
}
