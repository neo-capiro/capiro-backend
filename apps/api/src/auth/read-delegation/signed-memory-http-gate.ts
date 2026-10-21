import { mountedRequestPath } from '../mounted-request-path.js';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import type { OperationRef } from './read-delegation.contract.js';

/** Source registration only. No environment variable or request may activate
 * either transport. A later owner must qualify the matching Meri wire, Core
 * role/migration and runtime readback before changing these two decisions. */
export const signedMemoryPageEnabled = (): boolean => false;
export const signedMemoryProposalEnabled = (): boolean => false;

export const isSignedMemoryPageOperation = (operation: OperationRef | null | undefined): boolean =>
  operation?.id === 'search_memory' && operation.version === '0.2.0';

export const isSignedMemoryProposalOperation = (operation: OperationRef | null | undefined): boolean =>
  operation?.id === 'memory.list_own_proposals' && operation.version === '0.2.0';

/** A closed receiver refuses before an ordinary one-use JTI is minted or
 * consumed, even if its operation belongs to the original ADMITTED set. */
export function assertSignedMemorySourceEnabled(operation: OperationRef | null | undefined): void {
  if (isSignedMemoryPageOperation(operation) && !signedMemoryPageEnabled())
    throw new ServiceUnavailableException('Passive memory page unavailable');
  if (isSignedMemoryProposalOperation(operation) && !signedMemoryProposalEnabled())
    throw new ServiceUnavailableException('Memory proposal page unavailable');
}

/** Exact helper target only; a different path stays with the ordinary read
 * token verifier and can never borrow this bearer-less middleware branch. */
export function isSignedMemoryHelperPost(req: Request): boolean {
  const original = req.originalUrl ?? req.url ?? '';
  const path = mountedRequestPath(req);
  return req.method === 'POST' && typeof path === 'string' && path === original &&
    !original.includes('?') && !original.includes('#') &&
    (path.startsWith('/api/') ? path : `/api${path}`) === '/api/clio/tools/search_memory_eligibility';
}

export function isSignedMemoryPagePost(req: Request): boolean {
  const original = req.originalUrl ?? req.url ?? '';
  const path = mountedRequestPath(req);
  return req.method === 'POST' && typeof path === 'string' && path === original &&
    !original.includes('?') && !original.includes('#') &&
    (path.startsWith('/api/') ? path : `/api${path}`) === '/api/clio/tools/search_memory';
}

export function isSignedMemoryProposalPost(req: Request): boolean {
  const original = req.originalUrl ?? req.url ?? '';
  const path = mountedRequestPath(req);
  return req.method === 'POST' && typeof path === 'string' && path === original &&
    !original.includes('?') && !original.includes('#') &&
    (path.startsWith('/api/') ? path : `/api${path}`) === '/api/clio/tools/memory.list_own_proposals';
}
