import type { TenantContext } from '@capiro/shared';

export interface MemoryMutationSubject {
  /** Canonical memory_items visibility. */
  visibility?: 'tenant' | 'user' | string | null;
  /** Legacy clio_memory scope. */
  scope?: 'firm' | 'client' | 'user_private' | string | null;
  ownerUserId?: string | null;
  clientId?: string | null;
  status?: string | null;
  legalHold?: boolean | null;
}

export type MemoryMutationOperation = 'confirm' | 'edit' | 'correct' | 'forget';

export type MemoryMutationDecision =
  | { allowed: true; kind: 'private' | 'shared' }
  | { allowed: false; reason: 'unauthorized' | 'revoked' | 'legal_hold' | 'unknown_scope' };

export function isMemoryAdmin(role: string | null | undefined): boolean {
  return role === 'user_admin' || role === 'capiro_admin';
}

/**
 * Phase 0 memory mutation policy shared by canonical memory_items and legacy
 * clio_memory surfaces. Read visibility is deliberately absent from this
 * decision: tenant-visible content is not writable by every tenant member.
 * Legal hold blocks correction/deletion but does not prevent re-confirmation.
 */
export function evaluateMemoryMutation(
  ctx: Pick<TenantContext, 'userId' | 'role'>,
  subject: MemoryMutationSubject,
  operation: MemoryMutationOperation = 'edit',
): MemoryMutationDecision {
  if (subject.status === 'revoked') return { allowed: false, reason: 'revoked' };

  const privateMemory = subject.visibility === 'user' || subject.scope === 'user_private';
  const legalHoldBlocks =
    Boolean(subject.legalHold) && (operation === 'correct' || operation === 'forget');

  if (privateMemory) {
    if (subject.ownerUserId === ctx.userId) {
      if (legalHoldBlocks) return { allowed: false, reason: 'legal_hold' };
      return { allowed: true, kind: 'private' };
    }
    return { allowed: false, reason: 'unauthorized' };
  }

  const sharedMemory =
    subject.visibility === 'tenant' || subject.scope === 'firm' || subject.scope === 'client';
  if (sharedMemory) {
    if (!isMemoryAdmin(ctx.role)) return { allowed: false, reason: 'unauthorized' };
    if (legalHoldBlocks) return { allowed: false, reason: 'legal_hold' };
    return { allowed: true, kind: 'shared' };
  }

  return { allowed: false, reason: 'unknown_scope' };
}
