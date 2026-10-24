import { ServiceUnavailableException } from '@nestjs/common';
import type { ClerkService } from '../auth/clerk.service.js';

type Organizations = ClerkService['backend']['organizations'];
type Invitation = Awaited<
  ReturnType<Organizations['getOrganizationInvitationList']>
>['data'][number];
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** Complete, bounded provider observation. Never mutate from a silently truncated list. */
export async function pendingInvitations(organizations: Organizations, organizationId: string) {
  const rows = new Map<string, Invitation>();
  let expected: number | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await organizations.getOrganizationInvitationList({
      organizationId,
      status: ['pending'],
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });
    if (
      !Number.isSafeInteger(result.totalCount) ||
      result.totalCount < 0 ||
      result.totalCount > PAGE_SIZE * MAX_PAGES ||
      (expected !== undefined && expected !== result.totalCount)
    )
      incomplete();
    expected = result.totalCount;
    for (const row of result.data) {
      if (row.organizationId !== organizationId || row.status !== 'pending' || rows.has(row.id))
        incomplete();
      rows.set(row.id, row);
    }
    if ((page + 1) * PAGE_SIZE >= expected) {
      if (rows.size !== expected) incomplete();
      return [...rows.values()];
    }
  }
  return incomplete();
}

function incomplete(): never {
  throw new ServiceUnavailableException(
    'The complete pending invitation list could not be verified. Reload before changing invitations.',
  );
}

/** Names are presentation metadata; tenant binding always comes from the verified target. */
export function invitationMetadata(metadata: Record<string, unknown>, tenantId: string) {
  const name = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, 120) : '');
  const first = name(metadata.first_name),
    last = name(metadata.last_name);
  return {
    capiro_tenant_id: tenantId,
    ...(first ? { first_name: first } : {}),
    ...(last ? { last_name: last } : {}),
  };
}
