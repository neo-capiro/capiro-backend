import { Prisma } from '@prisma/client';
import { IntelligenceService } from '../../src/intelligence/intelligence.service.js';

export const tenantId = '00000000-0000-0000-0000-000000000001';
export const clientId = '00000000-0000-0000-0000-000000000010';
export const userId = '00000000-0000-0000-0000-000000000020';
export const deniedId = '00000000-0000-0000-0000-000000000030';
export const now = new Date('2026-10-13T02:00:00.000Z');
export const day = 86_400_000;
export const graphOptions = { envIntelGraphOn: true, envTraversalSource: 'cache' as const };
export const healthOperations = ['meetings', 'emails', 'tasks', 'debriefs', 'outreach'] as const;
export type Operation =
  | 'settings'
  | 'client'
  | 'mappings'
  | 'timeout'
  | 'denied'
  | 'walk'
  | 'ldaClientLabels'
  | 'ldaRegistrantLabels'
  | 'ldaLobbyistLabels'
  | 'contractorLabels'
  | 'fecLabels'
  | 'capabilityLabels'
  | 'hearings'
  | 'changes'
  | 'commentPeriods'
  | 'coverageRegistrants'
  | 'coverageLobbyists'
  | 'confirmedLdaIds'
  | 'issueCodes'
  | 'trackedBills'
  | (typeof healthOperations)[number];
export interface Call {
  operation: Operation;
  scope: 'global' | 'tenant' | 'source';
  args: unknown[];
  tenantId?: string;
  transaction?: number;
  query?: { sql: string; strings: readonly string[]; values: unknown[]; raw: unknown };
}
export interface Options {
  results?: Partial<Record<Operation, unknown>>;
  queues?: Partial<Record<Operation, unknown[]>>;
  errors?: Partial<Record<Operation, unknown>>;
}
export interface WalkRow {
  depth: number;
  src_kind: string;
  src_id: string;
  dst_kind: string;
  dst_id: string;
  edge_type: string;
  confidence: number | null;
  source: string | null;
  observed_at: Date | null;
  tenant_id: string | null;
}
export interface Subject {
  walkClientGraph(tenant: string, client: string, viewer: string | null): Promise<WalkRow[]>;
  confirmedLdaIds(client: string, tenant: string): Promise<number[]>;
  issueCodesForLdaIds(ids: number[]): Promise<string[]>;
}
interface State {
  options: Options;
  calls: Call[];
  events: string[];
  positions: Map<Operation, number>;
  signals: Map<Operation, Array<() => void>>;
}
export interface Transaction {
  id: number;
  tenantId: string;
  options?: unknown;
  outcome?: 'commit' | 'rollback';
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
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider I/O forbidden'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
export function walkRow(overrides: Partial<WalkRow> = {}): WalkRow {
  return {
    depth: 1,
    src_kind: 'client',
    src_id: clientId,
    dst_kind: 'bill',
    dst_id: 'HR 1',
    edge_type: 'tracks_bill',
    confidence: 0.8,
    source: 'confirmed',
    observed_at: now,
    tenant_id: tenantId,
    ...overrides,
  };
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
  if (sql.includes('kg_walk_bounded')) return 'walk';
  if (sql.includes('SELECT DISTINCT registrant_id')) return 'coverageRegistrants';
  if (sql.includes('covered_positions')) return 'coverageLobbyists';
  if (sql.includes('FROM lda_client')) return 'ldaClientLabels';
  if (sql.includes('FROM lda_registrant')) return 'ldaRegistrantLabels';
  if (sql.includes('FROM lda_lobbyist')) return 'ldaLobbyistLabels';
  if (sql.includes('FROM federal_contractor')) return 'contractorLabels';
  if (sql.includes('FROM fec_contribution')) return 'fecLabels';
  throw new Error(`Uncharacterized SQL: ${sql}`);
}
function rawQuery(state: State, scope: Call['scope'], transaction?: number, tenant?: string) {
  return jest.fn((...args: unknown[]) => {
    const tagged = Array.isArray(args[0]);
    const q = tagged
      ? Prisma.sql(args[0] as TemplateStringsArray, ...args.slice(1))
      : (args[0] as Prisma.Sql);
    return respond(state, {
      operation: queryOperation(q.sql),
      scope,
      transaction,
      tenantId: tenant,
      args,
      query: { sql: q.sql, strings: q.strings, values: q.values, raw: args[0] },
    });
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
    respond(state, { operation, scope, transaction, tenantId: tenant, args }, fallback),
  );
}
function tenantIo(state: State, id: number, tenant: string) {
  const io = (operation: Operation, fallback?: unknown) =>
    model(state, operation, 'tenant', id, tenant, fallback);
  return {
    $executeRawUnsafe: io('timeout', 0),
    $queryRawUnsafe: io('denied'),
    $queryRaw: rawQuery(state, 'tenant', id, tenant),
    tenant: { findFirst: io('settings', null) },
    client: { findFirst: io('client', { id: clientId, name: 'Acme', sectorTag: 'energy' }) },
    clientIntelMapping: { findMany: io('mappings') },
    clientCapability: { findMany: io('capabilityLabels') },
    meeting: { count: io('meetings', 0) },
    mailThread: { count: io('emails', 0) },
    engagementTask: { count: io('tasks', 0) },
    meetingDebrief: { count: io('debriefs', 0) },
    outreachRecord: { count: io('outreach', 0) },
  };
}
function prismaIo(state: State) {
  const transactions: Transaction[] = [];
  const withTenant = jest.fn(
    async <T>(tenant: string, work: (tx: unknown) => Promise<T>, options?: unknown) => {
      const tx: Transaction = { id: transactions.length + 1, tenantId: tenant, options };
      transactions.push(tx);
      state.events.push('tenant.begin');
      try {
        const value = await work(tenantIo(state, tx.id, tenant));
        tx.outcome = 'commit';
        state.events.push('tenant.commit');
        return value;
      } catch (error) {
        tx.outcome = 'rollback';
        state.events.push('tenant.rollback');
        throw error;
      }
    },
  );
  const prisma = {
    withTenant,
    $queryRaw: rawQuery(state, 'global'),
    committeeHearing: { findMany: model(state, 'hearings', 'global') },
    intelligenceChange: { findMany: model(state, 'changes', 'global') },
    federalRegisterDocument: { findMany: model(state, 'commentPeriods', 'global') },
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
export function harness(options: Options = {}) {
  const state: State = { options, calls: [], events: [], positions: new Map(), signals: new Map() };
  const { prisma, transactions } = prismaIo(state);
  const service = new IntelligenceService(
    prisma as unknown as ConstructorParameters<typeof IntelligenceService>[0],
    undefined,
    undefined,
  );
  const subject = service as unknown as Subject;
  const warnings: string[] = [];
  const logger = (service as unknown as { logger: { warn(message: string): void } }).logger;
  jest.spyOn(logger, 'warn').mockImplementation((message) => {
    warnings.push(message);
  });
  jest
    .spyOn(subject, 'confirmedLdaIds')
    .mockImplementation(
      (...args) =>
        respond(state, { operation: 'confirmedLdaIds', scope: 'source', args }) as Promise<
          number[]
        >,
    );
  jest
    .spyOn(subject, 'issueCodesForLdaIds')
    .mockImplementation(
      (...args) =>
        respond(state, { operation: 'issueCodes', scope: 'source', args }) as Promise<string[]>,
    );
  jest
    .spyOn(service, 'getTrackedBills')
    .mockImplementation(
      (...args) =>
        respond(
          state,
          { operation: 'trackedBills', scope: 'source', args },
          { bills: [] },
        ) as ReturnType<IntelligenceService['getTrackedBills']>,
    );
  return {
    service,
    subject,
    prisma,
    transactions,
    warnings,
    calls: state.calls,
    events: state.events,
    callsOf: (operation: Operation) => state.calls.filter((call) => call.operation === operation),
    started: (operation: Operation) => started(state, operation),
  };
}
