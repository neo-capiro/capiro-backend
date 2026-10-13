import { Prisma } from '@prisma/client';
import { IntelligenceService } from '../../src/intelligence/intelligence.service.js';
import type { OfficeRecommenderService } from '../../src/intelligence/office-recommender.service.js';

export const tenantId = '00000000-0000-0000-0000-000000000001';
export const clientId = '00000000-0000-0000-0000-000000000010';
export const userId = 'actor-one';
export const now = new Date('2026-10-13T12:00:00.000Z');
export const day = 86_400_000;
export type Operation =
  | 'clients'
  | 'client'
  | 'changes'
  | 'consume'
  | 'unread'
  | 'briefs'
  | 'createBrief'
  | 'deleteBrief'
  | 'issueCodes'
  | 'issueName'
  | 'competitors'
  | 'leaderTotal'
  | 'leaderRegistrants'
  | 'sharedLobbyists'
  | 'staffRegistrants'
  | 'exStaffers'
  | 'confirmedLdaIds'
  | 'trackedBills'
  | 'recommend';
export interface Call {
  operation: Operation;
  scope: 'global' | 'tenant' | 'source' | 'collaborator';
  args: unknown[];
  tenantId?: string;
  transaction?: number;
  query?: { sql: string; strings: readonly string[]; values: unknown[]; raw: unknown };
}
export interface Options {
  results?: Partial<Record<Operation, unknown>>;
  queues?: Partial<Record<Operation, unknown[]>>;
  errors?: Partial<Record<Operation, unknown>>;
  ldaIds?: unknown;
  office?: boolean;
}
interface State {
  options: Options;
  calls: Call[];
  events: string[];
  positions: Map<Operation, number>;
  signals: Map<Operation, Array<() => void>>;
}
export type OfficePort = Pick<OfficeRecommenderService, 'recommend'>;
export type OfficeMock = { recommend: jest.MockedFunction<OfficePort['recommend']> };
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
    jest.useFakeTimers({ doNotFake: ['performance'] });
    jest.setSystemTime(now);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider I/O forbidden'));
  });
  afterEach(() => {
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
async function respond(state: State, call: Call, fallback: unknown = []): Promise<unknown> {
  capture(state, call);
  const options = state.options;
  if (Object.hasOwn(options.errors ?? {}, call.operation)) throw options.errors![call.operation];
  const queue = options.queues?.[call.operation];
  const position = state.positions.get(call.operation) ?? 0;
  let value: unknown;
  if (queue && position < queue.length) {
    state.positions.set(call.operation, position + 1);
    value = queue[position];
  } else if (Object.hasOwn(options.results ?? {}, call.operation))
    value = options.results![call.operation];
  else value = fallback;
  if (value instanceof Error) throw value;
  return typeof value === 'function' ? (value as (call: Call) => unknown)(call) : value;
}
function queryOperation(sql: string): Operation {
  if (sql.includes('FROM lda_issue_code')) return 'issueName';
  if (sql.includes('FROM lda_client')) return 'issueCodes';
  if (sql.includes('all_time_first')) return 'competitors';
  if (sql.includes('COUNT(*)::text AS total')) return 'leaderTotal';
  if (sql.includes('SELECT DISTINCT registrant_id')) return 'staffRegistrants';
  if (sql.includes('shared_registrant_ids')) return 'sharedLobbyists';
  if (sql.includes('FROM lda_lobbyist')) return 'exStaffers';
  if (sql.includes('FROM lda_filing')) return 'leaderRegistrants';
  throw new Error(`Uncharacterized SQL: ${sql}`);
}
function globalQuery(state: State) {
  return jest.fn((...args: unknown[]) => {
    const tagged = Array.isArray(args[0]);
    const q = tagged
      ? Prisma.sql(args[0] as TemplateStringsArray, ...args.slice(1))
      : (args[0] as Prisma.Sql);
    const operation = queryOperation(q.sql);
    return respond(
      state,
      {
        operation,
        scope: 'global',
        args,
        query: { sql: q.sql, strings: q.strings, values: q.values, raw: args[0] },
      },
      operation === 'leaderTotal' ? [{ total: '0' }] : [],
    );
  });
}
function model(
  state: State,
  operation: Operation,
  scope: Call['scope'],
  transaction?: number,
  tenant?: string,
  fallback: unknown = [],
) {
  return jest.fn((...args: unknown[]) =>
    respond(
      state,
      {
        operation,
        scope,
        transaction,
        tenantId: tenant,
        args,
      },
      fallback,
    ),
  );
}
export interface Transaction {
  id: number;
  tenantId: string;
  outcome?: 'commit' | 'rollback';
}
function prismaIo(state: State) {
  const transactions: Transaction[] = [];
  const withTenant = jest.fn(async <T>(tenant: string, work: (tx: unknown) => Promise<T>) => {
    const transaction: Transaction = { id: transactions.length + 1, tenantId: tenant };
    transactions.push(transaction);
    state.events.push('tenant.begin');
    const tx = {
      client: {
        findMany: model(state, 'clients', 'tenant', transaction.id, tenant),
        findFirst: model(state, 'client', 'tenant', transaction.id, tenant, { id: clientId }),
      },
      clientBrief: {
        findMany: model(state, 'briefs', 'tenant', transaction.id, tenant),
        create: model(state, 'createBrief', 'tenant', transaction.id, tenant),
        deleteMany: model(state, 'deleteBrief', 'tenant', transaction.id, tenant, { count: 0 }),
      },
    };
    try {
      const result = await work(tx);
      transaction.outcome = 'commit';
      state.events.push('tenant.commit');
      return result;
    } catch (error) {
      transaction.outcome = 'rollback';
      state.events.push('tenant.rollback');
      throw error;
    }
  });
  const prisma = {
    $queryRaw: globalQuery(state),
    withTenant,
    intelligenceChange: {
      findMany: model(state, 'changes', 'global'),
      update: model(state, 'consume', 'global'),
      count: model(state, 'unread', 'global', undefined, undefined, 0),
    },
  };
  return { prisma, transactions };
}
function started(state: State, operation: Operation): Promise<void> {
  if (state.calls.some((call) => call.operation === operation)) return Promise.resolve();
  return new Promise((resolve) => {
    const signals = state.signals.get(operation) ?? [];
    signals.push(resolve);
    state.signals.set(operation, signals);
  });
}
function officePort(state: State, result: unknown = [], label = 'office'): OfficeMock {
  const recommend = jest.fn((...args: Parameters<OfficePort['recommend']>) => {
    state.events.push(`${label}.recommend`);
    return respond(
      state,
      { operation: 'recommend', scope: 'collaborator', args },
      result,
    ) as ReturnType<OfficePort['recommend']>;
  });
  return { recommend };
}
export function harness(options: Options = {}) {
  const state: State = { options, calls: [], events: [], positions: new Map(), signals: new Map() };
  const { prisma, transactions } = prismaIo(state);
  const office = officePort(state);
  let selectedOffice: OfficePort | undefined = options.office ? office : undefined;
  const service = new IntelligenceService(
    prisma as unknown as ConstructorParameters<typeof IntelligenceService>[0],
    undefined,
    selectedOffice as ConstructorParameters<typeof IntelligenceService>[2],
  );
  Object.defineProperty(service, 'officeRecommender', {
    configurable: true,
    get: () => {
      state.events.push('office.lookup');
      return selectedOffice;
    },
  });
  const source = service as unknown as {
    confirmedLdaIds(client: string, tenant: string): Promise<number[]>;
  };
  const lda = jest
    .spyOn(source, 'confirmedLdaIds')
    .mockImplementation(
      (...args) =>
        respond(
          state,
          { operation: 'confirmedLdaIds', scope: 'source', args },
          options.ldaIds ?? [],
        ) as Promise<number[]>,
    );
  const overrideTracked = (value: unknown) =>
    jest
      .spyOn(service, 'getTrackedBills')
      .mockImplementation(
        (...args) =>
          respond(state, { operation: 'trackedBills', scope: 'source', args }, value) as ReturnType<
            IntelligenceService['getTrackedBills']
          >,
      );
  return {
    service,
    prisma,
    transactions,
    office,
    lda,
    overrideTracked,
    calls: state.calls,
    events: state.events,
    callsOf: (operation: Operation) => state.calls.filter((call) => call.operation === operation),
    started: (operation: Operation) => started(state, operation),
    makeOffice: (result: unknown, label?: string) => officePort(state, result, label),
    setOffice: (value?: OfficePort) => {
      selectedOffice = value;
    },
  };
}
