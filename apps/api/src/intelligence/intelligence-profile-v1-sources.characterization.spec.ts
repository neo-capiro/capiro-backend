import type { ProjectionPayload } from '../../test/fixtures/intelligence-profile-v1.projections.js';
import {
  clientId,
  harness,
  installHooks,
  internalAlert,
  now,
  tenantId,
  userId,
  type SourceName,
} from '../../test/fixtures/intelligence-profile-v1.js';

type Payload = ProjectionPayload;
interface FailureCase {
  label: string;
  source?: SourceName;
  io?: string;
}
const slots = [
  'profile',
  'lobbyingRoi',
  'fecMoneyFlow',
  'districtNexus',
  'trackedBills',
  'billRegulationLinks',
  'knowledgeGraph',
  'engagementHealth',
  'exStaffers',
  'commentAlerts',
  'changes',
  'hearings',
  'meetings',
  'mailThreads',
  'doneTasks',
  'debriefs',
  'outreachRecords',
  'mappingRows',
  'districtNexusSpend',
  'overdueComments',
  'competitorLda',
  'contractAwards',
  'alertStates',
  'hearingAlerts',
  'clientRelevantRegulations',
];
const degradable: FailureCase[] = [
  { label: 'lobbyingRoi', source: 'getLobbyingRoi' },
  { label: 'fecMoneyFlow', source: 'getFecMoneyFlow' },
  { label: 'districtNexus', source: 'getDistrictNexus' },
  { label: 'trackedBills', source: 'getTrackedBills' },
  { label: 'billRegulationLinks', source: 'getBillRegulationLinks' },
  { label: 'engagementHealth', source: 'computeEngagementHealth' },
  { label: 'exStaffers', source: 'getExStaffers' },
  { label: 'commentAlerts', source: 'getCommentPeriodAlerts' },
  { label: 'changes', source: 'getChanges' },
  { label: 'hearings', io: 'hearings' },
  { label: 'meetings', io: 'meetings' },
  { label: 'mailThreads', io: 'mailThreads' },
  { label: 'doneTasks', io: 'doneTasks' },
  { label: 'debriefs', io: 'debriefs' },
  { label: 'outreachRecords', io: 'outreachRecords' },
  { label: 'mappingRows', io: 'mappings' },
  { label: 'districtNexusSpend', source: 'getDistrictNexusSpend' },
  { label: 'overdueComments', source: 'getOverdueCommentAlerts' },
  { label: 'competitorLda', source: 'getCompetitorLdaAlerts' },
  { label: 'contractAwards', source: 'getContractAwardAlerts' },
  { label: 'alertStates', io: 'alertStates' },
  { label: 'hearingAlerts', source: 'getHearingAlerts' },
  { label: 'clientRelevantRegulations', source: 'getClientRelevantRegulations' },
];
function budgetSpy(h: ReturnType<typeof harness>) {
  return jest.spyOn(
    h.service as unknown as {
      withSourceBudget(label: string, id: string, work: Promise<unknown>): Promise<unknown>;
    },
    'withSourceBudget',
  );
}
function assertFallback(payload: Payload, label: string) {
  const snapshot = payload.sections.snapshot;
  const financial = payload.sections.financialFootprint;
  const legislative = payload.sections.legislativeRegulatory;
  const activityKeys: Record<string, string> = {
    meetings: 'meetings',
    mailThreads: 'emails',
    doneTasks: 'tasks',
    debriefs: 'debriefs',
    outreachRecords: 'outreach',
  };
  const activityKey = activityKeys[label];
  if (activityKey) {
    const counts = snapshot.activity14d.map((day: Record<string, unknown>) => day[activityKey]);
    expect(counts).toEqual(Array(14).fill(0));
    return;
  }
  switch (label) {
    case 'lobbyingRoi':
      expect(financial.hero).toMatchObject({
        lobbyingTtm: 0,
        obligationsTtm: 0,
        returnRatio: null,
        gap: 0,
      });
      break;
    case 'fecMoneyFlow':
      expect(financial.fecMoneyFlow).toMatchObject({
        mappedEmployer: null,
        summary: { totalAmount: 0 },
        committees: [],
        pacGiving: { tracked: false },
      });
      break;
    case 'districtNexus':
      expect(financial.districtNexus.capabilities).toEqual([]);
      break;
    case 'trackedBills':
      expect(legislative.kanban).toMatchObject({ total: 0, issueCodes: [] });
      break;
    case 'billRegulationLinks':
    case 'clientRelevantRegulations':
      expect(legislative.regulatoryLifecycle).toEqual({
        totalLinkedBills: 0,
        totalRegulations: 0,
        rails: [],
      });
      break;
    case 'engagementHealth':
      expect(snapshot.health).toBeNull();
      break;
    case 'exStaffers':
      expect(payload.sections.relationships.exStafferCount).toBe(0);
      break;
    case 'hearings':
      expect(legislative.hearingsAndMarkups).toEqual([]);
      break;
    case 'mappingRows':
      expect(payload.meta).toMatchObject({ sourceCount: 0, unresolvedMappings: 0 });
      break;
    case 'districtNexusSpend':
      expect(financial.districtNexus.topDistricts).toEqual([]);
      break;
    case 'changes':
      expect(snapshot.changes7dCount).toBe(0);
      expect(snapshot.topAlerts).toEqual([]);
      break;
    case 'commentAlerts':
    case 'overdueComments':
    case 'competitorLda':
    case 'contractAwards':
    case 'alertStates':
    case 'hearingAlerts':
      expect(snapshot.topAlerts).toEqual([]);
      break;
    default:
      throw new Error(`Uncharacterized source ${label}`);
  }
}

installHooks();

it('budgets all 25 slots in exact order and shares one mapping and tracked-bill promise', async () => {
  const h = harness({ sourceResults: { getKnowledgeGraph: new Error('must stay removed') } });
  const budget = budgetSpy(h);
  const payload = await h.profile(userId);
  expect(budget.mock.calls.map(([label]) => label)).toEqual([...slots, 'roiQuarterSeries']);
  expect(budget.mock.calls.every(([, id]) => id === clientId)).toBe(true);
  expect(h.callsOf('mappings')).toHaveLength(1);
  expect(h.sources.getTrackedBills).toHaveBeenCalledTimes(1);
  const tracked = h.sources.getTrackedBills.mock.results[0]!.value;
  expect(budget.mock.calls[4]![2]).toBe(tracked);
  expect(h.sources.getBillRegulationLinks.mock.calls[0]![2]).toBe(tracked);
  expect(h.sources.getHearingAlerts.mock.calls[0]![4]).toBe(tracked);
  expect(budget.mock.calls[17]![2]).toBe(h.prisma.withTenant.mock.results[1]!.value);
  expect(h.events.indexOf('mappings')).toBeLessThan(h.events.indexOf('getTrackedBills'));
  expect(h.sources.getKnowledgeGraph).not.toHaveBeenCalled();
  expect(payload.sections.relationships.scopedGraph).toMatchObject({
    nodes: [],
    edges: [],
    resolutionQuality: { avgConfidence: 0, confirmedCount: 0, unconfirmedCount: 0 },
  });
  expect(payload.meta).toMatchObject({ schema: 'client-profile-v1', sourceCount: 0 });
  expect(payload.generatedAt).toBe(now.toISOString());
  expect(h.warnings).toEqual([]);
});

it.each([null, { id: clientId, name: 'Archived', status: 'archived' }])(
  'rejects missing or archived client %p before launching any source',
  async (client) => {
    const h = harness({ client });
    const budget = budgetSpy(h);
    await expect(h.profile(userId)).rejects.toThrow('Client not found');
    expect(h.calls).toEqual([
      expect.objectContaining({
        operation: 'clientGuard',
        scope: 'tenant',
        tenantId,
        args: [{ where: { id: clientId }, select: { id: true, name: true, status: true } }],
      }),
    ]);
    expect(h.prisma.withTenant).toHaveBeenCalledTimes(1);
    expect(budget).not.toHaveBeenCalled();
    expect(h.recommender.recommend).not.toHaveBeenCalled();
  },
);

it('preserves a fatal tenant client-read failure before all fan-out effects', async () => {
  const error = new Error('client lookup failed');
  const h = harness({ ioErrors: { clientGuard: error } });
  await expect(h.profile()).rejects.toBe(error);
  expect(h.calls.map((call) => call.operation)).toEqual(['clientGuard']);
  expect(h.sources.getClientProfile).not.toHaveBeenCalled();
  expect(h.prisma.committeeHearing.findMany).not.toHaveBeenCalled();
});

it('waits for all fan-out slots but preserves the original fatal profile-spine rejection', async () => {
  const error = new Error('profile spine unavailable');
  const h = harness({
    sourceResults: { getClientProfile: error, getLobbyingRoi: new Error('optional failure') },
  });
  const budget = budgetSpy(h);
  await expect(h.profile(userId)).rejects.toBe(error);
  expect(budget.mock.calls.map(([label]) => label)).toEqual(slots);
  expect(h.callsOf('clientGuard')[0]).toMatchObject({ scope: 'tenant', tenantId });
  expect(h.callsOf('mappings')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    args: [{ where: { clientId }, select: { source: true, confirmed: true, externalId: true } }],
  });
  expect(h.recommender.recommend).not.toHaveBeenCalled();
  expect(h.sources.buildRoiQuarterSeries).not.toHaveBeenCalled();
  expect(h.warnings).toEqual([]);
});

it.each(degradable)(
  'degrades $label to its observable fallback and exact warning',
  async ({ label, source, io }) => {
    const error = new Error(`synthetic ${label} failure`);
    const h = harness(
      source ? { sourceResults: { [source]: error } } : { ioErrors: { [io!]: error } },
    );
    const payload = await h.profile(userId);
    expect(payload.client).toEqual({ id: clientId, name: 'Acme Defense' });
    expect(payload.meta.sectionOrder).toEqual([
      'snapshot',
      'financialFootprint',
      'legislativeRegulatory',
      'relationships',
    ]);
    assertFallback(payload, label);
    expect(h.warnings).toEqual([
      `profile-v1 source "${label}" failed for client ${clientId}: synthetic ${label} failure`,
    ]);
    expect(h.sources.buildRoiQuarterSeries).toHaveBeenCalledTimes(1);
  },
);

it('builds all four sections when every reachable optional fan-out source fails', async () => {
  const sourceResults: Partial<Record<SourceName, Error>> = {};
  const ioErrors: Record<string, Error> = {};
  for (const { label, source, io } of degradable) {
    if (source) sourceResults[source] = new Error(label);
    else ioErrors[io!] = new Error(label);
  }
  const h = harness({ sourceResults, ioErrors });
  const payload = await h.profile(userId);
  expect(Object.keys(payload.sections)).toEqual([
    'snapshot',
    'financialFootprint',
    'legislativeRegulatory',
    'relationships',
  ]);
  for (const { label } of degradable) assertFallback(payload, label);
  expect(h.warnings).toEqual(
    degradable.map(
      ({ label }) => `profile-v1 source "${label}" failed for client ${clientId}: ${label}`,
    ),
  );
  expect(payload.sections.financialFootprint.series.quarterSeries).toEqual([]);
});

it('does not query per-user alert state when the public profile request has no actor', async () => {
  const h = harness({
    sourceResults: { getHearingAlerts: [internalAlert()] },
    rows: { alertStates: [{ alertId: 'alert-one', state: 'dismissed', snoozedUntil: null }] },
  });
  const payload = await h.profile();
  expect(h.callsOf('alertStates')).toEqual([]);
  expect(h.tenantTx.alertState.findMany).not.toHaveBeenCalled();
  expect(payload.sections.snapshot.topAlerts).toEqual([
    expect.objectContaining({ id: 'alert-one', state: null }),
  ]);
  expect(payload.sections.snapshot.alertsHiddenCount).toBe(0);
});

it('scopes optional alert-state I/O to the actor and client and applies its dismissal', async () => {
  const h = harness({
    sourceResults: { getHearingAlerts: [internalAlert()] },
    rows: { alertStates: [{ alertId: 'alert-one', state: 'dismissed', snoozedUntil: null }] },
  });
  const payload = await h.profile(userId);
  expect(h.callsOf('alertStates')).toEqual([
    expect.objectContaining({
      scope: 'tenant',
      tenantId,
      args: [
        { where: { userId, clientId }, select: { alertId: true, state: true, snoozedUntil: true } },
      ],
    }),
  ]);
  expect(payload.sections.snapshot.topAlerts).toEqual([]);
  expect(payload.sections.snapshot.alertsHiddenCount).toBe(0);
});
