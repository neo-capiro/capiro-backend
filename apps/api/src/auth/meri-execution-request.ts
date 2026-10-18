import type { Request } from 'express';
import { isMeriExecutionBearer } from './core-ed25519-kms-config.js';

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
  const parsed = req.path;
  const original = (req.originalUrl ?? req.url ?? '').split('?')[0];
  if (parsed !== original || (req.originalUrl ?? '').includes('?')) return false;
  if ((parsed.startsWith('/api/') ? parsed.slice(4) : parsed) !== MERI_EXECUTION_RECEIVER_PATH) return false;
  return isMeriExecutionBearer(req.headers.authorization);
}

/** Set only by the tenant middleware after the signature and member checks. */
export function markMeriExecutionRequest(req: Request, identity: MeriExecutionRequestIdentity): void {
  requests.set(req, Object.freeze({ ...identity }));
}

export function meriExecutionRequestOf(req: Request): MeriExecutionRequestIdentity | undefined {
  return requests.get(req);
}
