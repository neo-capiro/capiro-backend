import { IntelligenceService } from '../../src/intelligence/intelligence.service.js';
import type { OfficeRecommendation } from '../../src/intelligence/office-recommender.service.js';
import type { ProjectionPayload } from './intelligence-profile-v1.projections.js';
type ProfilePromise = Promise<ProjectionPayload>;

export const clientId = '00000000-0000-0000-0000-000000000010';
export const tenantId = '00000000-0000-0000-0000-000000000001';
export const userId = 'actor-one';
export const now = new Date('2026-10-13T12:00:00.000Z');
export const sourceNames = [
  'getClientProfile',
  'getLobbyingRoi',
  'getFecMoneyFlow',
  'getDistrictNexus',
  'getTrackedBills',
  'getBillRegulationLinks',
  'getKnowledgeGraph',
  'computeEngagementHealth',
  'getExStaffers',
  'getCommentPeriodAlerts',
  'getChanges',
  'getDistrictNexusSpend',
  'getOverdueCommentAlerts',
  'getCompetitorLdaAlerts',
  'getContractAwardAlerts',
  'getHearingAlerts',
  'getClientRelevantRegulations',
  'buildRoiQuarterSeries',
] as const;
export type SourceName = (typeof sourceNames)[number];
type SourceFunction = (...args: unknown[]) => Promise<unknown>;
export interface Options {
  client?: { id: string; name: string; status?: string } | null;
  rows?: Record<string, unknown[]>;
  sourceResults?: Partial<Record<SourceName, unknown | Error | ((...args: unknown[]) => unknown)>>;
  recommender?: false;
  recommendations?: OfficeRecommendation[];
  recommenderError?: Error;
  committeeRows?: Array<{ committee_name: string; committee_code: string | null }>;
  committeeError?: Error;
  ioErrors?: Record<string, Error>;
  ioResults?: Record<string, unknown>;
}
export interface Call {
  operation: string;
  args: unknown[];
  scope: 'tenant' | 'global' | 'source' | 'recommender';
  tenantId?: string;
  transaction?: number;
}

export function profileSpine(overrides: Record<string, unknown> = {}) {
  return {
    lda: { matched: false, yearlySpend: [], totalSpend: 0, totalSpending: 0, totalFilings: 0 },
    contracting: { matched: false, yearlySpend: [], totalObligations: 0 },
    lobbyIntel: { matched: false, trajectory: null, growthRate: null, totalSpending: 0 },
    aiSummary: null,
    ...overrides,
  };
}
export function trackedBill(overrides: Record<string, unknown> = {}) {
  return {
    identifier: '119-hr-1234',
    title: 'Research Authorization Act',
    latestActionDate: new Date('2026-09-01T00:00:00.000Z'),
    latestActionText: 'Introduced in House',
    sponsorName: 'Rep. Example',
    sponsorParty: 'R',
    subjectNames: ['Research'],
    congress: 119,
    billType: 'hr',
    billNumber: '1234',
    introducedDate: new Date('2026-01-01T00:00:00.000Z'),
    cosponsorsCount: 0,
    isManual: false,
    ...overrides,
  };
}
export function hearing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hearing-one',
    committeeName: 'Science',
    committeeCode: 'HSCI',
    chamber: 'House',
    title: 'H.R. 1234 markup',
    date: new Date('2026-10-14T00:00:00.000Z'),
    time: '10:00',
    type: 'Markup',
    ...overrides,
  };
}
export function recommendation(
  overrides: Partial<OfficeRecommendation> = {},
): OfficeRecommendation {
  return {
    memberId: 'E000001',
    office: 'Rep. Example',
    party: 'R',
    state: 'VA-08',
    chamber: 'House',
    committee: 'Science',
    score: 0.6,
    tags: ['committee'],
    billCount: 1,
    ...overrides,
  };
}
export function internalAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-one',
    type: 'hearing_upcoming',
    severity: 'notable',
    title: 'Upcoming hearing',
    subtitle: 'Science',
    when: '2026-10-14T00:00:00.000Z',
    countdownDays: 1,
    countdownLabel: '1d left',
    href: '/intelligence/changes',
    _urgencyScore: 90,
    _typeRank: 2,
    ...overrides,
  };
}
function sourceDefaults(): Record<SourceName, unknown> {
  return {
    getClientProfile: profileSpine(),
    getLobbyingRoi: {
      clientId,
      clientName: 'Acme Defense',
      mappedLdaClientId: null,
      mappedLdaClientIds: [],
      mappedContractorId: null,
      lobbySpend: 0,
      contractWins: 0,
      roi: null,
      gap: 0,
    },
    getFecMoneyFlow: {
      mappedEmployer: null,
      contributionType: 'individual_employer_linked',
      summary: {
        totalContributions: 0,
        totalAmount: 0,
        committeeCount: 0,
        candidateCount: 0,
        memberCount: 0,
        billCount: 0,
      },
      committees: [],
      pacGiving: {
        tracked: false,
        committees: [],
        summary: { totalAmount: 0, disbursementCount: 0, recipientCount: 0 },
      },
    },
    getDistrictNexus: { topDistricts: [], capabilities: [] },
    getTrackedBills: { total: 0, issueCodes: [], bills: [] },
    getBillRegulationLinks: { links: [], totalBills: 0, totalRegulations: 0 },
    getKnowledgeGraph: {
      nodes: [],
      edges: [],
      resolutionQuality: { avgConfidence: 0, confirmedCount: 0, unconfirmedCount: 0 },
    },
    computeEngagementHealth: {
      score: 0,
      trend: 'stable',
      confidence: 0,
      components: { recency: 0, engagementVolume: 0, completionRate: 0 },
    },
    getExStaffers: { total: 0, lobbyists: [] },
    getCommentPeriodAlerts: { alerts: [] },
    getChanges: [],
    getDistrictNexusSpend: {
      linked: false,
      reason: 'no_confirmed_contracting_mapping',
      contractorNames: [],
      totalAwards: 0,
      totalAmount: 0,
      districts: [],
      unmappedAmount: 0,
    },
    getOverdueCommentAlerts: [],
    getCompetitorLdaAlerts: [],
    getContractAwardAlerts: [],
    getHearingAlerts: [],
    getClientRelevantRegulations: [],
    buildRoiQuarterSeries: [],
  };
}
function tenantModels(options: Options) {
  const rows = (key: string) => options.rows?.[key] ?? [];
  return {
    client: {
      findFirst: jest.fn(async (_input?: unknown) =>
        options.client === null ? null : (options.client ?? { id: clientId, name: 'Acme Defense' }),
      ),
      findMany: jest.fn(async (_input?: unknown) => [{ id: clientId }]),
    },
    clientIntelMapping: {
      findMany: jest.fn(async (_input?: unknown) => rows('mappings')),
      findFirst: jest.fn(async (_input?: unknown) => null),
    },
    meeting: { findMany: jest.fn(async (_input?: unknown) => rows('meetings')) },
    mailThread: { findMany: jest.fn(async (_input?: unknown) => rows('mailThreads')) },
    engagementTask: { findMany: jest.fn(async (_input?: unknown) => rows('doneTasks')) },
    meetingDebrief: { findMany: jest.fn(async (_input?: unknown) => rows('debriefs')) },
    outreachRecord: { findMany: jest.fn(async (_input?: unknown) => rows('outreachRecords')) },
    alertState: { findMany: jest.fn(async (_input?: unknown) => rows('alertStates')) },
  };
}
const modelOperations = {
  client: { findFirst: 'clientGuard', findMany: 'clients' },
  clientIntelMapping: { findMany: 'mappings', findFirst: 'mappingFirst' },
  meeting: { findMany: 'meetings' },
  mailThread: { findMany: 'mailThreads' },
  engagementTask: { findMany: 'doneTasks' },
  meetingDebrief: { findMany: 'debriefs' },
  outreachRecord: { findMany: 'outreachRecords' },
  alertState: { findMany: 'alertStates' },
};
function scopedModels(
  base: ReturnType<typeof tenantModels>,
  capture: (call: Call) => void,
  tenant: string,
  transaction: number,
  options: Options,
) {
  return Object.fromEntries(
    Object.entries(base).map(([model, methods]) => [
      model,
      Object.fromEntries(
        Object.entries(methods).map(([method, fn]) => [
          method,
          (input: unknown) => {
            const operation = (modelOperations as Record<string, Record<string, string>>)[model]![
              method
            ]!;
            capture({ operation, args: [input], scope: 'tenant', tenantId: tenant, transaction });
            return options.ioResults && operation in options.ioResults
              ? Promise.resolve(options.ioResults[operation])
              : fn(input);
          },
        ]),
      ),
    ]),
  );
}
function installSources(
  service: IntelligenceService,
  options: Options,
  capture: (call: Call) => void,
) {
  const defaults = sourceDefaults();
  const typed = service as unknown as Record<SourceName, SourceFunction>;
  const sources = {} as Record<SourceName, jest.SpyInstance<Promise<unknown>, unknown[]>>;
  for (const name of sourceNames)
    sources[name] = jest.spyOn(typed, name).mockImplementation(async (...args: unknown[]) => {
      capture({ operation: name, args, scope: 'source' });
      const result =
        options.sourceResults && name in options.sourceResults
          ? options.sourceResults[name]
          : defaults[name];
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result(...args) : result;
    });
  return sources;
}
function callSignals(calls: Call[]) {
  const waiting = new Map<string, Array<() => void>>();
  return {
    started: (operation: string) =>
      calls.some((call) => call.operation === operation)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiting.set(operation, [...(waiting.get(operation) ?? []), resolve]);
          }),
    notify: (operation: string) => {
      const callbacks = waiting.get(operation) ?? [];
      waiting.delete(operation);
      for (const resolve of callbacks) resolve();
    },
  };
}
export function harness(options: Options = {}) {
  const calls: Call[] = [],
    events: string[] = [],
    warnings: string[] = [];
  const signals = callSignals(calls);
  const capture = (call: Call) => {
    calls.push(call);
    events.push(call.operation);
    signals.notify(call.operation);
    if (options.ioErrors?.[call.operation]) throw options.ioErrors[call.operation];
  };
  const tenantTx = tenantModels(options);
  let transaction = 0;
  const prisma = {
    withTenant: jest.fn(async (tenant: string, callback: (tx: unknown) => Promise<unknown>) => {
      const id = ++transaction;
      events.push(`scope:${tenant}:${id}`);
      return callback(scopedModels(tenantTx, capture, tenant, id, options));
    }),
    committeeHearing: {
      findMany: jest.fn(async (...args: unknown[]) => {
        capture({ operation: 'hearings', args, scope: 'global' });
        return options.ioResults && 'hearings' in options.ioResults
          ? options.ioResults.hearings
          : (options.rows?.hearings ?? []);
      }),
    },
    $queryRaw: jest.fn(async (...args: unknown[]) => {
      capture({ operation: 'committeeJoin', args, scope: 'global' });
      if (options.committeeError) throw options.committeeError;
      return options.ioResults && 'committeeJoin' in options.ioResults
        ? options.ioResults.committeeJoin
        : (options.committeeRows ?? []);
    }),
    $queryRawUnsafe: jest.fn(async (...args: unknown[]) => {
      capture({ operation: 'raw', args, scope: 'global' });
      return [];
    }),
    $executeRawUnsafe: jest.fn(async (...args: unknown[]) => {
      capture({ operation: 'execute', args, scope: 'global' });
      return 0;
    }),
  };
  const recommender = {
    recommend: jest.fn(async (...args: unknown[]) => {
      capture({ operation: 'recommend', args, scope: 'recommender' });
      if (options.recommenderError) throw options.recommenderError;
      return options.ioResults && 'recommend' in options.ioResults
        ? options.ioResults.recommend
        : (options.recommendations ?? []);
    }),
  };
  const service = new IntelligenceService(
    prisma as never,
    undefined,
    options.recommender === false ? undefined : (recommender as never),
  );
  const sources = installSources(service, options, capture);
  const logger = (service as unknown as { logger: { warn(message: string): void } }).logger;
  jest.spyOn(logger, 'warn').mockImplementation((message: string) => {
    warnings.push(message);
    events.push('warning');
  });
  return {
    service,
    prisma,
    tenantTx,
    recommender,
    sources,
    calls,
    events,
    warnings,
    started: signals.started,
    callsOf: (operation: string) => calls.filter((call) => call.operation === operation),
    profile: (actor?: string) =>
      service.getClientProfileV1(clientId, tenantId, actor) as unknown as ProfilePromise,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
export function installHooks() {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Provider calls forbidden by characterization');
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
