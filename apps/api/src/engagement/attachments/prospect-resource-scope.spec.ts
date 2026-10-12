import { prospectResourceScope, tenantFeatureEnabled, clientMemoryAllowed } from '@capiro/shared';
import { clientMemoryAllowed as existingWall } from '../../memory/memory-wall.helpers.js';
import { tenantFeatureEnabled as existingFlag } from '../../common/tenant-flags.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const prospectId = '33333333-3333-4333-8333-333333333333';
const userId = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const state = {
    flag: true as unknown,
    member: true,
    prospect: true,
    dismissedAt: null as Date | null,
    status: 'active',
    linkedClientId: null as string | null,
    client: true,
    clientStatus: 'active',
    wall: false,
    grant: false,
  };
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes('FROM business_development_prospects'))
        return state.prospect
          ? [
              {
                linkedClientId: state.linkedClientId,
                status: state.status,
                dismissedAt: state.dismissedAt,
              },
            ]
          : [];
      if (sql.includes('FROM tenants'))
        return [{ settings: { clioFeatureFlags: { 'businessDevelopment.enabled': state.flag } } }];
      if (sql.includes('FROM tenant_memberships'))
        return state.member ? [{ userId, clerkUserId: 'user_verified' }] : [];
      if (sql.includes('set_config')) return [];
      if (sql.includes('SELECT status,memory_wall'))
        return state.client ? [{ status: state.clientStatus, memoryWall: state.wall }] : [];
      if (sql.includes('SELECT id FROM client_memory_access'))
        return state.grant ? [{ id: 'grant' }] : [];
      if (sql.includes('AS allowed')) return [{ allowed: !state.wall || state.grant }];
      throw Error(sql);
    }),
  };
  return {
    state,
    tx,
    calls,
    read: (mode: 'read' | 'write' = 'read') =>
      prospectResourceScope(
        tx as never,
        tenantId,
        { clerkUserId: 'user_verified' },
        prospectId,
        mode,
      ),
  };
}

describe('current prospect resource authority', () => {
  it('reuses the exact canonical boolean and wall functions', () => {
    expect(existingFlag).toBe(tenantFeatureEnabled);
    expect(existingWall).toBe(clientMemoryAllowed);
  });
  it.each([false, undefined, null, 'true', 1, {}, []])('fails closed on flag %p', async (flag) => {
    const h = fixture();
    h.state.flag = flag;
    expect(await h.read()).toBeNull();
  });
  it('binds verified Clerk identity, current active role and tenant with parameterized SQL', async () => {
    const h = fixture();
    expect(await h.read()).toMatchObject({
      tenantId,
      prospectId,
      userId,
      clerkUserId: 'user_verified',
      linkedClientId: null,
    });
    const member = h.calls.find((c) => c.sql.includes('FROM tenant_memberships'))!;
    expect(member.values).toEqual([tenantId, null, 'user_verified']);
    expect(member.sql).toContain("m.status::text='active'");
    expect(member.sql).toContain("('standard_user','user_admin','capiro_admin')");
    expect(member.sql).toContain('FOR SHARE OF m,u');
    expect(h.calls[0]!.sql).toContain('FROM business_development_prospects');
  });
  it.each(['member', 'prospect', 'client'] as const)('denies missing/revoked %s', async (key) => {
    const h = fixture();
    h.state.linkedClientId = '44444444-4444-4444-8444-444444444444';
    h.state[key] = false;
    expect(await h.read()).toBeNull();
  });
  it('retains historical reads but refuses writes to dismissed or archived origins', async () => {
    const h = fixture();
    h.state.dismissedAt = new Date();
    expect(await h.read()).not.toBeNull();
    expect(await h.read('write')).toBeNull();
    h.state.dismissedAt = null;
    h.state.linkedClientId = '44444444-4444-4444-8444-444444444444';
    h.state.clientStatus = 'archived';
    expect(await h.read()).not.toBeNull();
    expect(await h.read('write')).toBeNull();
  });
  it('conversion applies the current client wall and locks actual grants; revocation has no owner/admin exception', async () => {
    const h = fixture();
    expect(await h.read()).not.toBeNull();
    h.state.linkedClientId = '44444444-4444-4444-8444-444444444444';
    h.state.wall = true;
    expect(await h.read()).toBeNull();
    h.state.grant = true;
    expect(await h.read()).toMatchObject({ prospectId, linkedClientId: h.state.linkedClientId });
    expect(
      h.calls.find((c) => c.sql.includes('SELECT id FROM client_memory_access'))?.sql,
    ).toContain('FOR SHARE');
    h.state.grant = false;
    expect(await h.read()).toBeNull();
  });
  it('does not turn database failures into an authorization success', async () => {
    const h = fixture();
    h.tx.$queryRawUnsafe.mockRejectedValueOnce(Error('unavailable'));
    await expect(h.read()).rejects.toThrow('unavailable');
  });
});
