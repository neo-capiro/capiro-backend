import { Prisma } from '@prisma/client';
import { IntelligenceService } from '../../src/intelligence/intelligence.service.js';
import { clientRow, mappingRow, now } from './intelligence-mapping.rows.js';
export * from './intelligence-mapping.rows.js';

jest.mock('../../src/embeddings/embedder.js', () => {
  const actual = jest.requireActual<typeof import('../../src/embeddings/embedder.js')>(
    '../../src/embeddings/embedder.js',
  );
  return { ...actual, embedText: jest.fn().mockRejectedValue(new Error('Provider forbidden')) };
});

export interface Call {
  operation: string;
  scope: 'tenant' | 'global' | 'prepopulation';
  args: unknown[];
  tenantId?: string;
  transaction?: number;
  query?: { sql: string; text: string; values: unknown[]; raw: unknown };
}
export interface PrepopulationPort {
  prepopulate(tenant: string, client: string): Promise<unknown>;
}
export interface Options {
  rows?: Record<string, unknown>;
  queues?: Record<string, unknown[]>;
  errors?: Record<string, unknown>;
  prepopulation?: false;
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
    jest.useFakeTimers({ doNotFake: ['performance'] });
    jest.setSystemTime(now);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fetch forbidden'));
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
function globalIo(state: State) {
  return {
    $queryRaw: jest.fn((...args: unknown[]) => {
      const sql = Array.isArray(args[0])
        ? Prisma.sql(args[0] as unknown as TemplateStringsArray, ...args.slice(1))
        : (args[0] as Prisma.Sql);
      const tables = [
        ['lda_client', 'lda'],
        ['federal_contractor', 'contractors'],
        ['fec_contribution', 'employers'],
        ['fec_committee', 'committees'],
        ['federal_assistance_award', 'assistance'],
        ['lobby_intel_mv', 'lobby'],
      ];
      const operation =
        tables.find(([table]) => sql.sql.includes(`FROM ${table}`))?.[1] ?? 'unknownQuery';
      return respond(state, {
        operation,
        scope: 'global',
        args,
        query: { sql: sql.sql, text: sql.text, values: sql.values, raw: args[0] },
      });
    }),
    fecCommittee: {
      findUnique: jest.fn((...args: unknown[]) =>
        respond(
          state,
          { operation: 'committee', scope: 'global', args },
          { name: 'Research PAC', committeeType: 'Q' },
        ),
      ),
    },
  };
}
function tenantIo(state: State, tenant: string, transaction: number) {
  const read = (operation: string, fallback: unknown = []) =>
    jest.fn((...args: unknown[]) =>
      respond(state, { operation, scope: 'tenant', tenantId: tenant, transaction, args }, fallback),
    );
  return {
    client: { findFirst: read('client', clientRow()), findMany: read('clients') },
    clientCapability: { findMany: read('capabilities') },
    clientIntelMapping: {
      findMany: read('mappings'),
      findUnique: read('existing', null),
      upsert: jest.fn((...args: unknown[]) => {
        const input = args[0] as { create: Record<string, unknown> };
        return respond(
          state,
          { operation: 'upsert', scope: 'tenant', tenantId: tenant, transaction, args },
          mappingRow(input.create),
        );
      }),
      update: jest.fn((...args: unknown[]) => {
        const input = args[0] as { data: Record<string, unknown> };
        return respond(
          state,
          { operation: 'update', scope: 'tenant', tenantId: tenant, transaction, args },
          mappingRow(input.data),
        );
      }),
    },
    auditLog: { create: read('audit', {}) },
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
    ...globalIo(state),
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
type IdentityPort = { confirmedLdaIds(client: string, tenant: string): Promise<number[]> };
export function harness(options: Options = {}) {
  const state: State = { options, calls: [], events: [], positions: new Map(), signals: new Map() };
  const { prisma, transactions } = prismaIo(state);
  const prepopulation = {
    prepopulate: jest.fn((...args: [string, string]) =>
      respond(state, { operation: 'prepopulate', scope: 'prepopulation', args }, undefined),
    ),
  };
  const service = new IntelligenceService(
    prisma as unknown as ConstructorParameters<typeof IntelligenceService>[0],
    options.prepopulation === false
      ? undefined
      : (prepopulation as unknown as ConstructorParameters<typeof IntelligenceService>[1]),
    undefined,
  );
  const setPrepopulation = (value?: PrepopulationPort) => {
    (service as unknown as { prepopulation?: PrepopulationPort }).prepopulation = value;
  };
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
    prepopulation,
    setPrepopulation,
    started,
    transactions,
    identity: service as unknown as IdentityPort,
    calls: state.calls,
    events: state.events,
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
