import 'reflect-metadata';
import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/roles.guard.js';
import { ProcurementMoneyFlowController, ProcurementHubController } from './procurement-money-flow.controller.js';
import { ProcurementMoneyFlowService, procurementScope } from './procurement-money-flow.service.js';
import type { ProcurementMoneyFlow } from '@capiro/shared';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

const key = 'usaspending|award|CONT_AWD_0001_9700_-NONE-_-NONE-';
const clock = '2026-10-31T10:00:00.000001Z';
const empty: ProcurementMoneyFlow = {
  contract: 'defproc-scoped-money-flow/v1', state: 'unavailable', measure: 'qualified_observed_actions', currency: 'USD',
  knownAt: clock, sourceThrough: null, scope: { awardIdentityKeys: [key], includesDescendants: false },
  totals: null, coverage: { unqualified_run: '3' }, groups: [], provenance: [], sources: [],
};
function harness(result: ProcurementMoneyFlow = empty) {
  const query = jest.fn().mockResolvedValue([{ result }]);
  const withTenant = jest.fn((_tenant: string, work: (tx: unknown) => Promise<unknown>, _options: unknown) => work({ $queryRaw: query }));
  return { query, withTenant, service: new ProcurementMoneyFlowService({ withTenant } as never) };
}
describe('procurement request and exact projection boundary', () => {
  it('preserves numeric PIID/full key and exact microseconds without date coercion', () => {
    expect(procurementScope({ awardIdentityKeys: [key], knownAt: clock })).toEqual({ awardIdentityKeys: [key], knownAt: clock, sourceThrough: undefined });
  });
  it.each([null, {}, { awardIdentityKeys: [] }, { awardIdentityKeys: [key, key] }, { awardIdentityKeys: ['0001'] },
    { awardIdentityKeys: [key], tenantId: 'body-tenant' }, { awardIdentityKeys: [key], knownAt: '2026-10-31' },
    { awardIdentityKeys: Array.from({ length: 26 }, (_, n) => `${key}${n}`) }])('rejects malformed scope before any query: %j', async (input) => {
    const h = harness(); await expect(h.service.moneyFlow('synthetic-tenant', input)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.withTenant).not.toHaveBeenCalled();
  });
  it('empty/unqualified data stays unavailable with no financial totals', async () => {
    const h = harness(); expect(await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key] })).toEqual(empty);
    const [tenant, , options] = h.withTenant.mock.calls[0]!;
    expect(tenant).toBe('synthetic-tenant');
    expect(options).toMatchObject({ readOnly: true, timeoutMs: 15000, deadline: { at: expect.any(Number) } });
    expect(h.query.mock.calls[0]!.slice(1)).toEqual([[key], null, null]);
  });
  it('Hub consumes the same selected-cohort strings without floating-point arithmetic', async () => {
    const result = { ...empty, state: 'partial' as const, totals: { actions: '2', obligationUsd: '70368744177664.00', outlayUsd: null, obligationKnown: '2', outlayKnown: '0' } };
    const h = harness(result), response = await h.service.hubSummary('synthetic-tenant', { awardIdentityKeys: [key], knownAt: clock });
    expect(response).toEqual({ ...result, groups: undefined, groupCount: 0 });
    expect(Object.hasOwn(response, 'groups')).toBe(false);
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it.each(['42501', '42883', '57014', '54000'])('denied/missing/timed-out projection %s never falls back', async (code) => {
    const h = harness(); h.query.mockRejectedValue({ code: 'P2010', meta: { code } });
    await expect(h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key] })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it('canonical DB key/calendar refusal maps to a bad request', async () => {
    const h = harness(); h.query.mockRejectedValue({ meta: { code: '22023' } });
    await expect(h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key] })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('refuses absent, malformed or oversized projection output', async () => {
    for (const result of [null, { ...empty, contract: 'legacy' }, { ...empty, coverage: { x: 'a'.repeat(1_048_576) } }, { ...empty, groups: Array(501).fill({}) }]) {
      const h = harness(result as never);
      await expect(h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key] })).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });
});
describe('both registered procurement controller boundaries', () => {
  const guard = new RolesGuard(new Reflector());
  for (const [controller, handler] of [[ProcurementMoneyFlowController, ProcurementMoneyFlowController.prototype.moneyFlow],
    [ProcurementHubController, ProcurementHubController.prototype.summary]] as const) {
    it.each([undefined, { role: 'invented' }, { role: 'client' }])(`${controller.name} rejects unauthenticated/unknown/insufficient role %j`, (tenantContext) => {
      const ctx = { getHandler: () => handler, getClass: () => controller,
        switchToHttp: () => ({ getRequest: () => ({ tenantContext }) }) };
      expect(() => guard.canActivate(ctx as never)).toThrow(ForbiddenException);
    });
    it(`${controller.name} accepts the existing authenticated standard-user boundary`, () => {
      const ctx = { getHandler: () => handler, getClass: () => controller,
        switchToHttp: () => ({ getRequest: () => ({ tenantContext: { role: 'standard_user' } }) }) };
      expect(guard.canActivate(ctx as never)).toBe(true);
    });
  }
  it('forwards trusted tenant context and body scope to the canonical service', async () => {
    const moneyFlow = jest.fn().mockResolvedValue(empty), hubSummary = jest.fn().mockResolvedValue(empty), service = { moneyFlow, hubSummary } as never;
    await new ProcurementMoneyFlowController(service).moneyFlow({ tenantId: 'trusted-tenant' } as never, { awardIdentityKeys: [key] });
    await new ProcurementHubController(service).summary({ tenantId: 'trusted-tenant' } as never, { awardIdentityKeys: [key] });
    expect(moneyFlow).toHaveBeenCalledWith('trusted-tenant', { awardIdentityKeys: [key] });
    expect(hubSummary).toHaveBeenCalledWith('trusted-tenant', { awardIdentityKeys: [key] });
  });
});
