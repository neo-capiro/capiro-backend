import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { RolesGuard } from '../auth/roles.guard.js';
import { BillingAdminGuard } from '../billing/billing-admin.guard.js';
import { BillingController } from '../billing/billing.controller.js';
import { prepareSavedRecordRead, SAVED_RECORD_READ_SOURCES } from './saved-record-read-plan.js';

describe('saved-record read preparation', () => {
  it.each(Object.keys(SAVED_RECORD_READ_SOURCES))(
    'keeps %s inert at its fixed existing GET route',
    (kind) => {
      const result = prepareSavedRecordRead(kind as keyof typeof SAVED_RECORD_READ_SOURCES);
      expect(result).toMatchObject({ method: 'GET', service: 'core', execution: 'unwired' });
      expect(result.path).toBe(
        SAVED_RECORD_READ_SOURCES[kind as keyof typeof SAVED_RECORD_READ_SOURCES].path,
      );
    },
  );
  it.each(['tenantId', 'userId', 'actorId', 'role', 'billingAdmin', 'url', 'path', 'credential'])(
    'rejects caller authority/transport input %s',
    (key) => {
      expect(() => prepareSavedRecordRead('billing_summary', { [key]: 'forged' })).toThrow();
    },
  );
  it.each(['__proto__', 'constructor', 'newsletter_get', 'research_portfolios', 'admin_usage'])(
    'does not infer a read for %s',
    (kind) => {
      expect(() => prepareSavedRecordRead(kind as never)).toThrow();
    },
  );
  it('encodes the saved hearing filter without turning it into another path or parameter', () => {
    expect(
      prepareSavedRecordRead('legiwatch_saved_items', {
        hearingId: 'hearing/?tenantId=other&x=1',
        page: 2,
        pageSize: 50,
      }).path,
    ).toBe(
      '/api/legiwatch/live-hearings/saved-items?hearingId=hearing%2F%3FtenantId%3Dother%26x%3D1&page=2&pageSize=50',
    );
  });
  it.each([0, -1, 101, 1.5, Number.POSITIVE_INFINITY, '10'])(
    'refuses invalid usage limit %p',
    (limit) => {
      expect(() => prepareSavedRecordRead('usage_events', { limit })).toThrow();
    },
  );
  it('retains explicit range bounds and validates canonical filters', () => {
    expect(
      prepareSavedRecordRead('usage_summary', {
        from: '2026-10-01T00:00:00Z',
        to: '2026-10-27T00:00:00Z',
      }).path,
    ).toContain('from=2026-10-01T00%3A00%3A00Z');
    expect(() => prepareSavedRecordRead('usage_summary', { from: 'not-a-date' })).toThrow();
    expect(() =>
      prepareSavedRecordRead('legiwatch_saved_items', { clientId: 'client display name' }),
    ).toThrow();
  });
});

describe('actual billing authority remains a runtime prerequisite', () => {
  const context = (role?: string): ExecutionContext =>
    ({
      getHandler: () => BillingController.prototype.summary,
      getClass: () => BillingController,
      switchToHttp: () => ({
        getRequest: () => ({
          tenantContext: role ? { role, tenantId: 'tenant', userId: 'actor' } : undefined,
        }),
      }),
    }) as unknown as ExecutionContext;
  const roles = new RolesGuard(new Reflector());
  it.each([undefined, 'standard_user', 'invented_admin'])(
    'real RolesGuard refuses %p on the actual summary handler',
    (role) => {
      expect(() => roles.canActivate(context(role))).toThrow();
    },
  );
  it.each([
    { status: 'active', billingAdmin: false },
    { status: 'suspended', billingAdmin: true },
    null,
  ])('real BillingAdminGuard refuses stale or absent billing permission %p', (membership) => {
    const findUnique = jest.fn(async () => membership);
    const guard = new BillingAdminGuard({
      withTenant: async (_tenant: string, run: (tx: unknown) => unknown) =>
        run({ tenantMembership: { findUnique } }),
    } as never);
    return expect(guard.canActivate(context('user_admin'))).rejects.toMatchObject({ status: 403 });
  });
  it('rechecks the exact active membership on every billing summary admission', async () => {
    let allowed = true;
    const findUnique = jest.fn(async () => ({ status: 'active', billingAdmin: allowed }));
    const guard = new BillingAdminGuard({
      withTenant: async (_tenant: string, run: (tx: unknown) => unknown) =>
        run({ tenantMembership: { findUnique } }),
    } as never);
    expect(roles.canActivate(context('user_admin'))).toBe(true);
    await expect(guard.canActivate(context('user_admin'))).resolves.toBe(true);
    expect(findUnique).toHaveBeenLastCalledWith({
      where: { tenantId_userId: { tenantId: 'tenant', userId: 'actor' } },
      select: { billingAdmin: true, status: true },
    });
    allowed = false;
    await expect(guard.canActivate(context('user_admin'))).rejects.toMatchObject({ status: 403 });
  });
});
