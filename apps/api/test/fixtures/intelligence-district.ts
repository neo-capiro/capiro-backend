import { Prisma } from '@prisma/client';
import { IntelligenceService } from '../../src/intelligence/intelligence.service.js';

jest.mock('../../src/embeddings/embedder.js', () => {
  const actual = jest.requireActual<typeof import('../../src/embeddings/embedder.js')>(
    '../../src/embeddings/embedder.js',
  );
  return { ...actual, embedText: jest.fn().mockRejectedValue(new Error('Provider forbidden')) };
});

export const tenantId = '00000000-0000-0000-0000-000000000001';
export const clientId = '00000000-0000-0000-0000-000000000010';
export const contractorId = '00000000-0000-0000-0000-000000000020';
export const ownUei = 'ABCDEF123456';
export const now = new Date('2026-10-13T12:00:00.000Z');
export type SpendResult = Awaited<ReturnType<IntelligenceService['getDistrictNexusSpend']>>;
export type LinkedSpend = Extract<SpendResult, { linked: true }>;
export interface Call {
  operation: string;
  scope: 'tenant' | 'global';
  args: unknown[];
  tenantId?: string;
  transaction?: number;
  query?: { kind: 'tagged' | 'prisma'; sql: string; text: string; values: unknown[]; raw: unknown };
}
export interface Options {
  rows?: Record<string, unknown>;
  errors?: Record<string, unknown>;
  queues?: Record<string, unknown[]>;
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
export function capability(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cap-one',
    name: 'Research',
    sector: 'DEFENSE',
    districtNexus: 'VA-02',
    existingContracts: null,
    ...overrides,
  };
}
export function mapping(overrides: Record<string, unknown> = {}) {
  return {
    externalId: contractorId,
    externalName: 'Acme Research',
    matchBasis: 'exact_legal_name',
    matchTier: 1,
    ...overrides,
  };
}
export function census(overrides: Record<string, unknown> = {}) {
  return {
    id: 'census-va-2',
    congress: 119,
    state: 'VA',
    district: '2',
    total_population: 800000,
    median_household_income: 75000,
    labor_force_size: 400000,
    unemployment_rate: 0.04,
    percent_veteran: 0.09,
    top_industries: ['Research'],
    data_year: 2024,
    ...overrides,
  };
}
export function spendRow(overrides: Record<string, unknown> = {}) {
  return { pop_state: 'VA', pop_district: '02', award_count: 3n, total_amount: 1200, ...overrides };
}
export function member(overrides: Record<string, unknown> = {}) {
  return {
    bioguideId: 'H000001',
    fullName: 'Representative Example',
    party: 'I',
    state: 'Virginia',
    district: 2 as number | null,
    chamber: 'house',
    ...overrides,
  };
}
export function installHooks() {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    jest.setSystemTime(now);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fetch forbidden'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
interface State {
  options: Options;
  calls: Call[];
  events: string[];
  positions: Map<string, number>;
  signals: Map<string, Array<() => void>>;
}
function capture(state: State, call: Call) {
  state.calls.push(call);
  state.events.push(call.operation);
  state.signals.get(call.operation)?.forEach((resolve) => resolve());
  state.signals.delete(call.operation);
}
async function respond(state: State, call: Call, fallback: unknown = []) {
  capture(state, call);
  if (Object.hasOwn(state.options.errors ?? {}, call.operation))
    throw state.options.errors![call.operation];
  const queue = state.options.queues?.[call.operation];
  const index = state.positions.get(call.operation) ?? 0;
  let value = fallback;
  if (queue && index < queue.length) {
    state.positions.set(call.operation, index + 1);
    value = queue[index];
  } else if (Object.hasOwn(state.options.rows ?? {}, call.operation))
    value = state.options.rows![call.operation];
  if (value instanceof Error) throw value;
  return typeof value === 'function' ? (value as (call: Call) => unknown)(call) : value;
}
function queryIo(state: State) {
  return jest.fn((...args: unknown[]) => {
    const tagged = Array.isArray(args[0]);
    const sql = tagged
      ? Prisma.sql(args[0] as TemplateStringsArray, ...args.slice(1))
      : (args[0] as Prisma.Sql);
    const operation = sql.sql.includes('FROM census_district')
      ? 'census'
      : sql.sql.includes('FROM federal_award')
        ? 'spend'
        : 'unknownQuery';
    return respond(state, {
      operation,
      scope: 'global',
      args,
      query: {
        kind: tagged ? 'tagged' : 'prisma',
        sql: sql.sql,
        text: sql.text,
        values: sql.values,
        raw: args[0],
      },
    });
  });
}
function tenantIo(state: State, tenant: string, transaction: number) {
  const read = (operation: string, fallback: unknown = []) =>
    jest.fn((...args: unknown[]) =>
      respond(state, { operation, scope: 'tenant', args, tenantId: tenant, transaction }, fallback),
    );
  return {
    clientCapability: { findMany: read('capabilities') },
    clientIntelMapping: { findMany: read('mappings') },
    client: { findFirst: read('client', { uei: null }) },
  };
}
export function harness(options: Options = {}) {
  const state: State = { options, calls: [], events: [], positions: new Map(), signals: new Map() };
  const transactions: Array<{
    id: number;
    tenantId: string;
    tx: ReturnType<typeof tenantIo>;
    outcome?: string;
  }> = [];
  const prisma = {
    $queryRaw: queryIo(state),
    federalContractor: {
      findMany: jest.fn((...args: unknown[]) =>
        respond(state, { operation: 'contractors', scope: 'global', args }),
      ),
    },
    congressMember: {
      findMany: jest.fn((...args: unknown[]) =>
        respond(state, { operation: 'members', scope: 'global', args }),
      ),
    },
    withTenant: jest.fn(
      async <T>(tenant: string, work: (tx: ReturnType<typeof tenantIo>) => Promise<T>) => {
        const record = {
          id: transactions.length + 1,
          tenantId: tenant,
          tx: tenantIo(state, tenant, transactions.length + 1),
          outcome: '',
        };
        transactions.push(record);
        capture(state, {
          operation: 'withTenant',
          scope: 'tenant',
          tenantId: tenant,
          transaction: record.id,
          args: [tenant, work],
        });
        state.events.push('tenant:begin');
        try {
          const result = await work(record.tx);
          record.outcome = 'commit';
          state.events.push('tenant:commit');
          return result;
        } catch (error) {
          record.outcome = 'rollback';
          state.events.push('tenant:rollback');
          throw error;
        }
      },
    ),
  };
  const service = new IntelligenceService(
    prisma as unknown as ConstructorParameters<typeof IntelligenceService>[0],
    undefined,
    undefined,
  );
  const started = (operation: string): Promise<void> => {
    if (state.calls.some((call) => call.operation === operation)) return Promise.resolve();
    return new Promise((resolve) => {
      const pending = state.signals.get(operation) ?? [];
      pending.push(resolve);
      state.signals.set(operation, pending);
    });
  };
  return {
    service,
    prisma,
    calls: state.calls,
    events: state.events,
    transactions,
    started,
    callsOf: (operation: string) => state.calls.filter((call) => call.operation === operation),
  };
}
export async function linkedSpend(h: ReturnType<typeof harness>): Promise<LinkedSpend> {
  const value = await h.service.getDistrictNexusSpend(clientId, tenantId);
  expect(value.linked).toBe(true);
  return value as LinkedSpend;
}
