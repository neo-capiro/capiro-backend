import 'reflect-metadata';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { procurementObservedScope, ProcurementMoneyFlowService } from './procurement-money-flow.service.js';
import { ProcurementMoneyFlowController } from './procurement-money-flow.controller.js';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
const key = 'usaspending|award|CONT_AWD_0001_9700_-NONE-_-NONE-';
const knownAt = '2026-11-05T00:00:00.000000Z';
const request = { awardIdentityKeys: [key], knownAt, revisionBasis: 'latest_observed' as const };
const payload = () => ({ contract: 'defproc-observed-money-flow/v1', state: 'unavailable', measure: 'latest_observed_actions',
  revisionBasis: 'latest_observed', currency: 'USD', knownAt, sourceThrough: null,
  scope: { awardIdentityKeys: [key], includesDescendants: false }, totals: null, groups: [], provenance: [], coverage: {}, sources: [] });
function harness(value: unknown = payload()) {
  const query = jest.fn().mockResolvedValue([{ result: value }]);
  const withTenant = jest.fn((_tenant, work) => work({ $queryRaw: query }));
  return { query, withTenant, service: new ProcurementMoneyFlowService({ withTenant } as never) };
}
describe('explicit observed contract', () => {
  it('accepts only explicit observed scope with exact knowledge clock', () => {
    expect(procurementObservedScope(request)).toEqual({ ...request, includeActionDetails: undefined });
    expect(() => procurementObservedScope({ awardIdentityKeys: [key] })).toThrow(BadRequestException);
  });
  it.each([knownAt, null, undefined])('refuses a publisher cutoff, never silently discards it: %s', sourceThrough => {
    expect(() => procurementObservedScope({ ...request, sourceThrough })).toThrow(BadRequestException);
  });
  it.each(['publisher', '', null, 1])('refuses unapproved basis %s', revisionBasis => {
    expect(() => procurementObservedScope({ ...request, revisionBasis })).toThrow(BadRequestException);
  });
  it('uses a separate observed SQL read without changing old calls', async () => {
    const h = harness();
    expect(await h.service.observedMoneyFlow('tenant-fixture', request)).toEqual(payload());
    expect(h.query.mock.calls[0][0].join('')).toContain('defproc_observed_money_flow_v1');
    expect(h.query.mock.calls[0].slice(1)).toEqual([[key], knownAt, false]);
    expect(h.withTenant.mock.calls[0]![0]).toBe('tenant-fixture');
  });
  it('requires details when requested and rejects a summary-only reply', async () => {
    await expect(harness().service.observedMoneyFlow('tenant-fixture', { ...request, includeActionDetails: true })).rejects.toThrow(ServiceUnavailableException);
    await expect(harness({ ...payload(), actionDetails: [] }).service.observedMoneyFlow('tenant-fixture', { ...request, includeActionDetails: true })).resolves.toMatchObject({ actionDetails: [] });
  });
  it('refuses the old contract and any publisher-cutoff claim on the new path', async () => {
    for (const value of [{ ...payload(), contract: 'defproc-scoped-money-flow/v1' }, { ...payload(), sourceThrough: knownAt }]) {
      await expect(harness(value).service.observedMoneyFlow('tenant-fixture', request)).rejects.toThrow(ServiceUnavailableException);
    }
  });
  it('dispatches only explicit new requests; the old route default remains old', () => {
    const service = { moneyFlow: jest.fn(), observedMoneyFlow: jest.fn() };
    const controller = new ProcurementMoneyFlowController(service as never);
    controller.moneyFlow({ tenantId: 'tenant-fixture' } as never, request);
    expect(service.observedMoneyFlow).toHaveBeenCalledWith('tenant-fixture', request);
    controller.moneyFlow({ tenantId: 'tenant-fixture' } as never, { awardIdentityKeys: [key] });
    expect(service.moneyFlow).toHaveBeenCalledWith('tenant-fixture', { awardIdentityKeys: [key] });
  });
});
