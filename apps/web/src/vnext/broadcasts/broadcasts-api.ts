/**
 * Capiro-staff broadcasts: shared types + query keys for the Settings console
 * (VNextBroadcastsPage) and the end-user acknowledgement gate
 * (VNextBroadcastAckGate). Endpoints live in apps/api/src/admin-broadcasts.
 */

export type BroadcastAudience = 'all_users' | 'selected_users';

export interface BroadcastSender {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface BroadcastSummary {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  audience: BroadcastAudience;
  createdAt: string;
  archivedAt: string | null;
  createdBy: BroadcastSender | null;
  recipientCount: number;
  acknowledgedCount: number;
}

export interface BroadcastRecipient {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  acknowledgedAt: string | null;
}

export interface BroadcastDetail extends BroadcastSummary {
  recipients: BroadcastRecipient[];
}

export interface TenantMemberOption {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  status: string;
}

export interface PendingBroadcast {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export const broadcastKeys = {
  list: (tenantId: string) => ['capiro-admin', 'broadcasts', 'list', tenantId] as const,
  detail: (id: string) => ['capiro-admin', 'broadcasts', 'detail', id] as const,
  members: (tenantId: string) => ['capiro-admin', 'broadcasts', 'members', tenantId] as const,
  pending: ['me', 'broadcasts', 'pending'] as const,
};

export function memberDisplayName(m: {
  email: string;
  firstName: string | null;
  lastName: string | null;
}): string {
  const full = [m.firstName, m.lastName].filter(Boolean).join(' ').trim();
  return full || m.email;
}
