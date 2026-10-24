import 'reflect-metadata';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/roles.guard.js';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../auth/clerk.service.js', () => ({ ClerkService: class {} }));
jest.mock('../auth/clerk-provisioning.service.js', () => ({ ClerkProvisioningService: class {} }));
jest.mock('../auth/identity-outbox.service.js', () => ({ IdentityOutboxService: class {} }));
import { TenantAdminService } from './tenant-admin.service.js';
import { TenantAdminController } from './tenant-admin.controller.js';

const ctx = {
  tenantId: 'tenant-a',
  tenantSlug: 'a',
  userId: 'actor-a',
  clerkUserId: 'user-a',
  role: 'user_admin' as const,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let row = {
    id: ctx.tenantId,
    name: 'Before',
    clerkOrgId: 'org-a' as string | null,
    status: 'active',
    logoS3Key: 'own-logo',
  };
  const state = {
    commitFailure: false,
    readFailure: false,
    afterCommit: () => {},
    inTransaction: false,
  };
  const provider = jest.fn(async (id: string, data: { name: string }) => {
    expect(state.inTransaction).toBe(false);
    return { id, ...data };
  });
  const read = jest.fn(async () => {
    if (state.readFailure) throw new Error('private-database-diagnostic');
    return { ...row };
  });
  const update = jest.fn(async ({ data }: { data: object }) => ({ ...row, ...data }));
  const prisma = {
    withTenant: jest.fn(async (tenant: string, action: (tx: unknown) => Promise<any>) => {
      expect(tenant).toBe(ctx.tenantId);
      state.inTransaction = true;
      const before = update.mock.calls.length;
      try {
        const result = await action({ tenant: { update, findUnique: read } });
        if (update.mock.calls.length > before) {
          if (state.commitFailure) throw new Error('commit refused');
          row = { ...result };
          state.afterCommit();
        }
        return result;
      } finally {
        state.inTransaction = false;
      }
    }),
  };
  const service = new TenantAdminService(
    prisma as never,
    { backend: { organizations: { updateOrganization: provider } } } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  return { service, state, provider, read, update, prisma, warn, current: () => row };
}
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('ST27 local name commit and explicit provider-only retry', () => {
  it('commits before the provider sees the canonical name, retaining logo fields', async () => {
    const f = fixture();
    f.provider.mockImplementation(async (id, input) => {
      expect(f.current().name).toBe('Saved');
      expect(f.state.inTransaction).toBe(false);
      return { id, ...input };
    });
    await expect(f.service.updateBranding(ctx, { name: 'Saved' })).resolves.toMatchObject({
      name: 'Saved',
      logoS3Key: 'own-logo',
      clerkSync: 'confirmed',
    });
    expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it('a commit refusal makes zero provider calls', async () => {
    const f = fixture();
    f.state.commitFailure = true;
    await expect(f.service.updateBranding(ctx, { name: 'Rejected' })).rejects.toThrow(
      'commit refused',
    );
    expect(f.current().name).toBe('Before');
    expect(f.provider).not.toHaveBeenCalled();
  });
  it('a provider rejection preserves the local save and emits no payload', async () => {
    const f = fixture();
    f.provider.mockRejectedValue(new Error('private-provider-name/token/body'));
    await expect(
      f.service.updateBranding(ctx, { name: 'Private saved name' }),
    ).resolves.toMatchObject({ clerkSync: 'failed' });
    expect(f.current().name).toBe('Private saved name');
    expect(f.warn.mock.calls).toEqual([['branding_clerk_sync_failed']]);
    expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it.each(['resolve', 'reject'] as const)(
    'bounds the wait and consumes late %s without replay or false acknowledgment',
    async (settle) => {
      jest.useFakeTimers();
      const f = fixture(),
        late = deferred<{ id: string; name: string }>();
      f.provider.mockReturnValue(late.promise);
      const saving = f.service.updateBranding(ctx, { name: 'Saved' });
      await jest.advanceTimersByTimeAsync(5_000);
      const receipt = await saving;
      expect(receipt.clerkSync).toBe('unknown');
      expect(f.current().name).toBe('Saved');
      if (settle === 'resolve') late.resolve({ id: 'org-a', name: 'Saved' });
      else late.reject(new Error('late-private-error'));
      await jest.advanceTimersByTimeAsync(30_000);
      expect(receipt.clerkSync).toBe('unknown');
      expect(f.provider).toHaveBeenCalledTimes(1);
      expect(f.warn.mock.calls).toEqual([['branding_clerk_sync_unknown']]);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
  it.each([
    { id: 'wrong', name: 'Saved' },
    { id: 'org-a', name: 'Wrong' },
  ])('does not accept a mismatched provider receipt %j', async (receipt) => {
    const f = fixture();
    f.provider.mockResolvedValue(receipt);
    await expect(f.service.updateBranding(ctx, { name: 'Saved' })).resolves.toMatchObject({
      clerkSync: 'unknown',
    });
  });
  it.each(['name', 'clerkOrgId'] as const)(
    'skips a known superseded %s after commit',
    async (key) => {
      const f = fixture();
      f.state.afterCommit = () => {
        f.current()[key] = 'Changed';
      };
      await expect(f.service.updateBranding(ctx, { name: 'Saved' })).resolves.toMatchObject({
        clerkSync: 'superseded',
      });
      expect(f.provider).not.toHaveBeenCalled();
    },
  );
  it('reports a failed post-commit read without losing the local receipt', async () => {
    const f = fixture();
    f.state.readFailure = true;
    await expect(f.service.updateBranding(ctx, { name: 'Saved' })).resolves.toMatchObject({
      name: 'Saved',
      clerkSync: 'unknown',
    });
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.warn.mock.calls).toEqual([['branding_clerk_sync_current_read_failed']]);
  });
  it('does not attempt a provider call for an omitted name or missing organization', async () => {
    const f = fixture();
    await expect(f.service.updateBranding(ctx, {})).resolves.toMatchObject({
      clerkSync: 'not_requested',
    });
    f.current().clerkOrgId = null;
    await expect(f.service.updateBranding(ctx, { name: 'Saved' })).resolves.toMatchObject({
      clerkSync: 'not_linked',
    });
    expect(f.provider).not.toHaveBeenCalled();
  });
  it('manual retry reads the current canonical name and organization without writing the tenant', async () => {
    const f = fixture();
    f.current().name = 'Changed by another admin';
    f.current().clerkOrgId = 'current-org';
    await expect(f.service.retryBrandingSync(ctx)).resolves.toEqual({
      id: ctx.tenantId,
      name: 'Changed by another admin',
      clerkSync: 'confirmed',
    });
    expect(f.provider).toHaveBeenCalledWith('current-org', { name: 'Changed by another admin' });
    expect(f.update).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledWith({
      where: { id: ctx.tenantId },
      select: { id: true, name: true, clerkOrgId: true, status: true },
    });
  });
  it.each([
    { name: 'draft' },
    { tenantId: 'foreign' },
    { clerkOrgId: 'foreign' },
    [],
    null,
    'text',
  ])('refuses retry selectors %j before effects', async (body) => {
    const f = fixture();
    await expect(f.service.retryBrandingSync(ctx, body)).rejects.toMatchObject({ status: 400 });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.provider).not.toHaveBeenCalled();
  });
  it.each(['suspended', 'pending'])('refuses retry for a currently %s tenant', async (status) => {
    const f = fixture();
    f.current().status = status;
    await expect(f.service.retryBrandingSync(ctx, {})).rejects.toMatchObject({ status: 403 });
    expect(f.provider).not.toHaveBeenCalled();
  });
  it('keeps retry under the existing admin route guard and refuses a nonadmin service call', async () => {
    const f = fixture();
    const guard = new RolesGuard(new Reflector());
    for (const role of ['standard_user', 'client_portal_user', 'unmapped']) {
      const execution = {
        getHandler: () => TenantAdminController.prototype.retryBrandingSync,
        getClass: () => TenantAdminController,
        switchToHttp: () => ({ getRequest: () => ({ tenantContext: { ...ctx, role } }) }),
      };
      expect(() => guard.canActivate(execution as never)).toThrow();
      await expect(f.service.retryBrandingSync({ ...ctx, role } as never)).rejects.toMatchObject({
        status: 403,
      });
    }
    expect(f.provider).not.toHaveBeenCalled();
  });
  it('late provider completion cannot overwrite the newer canonical local name', async () => {
    const f = fixture(),
      first = deferred<{ id: string; name: string }>();
    f.provider.mockReturnValueOnce(first.promise);
    const earlier = f.service.updateBranding(ctx, { name: 'Earlier' });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await expect(f.service.updateBranding(ctx, { name: 'Latest' })).resolves.toMatchObject({
      clerkSync: 'confirmed',
    });
    first.resolve({ id: 'org-a', name: 'Earlier' });
    await expect(earlier).resolves.toMatchObject({ clerkSync: 'confirmed' });
    expect(f.current().name).toBe('Latest');
    // Provider last-writer convergence is deliberately not claimed by either acknowledgment.
  });
});
