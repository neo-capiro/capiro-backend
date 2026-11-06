import { ForbiddenException, NotFoundException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { TenantContext } from '@capiro/shared';
import { TrackerClientAccessGuard } from './tracker-client-access.guard.js';
import { TrackerController } from './tracker.controller.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const clientId = '00000000-0000-4000-8000-000000000003';
const ctx: TenantContext = {
  tenantId,
  userId,
  clerkUserId: 'user_synthetic',
  tenantSlug: 'synthetic',
  role: 'standard_user',
};
function fixture() {
  const state = { member: true, client: true, wallAllowed: true };
  const tx = {
    tenantMembership: {
      findFirst: jest.fn(async () => (state.member ? { role: ctx.role } : null)),
    },
    $queryRaw: jest.fn(async (query: { strings?: string[] } | TemplateStringsArray) => {
      const sql = Array.isArray(query)
        ? query.join('')
        : ((query as { strings?: string[] }).strings?.join('') ?? '');
      if (sql.includes('FROM tenant_memberships')) return state.member ? [{ role: ctx.role }] : [];
      if (sql.includes('FROM clients')) return state.client ? [{ version: 1, primary: null }] : [];
      return [];
    }),
    $queryRawUnsafe: jest.fn(async () => [{ allowed: state.wallAllowed }]),
  };
  const prisma = { withTenantUser: jest.fn(async (_tenant, _user, work) => work(tx)) };
  const guard = new TrackerClientAccessGuard(prisma as never);
  const req = { tenantContext: ctx, params: { clientId } };
  const execution = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => TrackerController.prototype.getBoard,
  } as unknown as ExecutionContext;
  return { state, tx, prisma, guard, req, execution };
}

describe('retained Core tracker request-start client authorization', () => {
  it('protects the entire retained client controller, including track/untrack/watchlist/board', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, TrackerController)).toContain(
      TrackerClientAccessGuard,
    );
  });
  it('allows the current authorized actor in a tenant/user-scoped transaction', async () => {
    const f = fixture();
    expect(await f.guard.canActivate(f.execution)).toBe(true);
    expect(f.prisma.withTenantUser).toHaveBeenCalledWith(tenantId, userId, expect.any(Function));
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('client_memory_access'),
      tenantId,
      clientId,
      userId,
    );
  });
  it.each(['cross-tenant client', 'archived client', 'revoked membership', 'walled client'])(
    'denies %s before retained reads or writes run',
    async (reason) => {
      const f = fixture();
      if (reason.includes('client') && reason !== 'walled client') f.state.client = false;
      if (reason === 'revoked membership') f.state.member = false;
      if (reason === 'walled client') f.state.wallAllowed = false;
      const operation = jest.fn();
      await expect(
        (async () => {
          await f.guard.canActivate(f.execution);
          operation();
        })(),
      ).rejects.toBeInstanceOf(
        reason === 'revoked membership' ? ForbiddenException : NotFoundException,
      );
      expect(operation).not.toHaveBeenCalled();
    },
  );
  it('rechecks a deleted wall grant on the next request without an admin bypass', async () => {
    const f = fixture();
    expect(await f.guard.canActivate(f.execution)).toBe(true);
    f.state.wallAllowed = false;
    await expect(f.guard.canActivate(f.execution)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('rejects an invalid route client ID even if a body/query names an authorized client', async () => {
    const f = fixture();
    Object.assign(f.req, {
      params: { clientId: 'not-a-client' },
      body: { clientId },
      query: { clientId },
    });
    await expect(f.guard.canActivate(f.execution)).rejects.toBeInstanceOf(NotFoundException);
  });
});
