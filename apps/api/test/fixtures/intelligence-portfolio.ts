import { Prisma } from '@prisma/client';
import { IntelligenceService } from '../../src/intelligence/intelligence.service.js';
import { now, profile } from './intelligence-portfolio.rows.js';
export * from './intelligence-portfolio.rows.js';

jest.mock('../../src/embeddings/embedder.js', () => {
  const actual = jest.requireActual<typeof import('../../src/embeddings/embedder.js')>(
    '../../src/embeddings/embedder.js',
  );
  return { ...actual, embedText: jest.fn().mockRejectedValue(new Error('Provider forbidden')) };
});

export type AlertResult = Awaited<ReturnType<IntelligenceService['getPortfolioAlerts']>>;
export interface Runtime {
  portfolioAlertsCache: Map<string, { expiresAt: number; value: unknown }>;
  portfolioAlertsInflight: Map<string, Promise<unknown>>;
  portfolioAlertsGate: Promise<unknown>;
  emptyPortfolioAlerts(): AlertResult;
  computePortfolioAlerts(
    tenant: string,
    user: string | undefined,
    limit: number,
    maxClients: number,
  ): Promise<AlertResult>;
  withPortfolioAlertsRequestBudget<T extends AlertResult>(
    key: string,
    work: Promise<T>,
  ): Promise<T>;
}
export interface Budgets {
  PORTFOLIO_ALERTS_REQUEST_BUDGET_MS: number;
  PORTFOLIO_ALERTS_TTL_MS: number;
}
export const budgets = IntelligenceService as unknown as Budgets;
export interface Call {
  operation: string;
  scope: 'tenant' | 'global' | 'source';
  args: unknown[];
  tenantId?: string;
  transaction?: number;
  query?: { sql: string; text: string; values: unknown[]; raw: unknown };
}
export interface Options {
  rows?: Record<string, unknown>;
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
  let originalRequest: number;
  let originalTtl: number;
  beforeEach(() => {
    originalRequest = budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS;
    originalTtl = budgets.PORTFOLIO_ALERTS_TTL_MS;
    jest.useFakeTimers({ doNotFake: ['performance'] });
    jest.setSystemTime(now);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fetch forbidden'));
  });
  afterEach(() => {
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = originalRequest;
    budgets.PORTFOLIO_ALERTS_TTL_MS = originalTtl;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
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
  const position = state.positions.get(call.operation) ?? 0;
  let value = fallback;
  if (queue && position < queue.length) {
    state.positions.set(call.operation, position + 1);
    value = queue[position];
  } else if (Object.hasOwn(state.options.rows ?? {}, call.operation))
    value = state.options.rows![call.operation];
  if (value instanceof Error) throw value;
  return typeof value === 'function' ? (value as (call: Call) => unknown)(call) : value;
}
function queryIo(state: State, scope: Call['scope'], tenantId?: string, transaction?: number) {
  return jest.fn((...args: unknown[]) => {
    const query = Array.isArray(args[0])
      ? Prisma.sql(args[0] as unknown as TemplateStringsArray, ...args.slice(1))
      : (args[0] as Prisma.Sql);
    const operation = query.sql.includes('FROM sp_strategy')
      ? 'strategies'
      : query.sql.includes('FROM lda_filing')
        ? 'ldaSpend'
        : query.sql.includes('FROM program_element_delta')
          ? 'deltas'
          : 'unknownQuery';
    return respond(
      state,
      {
        operation,
        scope,
        tenantId,
        transaction,
        args,
        query: { sql: query.sql, text: query.text, values: query.values, raw: args[0] },
      },
      operation === 'strategies' ? [{ count: 0n }] : [],
    );
  });
}
function model(
  state: State,
  operation: string,
  scope: Call['scope'],
  tenantId?: string,
  transaction?: number,
  fallback: unknown = [],
) {
  return jest.fn((...args: unknown[]) =>
    respond(state, { operation, scope, tenantId, transaction, args }, fallback),
  );
}
function tenantIo(state: State, tenant: string, transaction: number) {
  const read = (operation: string, fallback: unknown = []) =>
    model(state, operation, 'tenant', tenant, transaction, fallback);
  return {
    $queryRaw: queryIo(state, 'tenant', tenant, transaction),
    client: { findMany: read('clients') },
    clientIntelMapping: { findMany: read('mappings') },
    meeting: { findMany: read('meetings'), count: read('meetingCount', 0) },
    trackedBill: { groupBy: read('billCounts'), count: read('bills', 0) },
    engagementTask: {
      groupBy: jest.fn((...args: unknown[]) => {
        const input = args[0] as { where?: { status?: unknown } };
        return read(input.where?.status === 'in_progress' ? 'workCounts' : 'taskCounts')(...args);
      }),
    },
    programElementWatch: { findMany: read('watches') },
    clientCapability: { findMany: read('capabilities') },
    outreachRecord: { findMany: read('outreach') },
    mailThread: { findMany: read('mail') },
  };
}
function prismaIo(state: State) {
  const transactions: Array<{
    id: number;
    tenantId: string;
    tx: ReturnType<typeof tenantIo>;
    outcome: string;
  }> = [];
  const prisma = {
    $queryRaw: queryIo(state, 'global'),
    committeeHearing: { findMany: model(state, 'hearings', 'global') },
    federalRegisterDocument: {
      findMany: model(state, 'deadlines', 'global'),
      count: model(state, 'regulationCount', 'global', undefined, undefined, 0),
    },
    intelligenceChange: { findMany: model(state, 'changes', 'global') },
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
          const value = await work(record.tx);
          record.outcome = 'commit';
          state.events.push('tenant:commit');
          return value;
        } catch (error) {
          record.outcome = 'rollback';
          state.events.push('tenant:rollback');
          throw error;
        }
      },
    ),
  };
  return { prisma, transactions };
}
export interface Harness {
  service: IntelligenceService;
  runtime: Runtime;
  source: jest.SpyInstance<Promise<unknown>, [string, string, string?]>;
  warnings: jest.SpyInstance<void, unknown[]>;
  prisma: ReturnType<typeof prismaIo>['prisma'];
  transactions: ReturnType<typeof prismaIo>['transactions'];
  calls: Call[];
  events: string[];
  started(operation: string): Promise<void>;
  callsOf(operation: string): Call[];
}
export function harness(options: Options = {}): Harness {
  const state: State = { options, calls: [], events: [], positions: new Map(), signals: new Map() };
  const { prisma, transactions } = prismaIo(state);
  const service = new IntelligenceService(
    prisma as unknown as ConstructorParameters<typeof IntelligenceService>[0],
    undefined,
    undefined,
  );
  const source = jest
    .spyOn(service, 'getClientProfileV1')
    .mockImplementation(
      (...args) =>
        respond(
          state,
          { operation: `profile:${args[0]}`, scope: 'source', args },
          profile(),
        ) as ReturnType<IntelligenceService['getClientProfileV1']>,
    ) as unknown as Harness['source'];
  const warnings = jest
    .spyOn((service as unknown as { logger: { warn(...args: unknown[]): void } }).logger, 'warn')
    .mockImplementation(() => undefined);
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
    runtime: service as unknown as Runtime,
    source,
    warnings,
    prisma,
    transactions,
    calls: state.calls,
    events: state.events,
    started,
    callsOf: (operation: string) => state.calls.filter((call) => call.operation === operation),
  };
}
export function inputOf(
  h: ReturnType<typeof harness>,
  operation: string,
  index = 0,
): Record<string, unknown> {
  return h.callsOf(operation)[index]!.args[0] as Record<string, unknown>;
}
