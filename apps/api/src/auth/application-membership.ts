import { createHash } from 'node:crypto';
import type { TenantRole } from '@capiro/shared';

/** A current observation. Neither this revision nor this receipt grants access. */
export interface ApplicationMembershipReceipt {
  tenantId: string;
  actorId: string;
  status: 'active';
  role: TenantRole;
  permissions: string[];
  clientIds: string[];
  membershipRevision: string;
  checkedAtMs: number;
  expiresAtMs: number;
}

export interface ApplicationMembershipControl {
  /** Absolute epoch milliseconds; the HTTP owner permits at most 30 seconds. */
  deadlineMs: number;
  assertActive(): void;
}

export interface ApplicationMembershipSnapshot {
  tenantId: string;
  actorId: string;
  membershipId: string;
  role: TenantRole;
  updatedAtMs: number;
  clerkOrgId: string | null;
  clients: Array<{ id: string; revision: string }>;
}

export const APPLICATION_MEMBERSHIP_MAX_CLIENTS = 4096;

/** Fixed, validated server facts; session/receipt clocks deliberately excluded. */
export function applicationMembershipRevision(snapshot: ApplicationMembershipSnapshot): string {
  return createHash('sha256').update('capiro-application-membership-v1\n').update(JSON.stringify([
    snapshot.tenantId, snapshot.actorId, snapshot.membershipId, 'active', snapshot.role,
    snapshot.updatedAtMs, 'active', snapshot.clerkOrgId,
    snapshot.clients.map(({ id, revision }) => [id, revision]),
  ])).digest('hex');
}
