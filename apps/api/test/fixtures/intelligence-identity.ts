import { IntelligenceService } from '../../src/intelligence/intelligence.service.js';

export const clientId = '00000000-0000-0000-0000-000000000010';
export const tenantId = '00000000-0000-0000-0000-000000000001';
export const catalogId = 'abcdefab-1234-5678-90ab-abcdefabcdef';
export const now = new Date('2026-10-13T12:00:00.000Z');
export type Profile = Awaited<ReturnType<IntelligenceService['getClientProfile']>>;
export type Subject = Omit<IntelligenceService, never> & {
  pickLdaClientIds(cached: number[] | null | undefined, confirmed: string[]): number[];
  resolveLdaClientIds(client: string, tenant: string): Promise<number[]>;
  confirmedLdaIds(client: string, tenant: string): Promise<number[]>;
  issueCodesForLdaIds(ids: number[]): Promise<string[]>;
  fetchLdaByIds(ids: number[]): Promise<Profile['lda'] | null>;
  isUuid(id: string): boolean;
  fetchContractorById(id: string): Promise<Profile['contracting'] | null>;
  fetchLobbyIntelById(id: string): Promise<Profile['lobbyIntel'] | null>;
  fuzzyMatchLda(name: string): Promise<Profile['lda'] | null>;
  fuzzyMatchContractor(name: string): Promise<Profile['contracting'] | null>;
  fuzzyMatchLobbyIntel(name: string): Promise<Profile['lobbyIntel'] | null>;
  findCompetitors(name: string, codes: string[], ids?: number[]): Promise<Profile['competitors']>;
  capabilityFallbackTerms(tenant: string, client: string): Promise<string[]>;
  findRelevantBills(codes: string[], fallback?: string[]): Promise<Profile['relevantBills']>;
  findActiveRegulations(
    codes: string[],
    fallback?: string[],
  ): Promise<Profile['activeRegulations']>;
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
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider calls forbidden'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
export function clientRow(overrides: Record<string, unknown> = {}) {
  return {
    id: clientId,
    name: 'Acme Research',
    status: 'active',
    ldaClientIds: [],
    description: 'Research client',
    sectorTag: 'SCIENCE',
    submissionTracks: null,
    capabilities: [],
    ...overrides,
  };
}
export function filingRow(overrides: Record<string, unknown> = {}) {
  return {
    filingUuid: 'filing-one',
    registrantId: 41,
    clientId: 7,
    filingType: 'LD-2',
    filingYear: 2026,
    filingPeriod: 'third_quarter',
    income: 10,
    expenses: null,
    dtPosted: now,
    registrantName: 'Research Lobbyists',
    clientName: 'Acme Research',
    issueCodes: ['SCI'],
    governmentEntities: [],
    lobbyists: [],
    lobbyingActivities: [],
    filingDocumentUrl: null,
    ...overrides,
  };
}
export function contractorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: catalogId,
    name: 'Catalog Contractor',
    total_contracts: '120',
    rank_by_contracts: 8,
    no_bid_total: '30',
    yearly_spend_jsonb: [{ year: 2026, amount: 120 }],
    top_agencies_jsonb: [{ name: 'Science Agency', amount: 90 }],
    similarity: 0.7,
    ...overrides,
  };
}
function defaults(operation: string): unknown {
  if (operation === 'client') return clientRow();
  if (operation === 'port:bills') return { total: 0, bills: [] };
  if (operation === 'port:regulations') return { total: 0, documents: [] };
  return [];
}
async function respond(state: State, call: Call): Promise<unknown> {
  state.calls.push(call);
  state.events.push(`start:${call.operation}`);
  for (const resolve of state.signals.get(call.operation) ?? []) resolve();
  state.signals.delete(call.operation);
  const index = state.positions.get(call.operation) ?? 0;
  state.positions.set(call.operation, index + 1);
  let value = defaults(call.operation);
  if (Object.hasOwn(state.options.rows ?? {}, call.operation))
    value = state.options.rows![call.operation];
  if (Object.hasOwn(state.options.results ?? {}, call.operation))
    value = state.options.results![call.operation];
  const queue = state.options.queues?.[call.operation];
  if (queue && index < queue.length) value = queue[index];
  if (Object.hasOwn(state.options.errors ?? {}, call.operation))
    value = state.options.errors![call.operation];
  try {
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
    client: { findFirst: read('client') },
    clientIntelMapping: {
      findMany: jest.fn((input: { where: { source?: string } }) =>
        respond(state, {
          operation: input.where.source ? 'ldaMappings' : 'mappings',
          args: [input],
          scope: 'tenant',
          tenantId: tenant,
          transaction: id,
        }),
      ),
    },
  };
}
function queryOperation(sql: string) {
  if (sql.includes('HAVING MIN(f.dt_posted)')) return 'competitorEntrants';
  if (sql.includes('LIMIT 10')) return 'competitorTop';
  if (sql.includes('FROM federal_contractor')) {
    if (sql.includes('similarity(')) return 'fuzzyContractor';
    return sql.includes('WHERE id =') ? 'contractorId' : 'contractorName';
  }
  if (sql.includes('FROM lobby_intel_mv'))
    return sql.includes('similarity(') ? 'fuzzyLobby' : 'lobbyId';
  if (sql.includes('similarity(c.name,')) return 'fuzzyLda';
  if (sql.includes('SUM(total_filings)')) return 'ldaAggregate';
  if (sql.includes('SELECT DISTINCT unnest(issue_codes)')) return 'issueCodes';
  if (sql.includes('filing_year as year'))
    return sql.includes('ANY(') ? 'ldaYearlySet' : 'ldaYearlyOne';
  throw new Error(`Unexpected identity SQL: ${sql}`);
}
function globalIo(state: State) {
  return {
    ldaFiling: {
      findMany: jest.fn((input: { select?: unknown; where: { clientId: unknown } }) => {
        const operation = input.select
          ? 'detailedFilings'
          : typeof input.where.clientId === 'object'
            ? 'ldaRecentSet'
            : 'ldaRecentOne';
        return respond(state, { operation, args: [input], scope: 'global' });
      }),
    },
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings
        .reduce((text, part, i) => text + (i ? `$${i}` : '') + part, '')
        .replace(/\s+/g, ' ')
        .trim();
      return respond(state, {
        operation: queryOperation(sql),
        args: [strings, ...values],
        scope: 'global',
        query: { sql, strings: Array.from(strings), values },
      });
    }),
  };
}
function ports(state: State, subject: Subject) {
  const read = (operation: string) =>
    jest.fn((...args: unknown[]) => respond(state, { operation, args, scope: 'port' }));
  const terms = read('port:terms'),
    bills = read('port:bills'),
    regulations = read('port:regulations');
  subject.capabilityFallbackTerms = terms as Subject['capabilityFallbackTerms'];
  subject.findRelevantBills = bills as Subject['findRelevantBills'];
  subject.findActiveRegulations = regulations as Subject['findActiveRegulations'];
  return { terms, bills, regulations };
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
  return {
    service,
    subject,
    prisma,
    ports: ports(state, subject),
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
