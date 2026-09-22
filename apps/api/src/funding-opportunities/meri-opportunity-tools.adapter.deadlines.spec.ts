import { MeriOpportunityToolsAdapter } from './meri-opportunity-tools.adapter.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const AS_OF = new Date('2026-09-10T12:00:00.000Z');
const actor = { tenantId: TENANT, userId: 'user-1', role: 'standard_user' as const };

function canonical(deadline: string, title = 'Test opportunity') {
  return {
    id: `sam_gov:${title}`, source: 'sam_gov', sourceRecordId: title, title, agency: 'DOE', sourceUrl: null,
    type: 'solicitation', lifecycle: 'active', postedDate: null, deadline, closeOrArchiveDate: null,
    isPursuable: true, summary: null, naicsCodes: [], pscCodes: [], setAside: null, applicantTypes: [],
    geography: [], value: null, valueBasis: 'not_stated_by_source', sourceFacts: {}, relevanceScore: null,
    matchedSignals: [], eligibility: { state: 'unknown', reason: 'Not assessed' }, clientId: 'client-1',
  };
}

function makeAdapter() {
  const search = jest.fn().mockResolvedValue({
    criteria: {}, opportunities: [canonical('2026-09-20T17:00:00.000Z', 'Soon'), canonical('2026-11-20T17:00:00.000Z', 'Later')],
    page: 1, pageSize: 5, total: 2, totalIsCapped: false, catalogComplete: true,
    counts: { grants: 0, contracts: 2 }, freshness: [], emptyReason: null, profileGaps: null,
    generatedAt: AS_OF.toISOString(),
  });
  const composeActionPlan = jest.fn().mockResolvedValue({
    state: 'available', explanation: 'Plan', plan: { stage: 'solicitation', actions: [], fingerprint: 'fp' },
    acceptance: { wired: true },
  });
  const adapter = new MeriOpportunityToolsAdapter(
    {} as never, { search } as never, { composeActionPlan } as never, {} as never, {} as never,
  );
  (adapter as unknown as { gate: () => Promise<null> }).gate = async () => null;
  return { adapter, composeActionPlan };
}

describe('Meri opportunity adapter schedule deadlines', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  test('off keeps the legacy payload while enforce adds deadline facts and envelope-derived aggregates', async () => {
    const { adapter } = makeAdapter();
    const legacy = await adapter.searchFundingOpportunities(actor, { clientId: 'client-1' }, AS_OF);
    expect(legacy.data?.counts.deadlinesIn30Days).toBeNull();
    expect(legacy.data?.opportunities.every((row) => !('deadline' in row))).toBe(true);
    const legacyContext = await adapter.getOpportunityClientContext(actor, { clientId: 'client-1' }, AS_OF);
    expect(legacyContext.data).toMatchObject({ nextDeadline: null, counts: { deadlinesIn30Days: null } });

    Object.assign(process.env, {
      MERI_EVIDENCE_ACCURACY_MODE: 'enforce', MERI_EVIDENCE_ACCURACY_TENANTS: TENANT,
      MERI_EVIDENCE_ACCURACY_SURFACES: 'chat',
    });
    const enforced = await adapter.searchFundingOpportunities(actor, { clientId: 'client-1' }, AS_OF);
    expect(enforced.data?.counts.deadlinesIn30Days).toBe(1);
    expect(enforced.data?.opportunities[0]).toMatchObject({
      deadline: { at: '2026-09-20T17:00:00.000Z', status: 'open', daysRemaining: 11 },
    });
    const enforcedContext = await adapter.getOpportunityClientContext(actor, { clientId: 'client-1' }, AS_OF);
    expect(enforcedContext.data).toMatchObject({
      counts: { deadlinesIn30Days: 1 },
      nextDeadline: { at: '2026-09-20T17:00:00.000Z', status: 'open', daysRemaining: 11 },
    });
  });

  test('threads off/enforce mode into the action-plan builder', async () => {
    const { adapter, composeActionPlan } = makeAdapter();
    await adapter.buildOpportunityActionPlan(actor, { clientId: 'client-1', source: 'sam_gov', sourceRecordId: 'x' }, AS_OF);
    expect(composeActionPlan.mock.calls[0]?.[6]).toBe('off');
    Object.assign(process.env, {
      MERI_EVIDENCE_ACCURACY_MODE: 'enforce', MERI_EVIDENCE_ACCURACY_TENANTS: TENANT,
      MERI_EVIDENCE_ACCURACY_SURFACES: 'chat',
    });
    await adapter.buildOpportunityActionPlan(actor, { clientId: 'client-1', source: 'sam_gov', sourceRecordId: 'x' }, AS_OF);
    expect(composeActionPlan.mock.calls[1]?.[6]).toBe('enforce');
  });
});