import { IntelligenceService } from './intelligence.service.js';
import {
  clientId,
  harness,
  installHooks,
  tenantId,
  type Fields,
} from '../../test/fixtures/intelligence-facade-compatibility.js';

installHooks();

it('facade prototype methods borrowed onto another service use that receiver and its constructed owner', async () => {
  const first = harness();
  const second = harness();
  const sentinel = { receiver: 'second-service' };
  const output = Promise.resolve(sentinel) as unknown as ReturnType<
    IntelligenceService['getClientProfile']
  >;
  const firstDelegate = jest
    .spyOn(first.fields.clientSources.identityProfile, 'getClientProfile')
    .mockReturnValue(output);
  const secondDelegate = jest
    .spyOn(second.fields.clientSources.identityProfile, 'getClientProfile')
    .mockReturnValue(output);
  const borrowed = IntelligenceService.prototype.getClientProfile;
  expect(await borrowed.call(second.service, clientId, tenantId)).toBe(sentinel);
  expect(firstDelegate).not.toHaveBeenCalled();
  expect(secondDelegate).toHaveBeenCalledWith(clientId, tenantId);
  expect(secondDelegate.mock.contexts[0]).toBe(second.fields.clientSources.identityProfile);
  expect(first.forbidden).not.toHaveBeenCalled();
  expect(second.forbidden).not.toHaveBeenCalled();
});

it('facade constructor callbacks resolve subclass method overrides on the actual subclass receiver', () => {
  const h = harness();
  const work = Promise.resolve({ total: 0, issueCodes: [], bills: [] });
  const calls: Array<{ receiver: unknown; client: string; tenant?: string }> = [];
  class Derived extends IntelligenceService {
    override getTrackedBills(client: string, tenant?: string) {
      calls.push({ receiver: this, client, tenant });
      return work;
    }
  }
  const service = new Derived(
    h.prisma as never,
    h.prepopulation as never,
    h.officeRecommender as never,
  );
  const fields = service as unknown as Fields;
  expect(fields.profileV1.ports.getTrackedBills(clientId, tenantId)).toBe(work);
  expect(fields.supportingSources.relationships.ports.getTrackedBills(clientId, tenantId)).toBe(
    work,
  );
  expect(calls).toEqual([
    { receiver: service, client: clientId, tenant: tenantId },
    { receiver: service, client: clientId, tenant: tenantId },
  ]);
  expect(h.forbidden).not.toHaveBeenCalled();
});
