import { describe, expect, it, jest } from '@jest/globals';
import { invitationMetadata, pendingInvitations } from './pending-invitations.js';

const invite = (id: string) => ({ id, organizationId: 'org-a', status: 'pending' });
function provider(pages: Array<{ data: unknown[]; totalCount: number }>) {
  return { getOrganizationInvitationList: jest.fn(async () => pages.shift()!) };
}
describe('bounded pending invitation observation (synthetic provider)', () => {
  it('uses explicit offsets to include targets after the first hundred', async () => {
    const first = Array.from({ length: 100 }, (_, i) => invite(String(i)));
    const api = provider([
      { data: first, totalCount: 101 },
      { data: [invite('target')], totalCount: 101 },
    ]);
    const rows = await pendingInvitations(api as never, 'org-a');
    expect(rows).toHaveLength(101);
    expect(rows.at(-1)?.id).toBe('target');
    expect(api.getOrganizationInvitationList).toHaveBeenNthCalledWith(2, {
      organizationId: 'org-a',
      status: ['pending'],
      limit: 100,
      offset: 100,
    });
  });
  it('does not mistake an empty continued page for a complete list', async () => {
    const api = provider([
      { data: [], totalCount: 101 },
      { data: [invite('target')], totalCount: 101 },
    ]);
    await expect(pendingInvitations(api as never, 'org-a')).rejects.toMatchObject({ status: 503 });
    expect(api.getOrganizationInvitationList).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ data: [invite('a'), invite('a')], totalCount: 2 }],
    [{ data: [{ ...invite('a'), organizationId: 'org-b' }], totalCount: 1 }],
    [{ data: [{ ...invite('a'), status: 'revoked' }], totalCount: 1 }],
    [{ data: [], totalCount: 5001 }],
    [{ data: [], totalCount: -1 }],
    [
      { data: [], totalCount: 101 },
      { data: [invite('a')], totalCount: 1 },
    ],
  ])('refuses incomplete, foreign, stale or unbounded enumeration %#', async (...pages) => {
    await expect(pendingInvitations(provider(pages) as never, 'org-a')).rejects.toMatchObject({
      status: 503,
    });
  });
  it('retains only bounded names and the authoritative tenant ID', () => {
    expect(
      invitationMetadata(
        {
          first_name: ' Ada ',
          last_name: 'Lovelace',
          capiro_tenant_id: 'foreign',
          private: 'omit',
        },
        'tenant-a',
      ),
    ).toEqual({ capiro_tenant_id: 'tenant-a', first_name: 'Ada', last_name: 'Lovelace' });
    expect(
      invitationMetadata({ first_name: { injected: true }, last_name: ' ' }, 'tenant-a'),
    ).toEqual({ capiro_tenant_id: 'tenant-a' });
  });
});
