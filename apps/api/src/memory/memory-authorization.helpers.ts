import type { TenantRole } from '@capiro/shared';
import type {
  GovernedMemoryScope,
  GovernedMemoryStatus,
  MemoryClass,
} from '@capiro/meriv2-core';

export const MEMORY_PERMISSIONS = [
  'propose',
  'review',
  'approve',
  'edit',
  'confirm',
  'mark_stale',
  'revoke',
  'resolve_conflict',
] as const;
export type MemoryPermission = (typeof MEMORY_PERMISSIONS)[number];
export type MemoryOperation = 'read' | 'export' | MemoryPermission;

export interface MemoryAuthorizationSubject {
  memoryClass: MemoryClass;
  scope: GovernedMemoryScope;
  ownerUserId?: string | null;
  clientId?: string | null;
  status?: GovernedMemoryStatus | string | null;
  legalHold?: boolean | null;
}

export interface MemoryAuthorizationFacts {
  userId: string;
  role: TenantRole;
  operation: MemoryOperation;
  subject: MemoryAuthorizationSubject;
  ethicalWallAllowed: boolean;
  clientStatus?: string | null;
  grantPermissions?: readonly string[];
  impersonating?: boolean;
  actorRole?: TenantRole | null;
}

export type MemoryAuthorizationDecision =
  | { allowed: true; basis: 'owner' | 'tenant_read' | 'admin' | 'explicit_grant' }
  | {
      allowed: false;
      reason:
        | 'revoked_or_terminal'
        | 'not_owner'
        | 'ethical_wall'
        | 'wrong_client_scope'
        | 'archived_client'
        | 'missing_grant'
        | 'admin_required'
        | 'legal_hold'
        | 'unsupported_operation';
    };

function isAdmin(role: TenantRole | null | undefined): boolean {
  return role === 'user_admin' || role === 'capiro_admin';
}

function isTerminal(status: string | null | undefined): boolean {
  return ['revoked', 'superseded', 'rejected', 'expired'].includes(status ?? '');
}

function isDestructive(operation: MemoryOperation): boolean {
  return ['edit', 'revoke'].includes(operation);
}

/**
 * One class-specific policy. Read/propose visibility is separate from mutation
 * authority. A proposal never changes the active record and always enters review,
 * so a user who can read a shared memory may suggest a correction without gaining
 * edit/approve/revoke rights. Admins are never an ethical-wall bypass.
 */
export function evaluateGovernedMemoryAuthorization(
  facts: MemoryAuthorizationFacts,
): MemoryAuthorizationDecision {
  const { operation, subject } = facts;
  const effectiveRole = facts.impersonating ? facts.actorRole ?? facts.role : facts.role;
  const admin = isAdmin(effectiveRole);
  const readOnly = operation === 'read' || operation === 'export';

  if (isTerminal(subject.status) && !readOnly) {
    return { allowed: false, reason: 'revoked_or_terminal' };
  }
  if (subject.legalHold && isDestructive(operation)) {
    return { allowed: false, reason: 'legal_hold' };
  }

  if (subject.scope === 'user_private' || subject.memoryClass === 'user_preference') {
    if (subject.ownerUserId !== facts.userId) return { allowed: false, reason: 'not_owner' };
    if (
      readOnly ||
      ['propose', 'review', 'approve', 'edit', 'confirm', 'mark_stale', 'revoke'].includes(
        operation,
      )
    ) {
      return { allowed: true, basis: 'owner' };
    }
    return { allowed: false, reason: 'unsupported_operation' };
  }

  if (subject.scope === 'client' || subject.memoryClass === 'client_steering') {
    if (!subject.clientId) return { allowed: false, reason: 'wrong_client_scope' };
    if (!facts.ethicalWallAllowed) return { allowed: false, reason: 'ethical_wall' };
    if (!readOnly && facts.clientStatus && facts.clientStatus !== 'active') {
      return { allowed: false, reason: 'archived_client' };
    }
    if (readOnly || operation === 'propose') {
      return { allowed: true, basis: 'tenant_read' };
    }
    const grants = new Set(facts.grantPermissions ?? []);
    if (grants.has(operation)) return { allowed: true, basis: 'explicit_grant' };
    if (admin) return { allowed: true, basis: 'admin' };
    return { allowed: false, reason: 'missing_grant' };
  }

  if (subject.scope === 'firm' || subject.memoryClass === 'institutional_authoritative') {
    if (readOnly || operation === 'propose') return { allowed: true, basis: 'tenant_read' };
    if (admin) return { allowed: true, basis: 'admin' };
    return { allowed: false, reason: 'admin_required' };
  }

  if (subject.memoryClass === 'episodic_working') {
    if (subject.ownerUserId === facts.userId) return { allowed: true, basis: 'owner' };
    if (readOnly) return { allowed: false, reason: 'not_owner' };
    const grants = new Set(facts.grantPermissions ?? []);
    if (grants.has(operation)) return { allowed: true, basis: 'explicit_grant' };
    return { allowed: false, reason: 'missing_grant' };
  }

  return { allowed: false, reason: 'unsupported_operation' };
}
