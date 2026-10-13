import { IntelligenceService } from '../../src/intelligence/intelligence.service.js';

export const clientId = '00000000-0000-0000-0000-000000000010';
export const tenantId = '00000000-0000-0000-0000-000000000001';
export const now = new Date('2026-10-13T12:00:00.000Z');
export type MoneyFlow = Awaited<ReturnType<IntelligenceService['getFecMoneyFlow']>>;
export type PacGiving = MoneyFlow['pacGiving'];
export interface QuarterInput {
  mappedLdaClientIds: number[];
  lobbyingYearly: Array<{ year: number; amount: number }>;
  obligationsYearly: Array<{ year: number; amount: number }>;
  now: Date;
}
export type Subject = Omit<IntelligenceService, never> & {
  getPacGiving(client: string, tenant: string): Promise<PacGiving>;
  buildRoiQuarterSeries(
    input: QuarterInput,
  ): Promise<Array<{ label: string; lobbying: number; obligations: number }>>;
};
export interface Call {
  operation: string;
  scope: 'tenant' | 'global';
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
export function sqlText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
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
export function flowRow(overrides: Record<string, unknown> = {}) {
  return {
    committee_id: 'C1',
    committee_name: 'Committee One',
    candidate_id: 'H1',
    candidate_name: 'Alice Member',
    contribution_count: 2,
    total_amount: 100,
    latest_contribution_date: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}
export function pacRow(overrides: Record<string, unknown> = {}) {
  return {
    committee_id: 'C1',
    committee_name: 'Historical PAC',
    recipient_name: 'Recipient One',
    candidate_name: 'Alice Member',
    total_amount: 100,
    disbursement_count: 2,
    ...overrides,
  };
}
function defaults(operation: string): unknown {
  if (operation === 'client') return { id: clientId, name: 'Acme Research', ldaClientIds: [] };
  if (operation === 'contractingMapping') return null;
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
function transaction(state: State, tenant: string, id: number) {
  const read = (operation: string) =>
    jest.fn((...args: unknown[]) =>
      respond(state, { operation, args, scope: 'tenant', tenantId: tenant, transaction: id }),
    );
  return {
    client: { findFirst: read('client') },
    clientIntelMapping: {
      findFirst: read('contractingMapping'),
      findMany: jest.fn((input: { where: { source: string } }) => {
        const operations: Record<string, string> = {
          lda: 'ldaMappings',
          fec_committee: 'committeeMappings',
          fec_employer: 'employerMappings',
        };
        const operation = operations[input.where.source];
        if (!operation) throw new Error(`Unexpected mapping source: ${input.where.source}`);
        return respond(state, {
          operation,
          args: [input],
          scope: 'tenant',
          tenantId: tenant,
          transaction: id,
        });
      }),
    },
  };
}
function queryOperation(sql: string) {
  if (sql.includes('FROM fec_pac_contribution')) return 'pacRows';
  if (sql.includes('FROM fec_contribution fc')) return 'flowRows';
  if (sql.includes('SELECT UNNEST(')) return 'members';
  if (sql.includes('cb.latest_action_date')) return 'bills';
  if (sql.includes('FROM federal_contractor')) return 'contractWins';
  if (sql.includes('filing_period')) return 'quarterRows';
  if (sql.includes('FROM lda_filing')) return 'lobbySpend';
  throw new Error(`Unexpected financial SQL: ${sql}`);
}
function globalIo(state: State) {
  const read = (operation: string) =>
    jest.fn((...args: unknown[]) => respond(state, { operation, args, scope: 'global' }));
  return {
    fecCommittee: { findMany: read('committeeCatalog') },
    fecPacSyncState: { findMany: read('pacSync') },
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = sqlText(strings.reduce((text, part, i) => text + (i ? `$${i}` : '') + part, ''));
      return respond(state, {
        operation: queryOperation(sql),
        scope: 'global',
        args: [strings, ...values],
        query: { sql, strings: Array.from(strings), values },
      });
    }),
  };
}
export function harness(options: Options = {}) {
  const state: State = { options, calls: [], events: [], positions: new Map(), signals: new Map() };
  let nextId = 0;
  const transactions: Array<{ id: number; tenantId: string; tx: ReturnType<typeof transaction> }> =
    [];
  const prisma = {
    ...globalIo(state),
    withTenant: jest.fn(
      async (tenant: string, run: (tx: ReturnType<typeof transaction>) => unknown) => {
        const id = ++nextId;
        const tx = transaction(state, tenant, id);
        transactions.push({ id, tenantId: tenant, tx });
        state.calls.push({
          operation: 'withTenant',
          scope: 'tenant',
          args: [tenant, run],
          tenantId: tenant,
          transaction: id,
        });
        state.events.push(`tenant:${id}:begin`);
        try {
          const result = await run(tx);
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
  return {
    service,
    subject: service as unknown as Subject,
    prisma,
    transactions,
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
