import { Logger } from '@nestjs/common';
import { IntelligenceService } from '../../src/intelligence/intelligence.service.js';

export const tenantId = '00000000-0000-0000-0000-000000000001';
export const clientId = '00000000-0000-0000-0000-000000000010';
export const userId = 'user-one';
export const contractorId = 'abcdefab-1234-5678-90ab-abcdefabcdef';
export const now = new Date('2026-10-13T12:00:00.000Z');
export const until = new Date('2026-10-27T12:00:00.000Z');
export const since = new Date('2026-10-06T12:00:00.000Z');
export const day = 86_400_000;
export type RelevantRegulations = Awaited<
  ReturnType<IntelligenceService['getClientRelevantRegulations']>
>;
export type TrackedBills = Awaited<ReturnType<IntelligenceService['getTrackedBills']>>;
export type Subject = Omit<IntelligenceService, never> & {
  findActiveRegulations(
    codes: string[],
    terms?: string[],
  ): Promise<{
    total: number;
    documents: Array<{
      id: string;
      documentNumber: string;
      type: string;
      title: string;
      agencyNames: string[];
      topics: string[];
      commentEndDate: Date | null;
      publicationDate: Date;
      significantRule: boolean;
      htmlUrl: string | null;
    }>;
  }>;
  getClientRelevantRegulations(
    client: string,
    tenant: string,
    date: Date,
  ): Promise<RelevantRegulations>;
  alertCountdownLabel(days: number | null): string | null;
  getClientIssueCodes(client: string, tenant: string): Promise<string[]>;
  resolveContractorUeisForAlerts(ids: string[]): Promise<Map<string, string | null>>;
  withSourceBudget<T>(label: string, client: string, work: Promise<T>): Promise<T>;
  buildRegulatoryLifecycle(
    links: Awaited<ReturnType<IntelligenceService['getBillRegulationLinks']>>,
    relevant: RelevantRegulations,
    date: Date,
  ): Awaited<ReturnType<IntelligenceService['getClientRegulatoryProfile']>>['regulatoryLifecycle'];
  confirmedLdaIds(client: string, tenant: string): Promise<number[]>;
  issueCodesForLdaIds(ids: number[]): Promise<string[]>;
};
export interface Call {
  operation: string;
  scope: 'tenant' | 'global' | 'port';
  args: unknown[];
  tenantId?: string;
  transaction?: number;
  query?: { sql: string; strings: readonly string[]; values: unknown[] };
}
export interface Options {
  rows?: Record<string, unknown>;
  results?: Record<string, unknown>;
  queues?: Record<string, unknown[]>;
  errors?: Record<string, unknown>;
}
interface State {
  options: Options;
  calls: Call[];
  events: string[];
  positions: Map<string, number>;
  signals: Map<string, Array<() => void>>;
}
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}
export function installHooks() {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider I/O forbidden'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
export function clientRow(overrides: Record<string, unknown> = {}) {
  return {
    id: clientId,
    name: 'Acme Defense',
    status: 'active',
    sectorTag: null,
    uei: null,
    capabilities: [{ sector: null, name: 'Hypersonic Systems', tags: [] }],
    ...overrides,
  };
}
export function regulationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-one',
    documentNumber: '2026-100',
    type: 'PROPOSED_RULE',
    title: 'Rule title',
    agencyNames: [],
    topics: ['hypersonic'],
    commentEndDate: until,
    publicationDate: now,
    effectiveDate: null,
    significantRule: false,
    htmlUrl: null,
    ...overrides,
  };
}
export function rawRegulationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-one',
    document_number: '2026-100',
    type: 'PROPOSED_RULE',
    title: 'Rule title',
    agency_names: [],
    topics: ['hypersonic'],
    comment_end_date: until,
    publication_date: now,
    significant_rule: false,
    html_url: null,
    ...overrides,
  };
}
export function hearingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hearing-one',
    title: 'Markup of 119-hr-1',
    committeeName: 'Armed Services',
    chamber: 'House',
    type: null,
    date: new Date('2026-10-14T00:00:00.000Z'),
    time: null,
    ...overrides,
  };
}
export function trackedBill(overrides: Record<string, unknown> = {}) {
  return {
    identifier: '119-hr-1',
    title: 'Research bill',
    latestActionDate: null,
    latestActionText: null,
    sponsorName: null,
    sponsorParty: null,
    subjectNames: [],
    ...overrides,
  };
}
function defaults(operation: string): unknown {
  if (operation === 'client') return clientRow();
  if (operation === 'contractMapping') return null;
  if (operation === 'port:tracked') return { total: 0, bills: [] };
  if (operation === 'port:links') return { links: [], totalBills: 0, totalRegulations: 0 };
  if (operation === 'stateUpsert') return { id: 'stored-state' };
  if (operation === 'stateDelete') return { count: 0 };
  if (operation === 'changeUpsert') return {};
  return [];
}
async function respond(state: State, call: Call): Promise<unknown> {
  state.calls.push(call);
  state.events.push(`start:${call.operation}`);
  for (const resolve of state.signals.get(call.operation) ?? []) resolve();
  state.signals.delete(call.operation);
  const index = state.positions.get(call.operation) ?? 0;
  state.positions.set(call.operation, index + 1);
  try {
    if (Object.hasOwn(state.options.errors ?? {}, call.operation))
      throw state.options.errors![call.operation];
    let value = defaults(call.operation);
    if (Object.hasOwn(state.options.rows ?? {}, call.operation))
      value = state.options.rows![call.operation];
    if (Object.hasOwn(state.options.results ?? {}, call.operation))
      value = state.options.results![call.operation];
    const queue = state.options.queues?.[call.operation];
    if (queue && index < queue.length) value = queue[index];
    if (typeof value === 'function') value = (value as (input: Call) => unknown)(call);
    if (value instanceof Error) throw value;
    const result = await value;
    state.events.push(`done:${call.operation}`);
    return result;
  } catch (error) {
    state.events.push(`error:${call.operation}`);
    throw error;
  }
}
function tenantIo(state: State, tenant: string, id: number) {
  const read = (operation: string) =>
    jest.fn((...args: unknown[]) =>
      respond(state, { operation, args, scope: 'tenant', tenantId: tenant, transaction: id }),
    );
  return {
    client: { findFirst: read('client'), findMany: read('clients') },
    clientIntelMapping: { findFirst: read('contractMapping') },
    alertState: { upsert: read('stateUpsert'), deleteMany: read('stateDelete') },
  };
}
function globalIo(state: State) {
  const read = (operation: string) =>
    jest.fn((...args: unknown[]) => respond(state, { operation, args, scope: 'global' }));
  return {
    federalRegisterDocument: { findMany: read('documents') },
    stateRule: { findMany: read('stateRules') },
    committeeHearing: { findMany: read('hearings') },
    ldaFiling: { findMany: read('filings') },
    federalContractor: { findMany: read('contractors') },
    federalAward: { findMany: read('awards') },
    intelligenceChange: { upsert: read('changeUpsert') },
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings
        .reduce((text, part, i) => text + (i ? `$${i}` : '') + part, '')
        .replace(/\s+/g, ' ')
        .trim();
      const operation = sql.includes('FROM lda_issue_code')
        ? 'issueNames'
        : sql.includes('SELECT COUNT(*)')
          ? 'regulationCount'
          : sql.includes('FROM federal_register_document')
            ? 'activeDocuments'
            : null;
      if (!operation) throw new Error(`Unexpected regulatory SQL: ${sql}`);
      return respond(state, {
        operation,
        args: [strings, ...values],
        scope: 'global',
        query: { sql, strings: Array.from(strings), values },
      });
    }),
  };
}
function sourcePorts(state: State, subject: Subject) {
  const read = (operation: string) =>
    jest.fn(function (this: unknown, ...args: unknown[]) {
      return respond(state, { operation, args, scope: 'port' });
    });
  const confirmed = read('port:confirmed'),
    codes = read('port:codes'),
    tracked = read('port:tracked'),
    links = read('port:links');
  subject.confirmedLdaIds = confirmed as Subject['confirmedLdaIds'];
  subject.issueCodesForLdaIds = codes as Subject['issueCodesForLdaIds'];
  subject.getTrackedBills = tracked as IntelligenceService['getTrackedBills'];
  subject.getBillRegulationLinks = links as IntelligenceService['getBillRegulationLinks'];
  return { confirmed, codes, tracked, links };
}
export function harness(options: Options = {}) {
  const state: State = { options, calls: [], events: [], positions: new Map(), signals: new Map() };
  let nextId = 0;
  const prisma = {
    ...globalIo(state),
    withTenant: jest.fn(
      async (tenant: string, run: (tx: ReturnType<typeof tenantIo>) => unknown) => {
        const id = ++nextId;
        state.calls.push({
          operation: 'withTenant',
          scope: 'tenant',
          args: [tenant, run],
          tenantId: tenant,
          transaction: id,
        });
        state.events.push(`tenant:${id}:begin`);
        try {
          const result = await run(tenantIo(state, tenant, id));
          state.events.push(`tenant:${id}:commit`);
          return result;
        } catch (error) {
          state.events.push(`tenant:${id}:rollback`);
          throw error;
        }
      },
    ),
  };
  const service = new IntelligenceService(prisma as never, undefined, undefined);
  const subject = service as unknown as Subject;
  const warnings: string[] = [];
  jest.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(String(args[0]));
  });
  return {
    service,
    subject,
    prisma,
    warnings,
    ports: sourcePorts(state, subject),
    calls: state.calls,
    events: state.events,
    callsOf: (operation: string) => state.calls.filter((call) => call.operation === operation),
    started: (operation: string) => {
      if (state.calls.some((call) => call.operation === operation)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        state.signals.set(operation, [...(state.signals.get(operation) ?? []), resolve]);
      });
    },
  };
}
