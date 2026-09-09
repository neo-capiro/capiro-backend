jest.mock('../context/context-plane-gateway.service.js', () => ({ ContextPlaneGatewayService: class {} }));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
import { buildModelContextProjection, planMeriTurn, toMeriRetrievalProjection } from './meri-context-plane.service.js';
import type { RetrievalDomain } from '../retrieval/retrieval-v2.types.js';

const source = (domain: RetrievalDomain, returned: number, total: number, inspected: number) => ({
  domain, returned, total, recordsEvaluated: inspected, sourceStatus: 'healthy' as const,
  coverageComplete: true, paginationComplete: true, truncated: false, stopReason: 'complete',
});

it('keeps initial source count scopes through actual model projection and reports omitted records separately', () => {
  const records = Array.from({ length: 40 }, (_, i) => ({ domain: 'clients' as const,
    recordId: `client-${i}`, payload: { body: 'Context record. '.repeat(400) } }));
  records.push({ domain: 'clients', recordId: 'client-small', payload: { body: 'Small factual record.' } });
  const projection = buildModelContextProjection(records);
  expect(projection.truncated).toBe(true);
  const result = toMeriRetrievalProjection({
    plan: planMeriTurn({ task: 'Explain authorization versus appropriation', uiClientId: 'client-a', uiClientName: 'Client A' }),
    context: { resolution: { status: 'resolved', stopReason: 'resolved', subjectScope: { kind: 'client' } },
      retrieval: { coverage: { requestedDomains: ['clients', 'contacts'], searchedDomains: ['clients', 'contacts'],
        requestedEntityCount: 1, searchedEntityCount: 1, recordsEvaluated: 73, recordsReturned: 41,
        paginationComplete: false, unavailableSources: ['contacts'], complete: false, stopReason: 'source_unavailable',
        sources: [source('clients', 41, 103, 73), { ...source('contacts', 0, 0, 0), total: null,
          sourceStatus: 'error', coverageComplete: false, stopReason: 'adapter_execution_failed' }],
      } } }, packet: {}, projectedRecords: projection.records, projectionTruncated: projection.truncated,
  });
  expect(result.plan.requiredDomains).toEqual([]);
  expect(result.coverage).toMatchObject({ recordsReturned: 41, recordsEvaluated: 73,
    recordsDisplayed: projection.records.length, recordsOmitted: 41 - projection.records.length,
    complete: false, missingDomains: ['contacts'] });
  expect(result.coverage.sourceCounts).toEqual([
    { source: 'clients', recordsMatched: 103, recordsEvaluated: 73, recordsReturned: 41,
      recordsDisplayed: projection.records.length, recordsOmitted: 41 - projection.records.length },
    { source: 'contacts', recordsMatched: null, recordsEvaluated: 0, recordsReturned: 0, recordsDisplayed: 0, recordsOmitted: 0 },
  ]);
});

it.each([null, 'client-a'])('does not require unrelated client/contact sources for a generic inquiry (selected client %s)', (uiClientId) => {
  const plan = planMeriTurn({ task: 'Explain authorization versus appropriation', uiClientId, uiClientName: uiClientId ? 'Client A' : null });
  const result = toMeriRetrievalProjection({ plan,
    context: { resolution: { status: 'resolved', stopReason: 'resolved', subjectScope: { kind: plan.subjectScope } } },
    packet: {}, projectedRecords: [], projectionTruncated: false });
  expect(result.plan.requiredDomains).toEqual([]);
  expect(result.plan.requireCompleteCoverage).toBe(false);
});

it('keeps explicitly requested source requirements distinct from exhaustive coverage', () => {
  const plan = planMeriTurn({ task: 'Summarize my email', uiClientId: 'client-a', uiClientName: 'Client A' });
  const result = toMeriRetrievalProjection({ plan,
    context: { resolution: { status: 'resolved', stopReason: 'resolved', subjectScope: { kind: plan.subjectScope } } },
    packet: {}, projectedRecords: [], projectionTruncated: false });
  expect(result.plan.requiredDomains).toEqual(['mail']);
  expect(result.plan.requireCompleteCoverage).toBe(false);
});
