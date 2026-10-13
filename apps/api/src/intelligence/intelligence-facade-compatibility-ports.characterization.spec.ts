import type { IntelligenceService } from './intelligence.service.js';
import {
  awardSources,
  clientId,
  deferred,
  harness,
  installHooks,
  tenantId,
  type Subject,
} from '../../test/fixtures/intelligence-facade-compatibility.js';

installHooks();

it('facade profile callbacks read current method overrides on every request with the real Root receiver', async () => {
  const h = harness();
  const events: string[] = [];
  const first = deferred<Awaited<ReturnType<IntelligenceService['getTrackedBills']>>>();
  const second = deferred<Awaited<ReturnType<IntelligenceService['getTrackedBills']>>>();
  const initial = jest.fn(function (this: unknown, _client: string, _tenant?: string) {
    events.push('first-call');
    return first.promise;
  });
  const replacement = jest.fn(function (this: unknown, _client: string, _tenant?: string) {
    events.push('second-call');
    return second.promise;
  });
  let current = initial;
  Object.defineProperty(h.service, 'getTrackedBills', {
    configurable: true,
    get: () => {
      events.push('method-read');
      return current;
    },
  });
  const callback = h.fields.profileV1.ports.getTrackedBills;
  expect(events).toEqual([]);
  expect(callback(clientId, tenantId)).toBe(first.promise);
  current = replacement;
  expect(callback(clientId, tenantId)).toBe(second.promise);
  expect(events).toEqual(['method-read', 'first-call', 'method-read', 'second-call']);
  expect(initial.mock.contexts[0]).toBe(h.service);
  expect(replacement.mock.contexts[0]).toBe(h.service);
  expect(initial).toHaveBeenCalledWith(clientId, tenantId);
  expect(replacement).toHaveBeenCalledWith(clientId, tenantId);
  first.resolve({ total: 0, issueCodes: [], bills: [] });
  second.resolve({ total: 0, issueCodes: [], bills: [] });
  expect(h.forbidden).not.toHaveBeenCalled();
});

it('facade bill, relationship and alert lineage callbacks share the current Root override and original promise', () => {
  const h = harness();
  const work = Promise.resolve([7, 2]);
  const override = jest.fn(function (this: unknown, _client: string, _tenant: string) {
    return work;
  });
  h.subject.confirmedLdaIds = override;
  expect(h.fields.relevantBillDiscovery.ports.confirmedLdaIds(clientId, tenantId)).toBe(work);
  expect(h.fields.supportingSources.relationships.ports.confirmedLdaIds(clientId, tenantId)).toBe(
    work,
  );
  expect(h.fields.finalSources.alerts.ports.confirmedLdaIds(clientId, tenantId)).toBe(work);
  expect(override.mock.calls).toEqual([
    [clientId, tenantId],
    [clientId, tenantId],
    [clientId, tenantId],
  ]);
  expect(override.mock.contexts).toEqual([h.service, h.service, h.service]);
});

it('facade finance and identity selectors preserve current overrides, input references and Root receiver', () => {
  const h = harness();
  const cached = [7, 2];
  const confirmed = ['4'];
  const ids = [99];
  const override = jest.fn(function (
    this: unknown,
    _cached: number[] | null | undefined,
    _confirmed: string[],
  ) {
    return ids;
  });
  h.subject.pickLdaClientIds = override;
  expect(h.fields.supportingSources.financial.ports.pickLdaClientIds(cached, confirmed)).toBe(ids);
  expect(h.fields.clientSources.identityLda.ports.pickLdaClientIds(cached, confirmed)).toBe(ids);
  expect(override.mock.calls[0]![0]).toBe(cached);
  expect(override.mock.calls[0]![1]).toBe(confirmed);
  expect(override.mock.contexts).toEqual([h.service, h.service]);
});

it('facade optional collaborator callbacks remain lazy after property replacement and retain shared identity', () => {
  const h = harness();
  const replacementOffice = { recommend: jest.fn() };
  const replacementPrepopulation = { prepopulate: jest.fn() };
  const officeReads: string[] = [];
  Object.defineProperty(h.service, 'officeRecommender', {
    configurable: true,
    get: () => {
      officeReads.push('office-read');
      return replacementOffice;
    },
  });
  h.fields.prepopulation = replacementPrepopulation;
  expect(officeReads).toEqual([]);
  expect(h.fields.profileV1.ports.officeRecommender()).toBe(replacementOffice);
  expect(h.fields.supportingSources.relationships.ports.officeRecommender()).toBe(
    replacementOffice,
  );
  expect(officeReads).toEqual(['office-read', 'office-read']);
  expect(h.fields.clientSources.mappingReview.ports.prepopulation()).toBe(replacementPrepopulation);
  h.fields.prepopulation = undefined;
  expect(h.fields.clientSources.mappingReview.ports.prepopulation()).toBeUndefined();
  expect(h.forbidden).not.toHaveBeenCalled();
});

it('facade mapping policy reads the shared mutable exported Set has method at request time with its receiver', () => {
  const h = harness();
  awardSources.add('new-policy-source');
  expect(
    h.fields.clientSources.mappingReview.ports.awardBearingMappingSource('new-policy-source'),
  ).toBe(true);
  const has = jest.spyOn(awardSources, 'has').mockImplementation(function (
    this: unknown,
    source: string,
  ) {
    return source === 'override-source';
  });
  expect(
    h.fields.clientSources.mappingReview.ports.awardBearingMappingSource('override-source'),
  ).toBe(true);
  expect(h.fields.clientSources.mappingReview.ports.awardBearingMappingSource('contracting')).toBe(
    false,
  );
  expect(has.mock.contexts).toEqual([awardSources, awardSources]);
});

it('facade profile, bill and final-source logger callbacks read the current logger and retain its receiver', () => {
  const h = harness();
  const warn = jest.fn(function (this: unknown, ..._args: unknown[]) {});
  const logger = { warn };
  h.fields.logger = logger;
  h.fields.profileV1.ports.warn('profile');
  h.fields.relevantBillDiscovery.ports.warn('bill');
  h.fields.finalSources.regulatory.ports.logger().warn('regulatory');
  h.fields.finalSources.alerts.ports.logger().warn('alerts');
  h.fields.finalSources.portfolioAlerts.ports.logger().warn('portfolio');
  expect(warn.mock.calls).toEqual([
    ['profile'],
    ['bill'],
    ['regulatory'],
    ['alerts'],
    ['portfolio'],
  ]);
  expect(warn.mock.contexts).toEqual([logger, logger, logger, logger, logger]);
  expect(h.warn).not.toHaveBeenCalled();
});

it('facade profile and regulatory budget callbacks use the current Root override without wrapping its work promise', () => {
  const h = harness();
  const work = Promise.resolve(42);
  const override = jest.fn(function <T>(
    this: unknown,
    _label: string,
    _client: string,
    promise: Promise<T>,
  ) {
    return promise;
  });
  h.subject.withSourceBudget = override as unknown as Subject['withSourceBudget'];
  expect(h.fields.profileV1.ports.withSourceBudget('profile-source', clientId, work)).toBe(work);
  expect(
    h.fields.finalSources.regulatory.ports.withSourceBudget('regulatory-source', clientId, work),
  ).toBe(work);
  expect(override.mock.calls).toEqual([
    ['profile-source', clientId, work],
    ['regulatory-source', clientId, work],
  ]);
  expect(override.mock.contexts).toEqual([h.service, h.service]);
});
