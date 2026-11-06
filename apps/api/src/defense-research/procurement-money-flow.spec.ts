import 'reflect-metadata';
import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../auth/roles.guard.js';
import { ProcurementMoneyFlowController, ProcurementHubController } from './procurement-money-flow.controller.js';
import { ProcurementMoneyFlowService, procurementScope } from './procurement-money-flow.service.js';
import type { ProcurementActionDetail, ProcurementMoneyFlow } from '@capiro/shared';
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
    expect(procurementScope({ awardIdentityKeys: [key], knownAt: clock })).toEqual({ awardIdentityKeys: [key], knownAt: clock, sourceThrough: undefined, includeActionDetails: undefined });
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
    expect(Object.hasOwn(response, 'actionDetails')).toBe(false);
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
describe('includeActionDetails opt-in flag validation', () => {
  it('rejects unknown/non-boolean includeActionDetails before any query', async () => {
    for (const badFlag of ['yes', 1, 'true', null, 0]) {
      const h = harness();
      await expect(h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: badFlag }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(h.withTenant).not.toHaveBeenCalled();
    }
  });
  it('default request (no flag) omits actionDetails from response even when DB returns it', async () => {
    const actionDetail: ProcurementActionDetail = {
      transactionIdentityKey: 'sam_gov|modification|%5B%22sam-contract-action%2Fv2%22%2C%22key%22%2C%221%22%2C%221%22%5D',
      awardIdentityKey: key, awardUniqueId: 'CONT_AWD_0001_9700_-NONE-_-NONE-', selectedRevisionId: '12345',
      piid: '0001', submittingAgencyCode: '9700', parentPiid: null, parentAgencyCode: null,
      modificationNumber: '1', transactionNumber: '1', awardType: 'A', actionDate: '2026-10-15',
      fiscalYear: 2027, obligationUsd: '1000000.00', outlayUsd: null,
      sourceRevisionOrder: '2026-10-16T12:00:00.000000Z', sourceObservedAt: '2026-10-16T12:05:00.000000Z',
      recordedAt: '2026-10-16T12:10:00.000000Z', sourceUrl: 'https://api.sam.gov/contract-awards/v1/search?piid=0001',
      sourcePayloadHash: 'sha256:abc123', vendorKey: 'uei:ABC123456DEF', contractorName: 'Test Contractor Inc',
      recipientUei: 'ABC123456DEF', vendorIdentityState: 'source_uei', attributeState: 'latest_known_catalog_observation',
      fundingOrganization: { department: { code: '97', name: 'DEPT OF DEFENSE' }, subtier: { code: '9700', name: 'DEPT OF THE ARMY' }, office: { code: '1234', name: 'ARMY CORPS OF ENGINEERS' } },
      contractingOrganization: { department: { code: '97', name: 'DEPT OF DEFENSE' }, subtier: { code: '9700', name: 'DEPT OF THE ARMY' }, office: { code: '5678', name: 'SPECIAL PROGRAMS DIRECTORATE' } },
    };
    const dbResult = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' }, groups: [], provenance: [], sources: [], actionDetails: [actionDetail] };
    // No includeActionDetails in request
    const h = harness(dbResult as ProcurementMoneyFlow);
    const response = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key] });
    expect(Object.hasOwn(response, 'actionDetails')).toBe(false);
    expect(response.actionDetails).toBeUndefined();
    // Explicitly false also omits
    const h2 = harness(dbResult as ProcurementMoneyFlow);
    const response2 = await h2.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: false });
    expect(Object.hasOwn(response2, 'actionDetails')).toBe(false);
  });
  it('includeActionDetails=true returns actionDetails when DB provides it', async () => {
    const actionDetail: ProcurementActionDetail = {
      transactionIdentityKey: 'sam_gov|modification|x', awardIdentityKey: key, awardUniqueId: 'CONT_AWD_0001_9700_-NONE-_-NONE-', selectedRevisionId: '12345',
      piid: '0001', submittingAgencyCode: '9700', parentPiid: null, parentAgencyCode: null,
      modificationNumber: '1', transactionNumber: '1', awardType: 'A', actionDate: '2026-10-15',
      fiscalYear: 2027, obligationUsd: '1000000.00', outlayUsd: null,
      sourceRevisionOrder: '2026-10-16T12:00:00.000000Z', sourceObservedAt: '2026-10-16T12:05:00.000000Z',
      recordedAt: '2026-10-16T12:10:00.000000Z', sourceUrl: 'https://api.sam.gov/contract-awards/v1/search?piid=0001',
      sourcePayloadHash: 'sha256:abc123', vendorKey: 'uei:ABC123456DEF', contractorName: 'Test Contractor Inc',
      recipientUei: 'ABC123456DEF', vendorIdentityState: 'source_uei', attributeState: 'latest_known_catalog_observation',
      fundingOrganization: { department: { code: '97', name: 'DEPT OF DEFENSE' }, subtier: { code: '9700', name: null }, office: { code: null, name: null } },
      contractingOrganization: { department: { code: '97', name: 'DEPT OF DEFENSE' }, subtier: { code: '2100', name: 'DEPT OF NAVY' }, office: { code: null, name: null } },
    };
    const dbResult = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' }, groups: [], provenance: [], sources: [], actionDetails: [actionDetail] };
    const h = harness(dbResult as ProcurementMoneyFlow);
    const response = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
    expect(Object.hasOwn(response, 'actionDetails')).toBe(true);
    expect(response.actionDetails).toEqual([actionDetail]);
    expect((h.query.mock.calls[0]![0] as string[]).join('')).toContain('public.defproc_money_flow_details_v2(');
  });
  it('includeActionDetails=true with DB returning old SQL (no actionDetails) returns 503', async () => {
    const dbResult = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' }, groups: [], provenance: [], sources: [] };
    // DB result has no actionDetails field (old SQL)
    const h = harness(dbResult as ProcurementMoneyFlow);
    await expect(h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('includeActionDetails=true with >2500 items returns 503', async () => {
    const manyDetails = Array(2501).fill({}) as ProcurementActionDetail[];
    const dbResult = { ...empty, state: 'partial' as const, totals: { actions: '2501', obligationUsd: '0.00', outlayUsd: null, obligationKnown: '2501', outlayKnown: '0' }, groups: [], provenance: [], sources: [], actionDetails: manyDetails };
    const h = harness(dbResult as never);
    await expect(h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('Hub always omits actionDetails regardless of DB response', async () => {
    const actionDetail = { transactionIdentityKey: 'x', awardIdentityKey: key, awardUniqueId: 'CONT_AWD_0001_9700_-NONE-_-NONE-', selectedRevisionId: '1', piid: '0001', submittingAgencyCode: '9700', parentPiid: null, parentAgencyCode: null, modificationNumber: '0', transactionNumber: '1', awardType: 'A' as const, actionDate: null, fiscalYear: null, obligationUsd: '0.00', outlayUsd: null as null, sourceRevisionOrder: clock, sourceObservedAt: clock, recordedAt: clock, sourceUrl: null, sourcePayloadHash: 'sha256:0', vendorKey: 'award:'+key, contractorName: null, recipientUei: null, vendorIdentityState: 'unresolved' as const, attributeState: 'missing_catalog_attributes' as const, fundingOrganization: { department: { code: null, name: null }, subtier: { code: null, name: null }, office: { code: null, name: null } }, contractingOrganization: { department: { code: null, name: null }, subtier: { code: null, name: null }, office: { code: null, name: null } } };
    // DB result with actionDetails
    const dbResult = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '0.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' }, groups: [], provenance: [], sources: [], actionDetails: [actionDetail] };
    const h = harness(dbResult as ProcurementMoneyFlow);
    // Hub with includeActionDetails=true in body; Hub must still omit
    const hubResponse = await h.service.hubSummary('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
    expect(Object.hasOwn(hubResponse, 'actionDetails')).toBe(false);
    expect((hubResponse as Record<string, unknown>)['actionDetails']).toBeUndefined();
    expect(Object.hasOwn(hubResponse, 'groups')).toBe(false);
    expect(hubResponse.groupCount).toBe(0);
  });
});
describe('actionDetails optional additive field', () => {
  const actionDetail: ProcurementActionDetail = {
    transactionIdentityKey: 'sam_gov|modification|%5B%22sam-contract-action%2Fv2%22%2C%22usaspending%7Caward%7CCONT_AWD_0001_9700_-NONE-_-NONE-%22%2C%221%22%2C%221%22%5D',
    awardIdentityKey: 'usaspending|award|CONT_AWD_0001_9700_-NONE-_-NONE-',
    awardUniqueId: 'CONT_AWD_0001_9700_-NONE-_-NONE-',
    selectedRevisionId: '12345',
    piid: '0001',
    submittingAgencyCode: '9700',
    parentPiid: null,
    parentAgencyCode: null,
    modificationNumber: '1',
    transactionNumber: '1',
    awardType: 'A',
    actionDate: '2026-10-15',
    fiscalYear: 2027,
    obligationUsd: '1000000.00',
    outlayUsd: null,
    sourceRevisionOrder: '2026-10-16T12:00:00.000000Z',
    sourceObservedAt: '2026-10-16T12:05:00.000000Z',
    recordedAt: '2026-10-16T12:10:00.000000Z',
    sourceUrl: 'https://api.sam.gov/contract-awards/v1/search?piid=0001',
    sourcePayloadHash: 'sha256:abc123',
    vendorKey: 'uei:ABC123456DEF',
    contractorName: 'Test Contractor Inc',
    recipientUei: 'ABC123456DEF',
    vendorIdentityState: 'source_uei',
    attributeState: 'latest_known_catalog_observation',
    fundingOrganization: {
      department: { code: '97', name: 'DEPT OF DEFENSE' },
      subtier: { code: '9700', name: 'DEPT OF THE ARMY' },
      office: { code: '1234', name: 'ARMY CORPS OF ENGINEERS' },
    },
    contractingOrganization: {
      department: { code: '97', name: 'DEPT OF DEFENSE' },
      subtier: { code: '9700', name: 'DEPT OF THE ARMY' },
      office: { code: '5678', name: 'SPECIAL PROGRAMS DIRECTORATE' },
    },
  };

  it('default response omits actionDetails when DB has no actionDetails field', async () => {
    const result = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' } };
    const h = harness(result), response = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key] });
    expect(response).toEqual(result);
    expect(response.actionDetails).toBeUndefined();
  });

  it('actionDetails returns when flag=true and DB provides it; omitted from HubSummary', async () => {
    const result = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' },
      groups: [], provenance: [], sources: [], actionDetails: [actionDetail] };
    const h = harness(result);
    const fullResponse = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
    expect(fullResponse.actionDetails).toEqual([actionDetail]);
    expect(Object.hasOwn(fullResponse, 'actionDetails')).toBe(true);
    // Hub (same DB result, but service sends flag=undefined internally)
    const h2 = harness(result);
    const hubResponse = await h2.service.hubSummary('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
    expect(Object.hasOwn(hubResponse, 'actionDetails')).toBe(false);
    expect((hubResponse as Record<string, unknown>)['actionDetails']).toBeUndefined();
  });

  it('actionDetails preserves null parent values for direct awards', async () => {
    const detailWithNullParent: ProcurementActionDetail = { ...actionDetail, parentPiid: null, parentAgencyCode: null };
    const result = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' },
      groups: [], provenance: [], sources: [], actionDetails: [detailWithNullParent] };
    const h = harness(result);
    const response = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
    expect(response.actionDetails?.[0]?.parentPiid).toBeNull();
    expect(response.actionDetails?.[0]?.parentAgencyCode).toBeNull();
  });

  it('actionDetails includes null actionDate for undated actions', async () => {
    const detailWithNullDate: ProcurementActionDetail = { ...actionDetail, actionDate: null, fiscalYear: null };
    const result = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' },
      groups: [], provenance: [], sources: [], actionDetails: [detailWithNullDate] };
    const h = harness(result);
    const response = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
    expect(response.actionDetails?.[0]?.actionDate).toBeNull();
    expect(response.actionDetails?.[0]?.fiscalYear).toBeNull();
  });

  it('actionDetails preserves awardType values A/B/C/D', async () => {
    for (const type of ['A', 'B', 'C', 'D'] as const) {
      const detailWithType: ProcurementActionDetail = { ...actionDetail, awardType: type };
      const result = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' },
        groups: [], provenance: [], sources: [], actionDetails: [detailWithType] };
      const h = harness(result);
      const response = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
      expect(response.actionDetails?.[0]?.awardType).toBe(type);
    }
  });

  it('refuses actionDetails array exceeding 2500 items when flag=true', async () => {
    const manyDetails = Array(2501).fill(actionDetail);
    const result = { ...empty, state: 'partial' as const, totals: { actions: '2501', obligationUsd: '2501000000.00', outlayUsd: null, obligationKnown: '2501', outlayKnown: '0' },
      groups: [], provenance: [], sources: [], actionDetails: manyDetails as ProcurementActionDetail[] };
    const h = harness(result as never);
    await expect(h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('actionDetails sums match original totals', async () => {
    const detail1: ProcurementActionDetail = { ...actionDetail, obligationUsd: '500000.00' };
    const detail2: ProcurementActionDetail = { ...actionDetail, transactionIdentityKey: 'sam_gov|modification|x2', obligationUsd: '500000.00' };
    const result = { ...empty, state: 'partial' as const, totals: { actions: '2', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '2', outlayKnown: '0' },
      groups: [], provenance: [], sources: [], actionDetails: [detail1, detail2] };
    const h = harness(result);
    const response = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
    expect(response.actionDetails?.length).toBe(2);
    expect(response.totals?.actions).toBe('2');
    expect(response.totals?.obligationUsd).toBe('1000000.00');
  });

  it('actionDetails vendorIdentityState uses source_uei or unresolved', async () => {
    const detailWithUei: ProcurementActionDetail = { ...actionDetail, vendorIdentityState: 'source_uei', recipientUei: 'ABC123456DEF' };
    const detailUnresolved: ProcurementActionDetail = { ...actionDetail, vendorIdentityState: 'unresolved', recipientUei: null, vendorKey: 'award:usaspending|award|CONT_AWD_0001_9700_-NONE-_-NONE-' };
    const details = [detailWithUei, detailUnresolved];
    const result = { ...empty, state: 'partial' as const, totals: { actions: '2', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '2', outlayKnown: '0' },
      groups: [], provenance: [], sources: [], actionDetails: details };
    const h = harness(result);
    const response = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
    expect(response.actionDetails?.[0]?.vendorIdentityState).toBe('source_uei');
    expect(response.actionDetails?.[1]?.vendorIdentityState).toBe('unresolved');
  });

  it('actionDetails attributeState uses existing group enum values', async () => {
    for (const state of ['latest_known_catalog_observation', 'award_observation_fork', 'missing_catalog_attributes'] as const) {
      const detail: ProcurementActionDetail = { ...actionDetail, attributeState: state };
      const result = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' },
        groups: [], provenance: [], sources: [], actionDetails: [detail] };
      const h = harness(result);
      const response = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
      expect(response.actionDetails?.[0]?.attributeState).toBe(state);
    }
  });

  it('actionDetails preserves null names in funding/contracting org objects (Unknown org is valid)', async () => {
    const detailWithNullNames: ProcurementActionDetail = {
      ...actionDetail,
      fundingOrganization: { department: { code: '97', name: null }, subtier: { code: '9700', name: null }, office: { code: '1234', name: null } },
      contractingOrganization: { department: { code: '97', name: null }, subtier: { code: '9700', name: null }, office: { code: '5678', name: null } },
    };
    const result = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' },
      groups: [], provenance: [], sources: [], actionDetails: [detailWithNullNames] };
    const h = harness(result);
    const response = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
    expect(response.actionDetails?.[0]?.fundingOrganization.department.name).toBeNull();
    expect(response.actionDetails?.[0]?.fundingOrganization.subtier.name).toBeNull();
    expect(response.actionDetails?.[0]?.fundingOrganization.office.name).toBeNull();
    expect(response.actionDetails?.[0]?.contractingOrganization.department.name).toBeNull();
    expect(response.actionDetails?.[0]?.contractingOrganization.subtier.name).toBeNull();
    expect(response.actionDetails?.[0]?.contractingOrganization.office.name).toBeNull();
  });

  it('actionDetails with BOTH null codes is valid (Unknown org is not an error)', async () => {
    const detailAllNull: ProcurementActionDetail = {
      ...actionDetail,
      fundingOrganization: { department: { code: null, name: null }, subtier: { code: null, name: null }, office: { code: null, name: null } },
      contractingOrganization: { department: { code: null, name: null }, subtier: { code: null, name: null }, office: { code: null, name: null } },
    };
    const result = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' },
      groups: [], provenance: [], sources: [], actionDetails: [detailAllNull] };
    const h = harness(result);
    const response = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
    // Should pass, not 503: Unknown org codes are valid
    expect(Object.hasOwn(response, 'actionDetails')).toBe(true);
    expect(response.actionDetails?.[0]?.fundingOrganization.department.code).toBeNull();
    expect(response.actionDetails?.[0]?.contractingOrganization.department.code).toBeNull();
  });

  it('funding and contracting organizations can be different (org separation)', async () => {
    const differentOrgs: ProcurementActionDetail = {
      ...actionDetail,
      fundingOrganization: { department: { code: '1200', name: 'DEPT OF AGRICULTURE' }, subtier: { code: '1201', name: 'USDA FARM SERVICE' }, office: { code: null, name: null } },
      contractingOrganization: { department: { code: '9700', name: 'DEPT OF DEFENSE' }, subtier: { code: '9700', name: 'DEPT OF THE ARMY' }, office: { code: null, name: null } },
    };
    const result = { ...empty, state: 'partial' as const, totals: { actions: '1', obligationUsd: '1000000.00', outlayUsd: null, obligationKnown: '1', outlayKnown: '0' },
      groups: [], provenance: [], sources: [], actionDetails: [differentOrgs] };
    const h = harness(result);
    const response = await h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key], includeActionDetails: true });
    const d = response.actionDetails?.[0]!;
    // Assert the funding and contracting dept codes are actually different
    expect(d.fundingOrganization.department.code).toBe('1200');
    expect(d.contractingOrganization.department.code).toBe('9700');
    expect(d.fundingOrganization.department.code).not.toBe(d.contractingOrganization.department.code);
  });

  it('refuses actionDetails causing 1MiB response limit exceeded', async () => {
    const hugePayload = 'x'.repeat(500_000);
    const manyDetails: ProcurementActionDetail[] = Array(3).fill({
      ...actionDetail,
      sourceUrl: `https://api.sam.gov/contract-awards/v1/search?piid=${hugePayload}`,
      sourcePayloadHash: hugePayload,
    }) as ProcurementActionDetail[];
    const result = { ...empty, state: 'partial' as const, totals: { actions: '3', obligationUsd: '3000000.00', outlayUsd: null, obligationKnown: '3', outlayKnown: '0' },
      groups: [], provenance: [], sources: [], actionDetails: manyDetails };
    const h = harness(result as never);
    await expect(h.service.moneyFlow('synthetic-tenant', { awardIdentityKeys: [key] })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
