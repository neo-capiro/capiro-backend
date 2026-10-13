import { performance } from 'node:perf_hooks';
import { Prisma } from '@prisma/client';
import { IntelligenceService } from '../../src/intelligence/intelligence.service.js';
import * as embedder from '../../src/embeddings/embedder.js';

jest.mock('../../src/embeddings/embedder.js', () => {
  const actual = jest.requireActual<typeof import('../../src/embeddings/embedder.js')>(
    '../../src/embeddings/embedder.js',
  );
  return {
    ...actual,
    embedText: jest.fn(async () => {
      throw new Error('Embedding provider forbidden by characterization');
    }),
  };
});

export const clientId = '00000000-0000-0000-0000-000000000010';
export const tenantId = '00000000-0000-0000-0000-000000000001';
export const userId = 'actor-one';
export const now = new Date('2026-10-13T12:00:00.000Z');
export interface TrackedBill {
  identifier: string;
  title: string;
  latestActionDate: Date | null;
  latestActionText: string | null;
  status?: string | null;
  actionTexts?: string[];
  sponsorName: string | null;
  sponsorParty: string | null;
  subjectNames: string[];
  isManual?: boolean;
}
export interface TrackedResult {
  total: number;
  bills: TrackedBill[];
  issueCodes?: string[];
}
type PublicBills = IntelligenceService['getClientBills'];
export type RelevantBill = Awaited<ReturnType<PublicBills>>['bills'][number];
type RelevantResult = Awaited<ReturnType<PublicBills>>;
export type Subject = Omit<IntelligenceService, never> & {
  capabilityFallbackTerms(tenant: string, client: string): Promise<string[]>;
  findRelevantBills(codes: string[], terms?: string[]): Promise<RelevantResult>;
  findRelevantBillsByEmbeddings(terms: string[]): Promise<RelevantResult | null>;
  findRelevantBillsByKeyword(terms: string[]): Promise<RelevantResult>;
  findTrackedBillsByEmbeddings(terms: string[], floor?: number): Promise<TrackedResult | null>;
  findTrackedBillsByKeyword(terms: string[]): Promise<TrackedResult>;
  getManualTrackedBillIds(client: string, tenant: string): Promise<string[]>;
  fetchBillsByIds(ids: string[]): Promise<TrackedBill[]>;
};
export interface Query {
  kind: 'tagged' | 'prisma' | 'unsafe';
  sql: string;
  text: string;
  statement: string;
  strings: readonly string[];
  values: unknown[];
  raw: unknown;
}
export interface Call {
  operation: string;
  scope: 'global' | 'tenant' | 'keyword' | 'embedding' | 'override';
  args: unknown[];
  tenantId?: string;
  transaction?: number;
  query?: Query;
}
export interface Options {
  rows?: Record<string, unknown>;
  results?: Record<string, unknown>;
  queues?: Record<string, unknown[]>;
  errors?: Record<string, unknown>;
  embedding?: number[] | Error | Promise<number[]>;
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
export function billRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '119-hr-1',
    congress: 119,
    bill_type: 'hr',
    bill_number: '1',
    title: 'Research Bill',
    introduced_date: new Date('2026-01-01T00:00:00.000Z'),
    latest_action_date: new Date('2026-10-01T00:00:00.000Z'),
    latest_action_text: 'Referred to committee',
    status: 'introduced',
    action_texts: ['Introduced'],
    sponsor_name: 'Example',
    sponsor_party: 'I',
    sponsor_state: 'VA',
    policy_area: 'Science',
    subjects: ['Research'],
    ...overrides,
  };
}
export function trackedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pin-one',
    tenantId,
    clientId,
    billId: '119-hr-1',
    note: null,
    createdBy: null,
    createdAt: now,
    ...overrides,
  };
}
export function capabilityRow(overrides: Record<string, unknown> = {}) {
  return {
    sector: 'DEFENSE',
    name: 'Space research capability',
    tags: ['hypersonics'],
    description: null,
    justification: null,
    districtNexus: null,
    ...overrides,
  };
}
const clocks: Array<() => void> = [];
export function clock(initial = 0) {
  let value = initial;
  let restored = false;
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  Object.defineProperty(performance, 'now', { configurable: true, value: jest.fn(() => value) });
  const restore = () => {
    if (restored) return;
    restored = true;
    if (descriptor) Object.defineProperty(performance, 'now', descriptor);
    else delete (performance as unknown as { now?: () => number }).now;
  };
  clocks.push(restore);
  return {
    now: () => value,
    set: (next: number) => {
      value = next;
    },
    advance: (delta: number) => {
      value += delta;
    },
    restore,
  };
}
export function installHooks() {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    jest.setSystemTime(now);
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Fetch forbidden by characterization'));
    jest
      .mocked(embedder.embedText)
      .mockReset()
      .mockRejectedValue(new Error('Embedding provider forbidden by characterization'));
  });
  afterEach(() => {
    while (clocks.length) clocks.pop()!();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
function capture(state: State, call: Call): Call {
  state.calls.push(call);
  state.events.push(call.operation);
  state.signals.get(call.operation)?.forEach((resolve) => resolve());
  state.signals.delete(call.operation);
  return call;
}
async function respond(state: State, call: Call, fallback: unknown = []): Promise<unknown> {
  capture(state, call);
  const { options, positions } = state;
  if (Object.hasOwn(options.errors ?? {}, call.operation)) throw options.errors![call.operation];
  const queue = options.queues?.[call.operation];
  const position = positions.get(call.operation) ?? 0;
  let value: unknown;
  if (queue && position < queue.length) {
    positions.set(call.operation, position + 1);
    value = queue[position];
  } else if (Object.hasOwn(options.results ?? {}, call.operation))
    value = options.results![call.operation];
  else if (Object.hasOwn(options.rows ?? {}, call.operation)) value = options.rows![call.operation];
  else value = fallback;
  if (value instanceof Error) throw value;
  return typeof value === 'function' ? (value as (input: Call) => unknown)(call) : value;
}
function queryShape(args: unknown[], unsafe = false): Query {
  if (unsafe) {
    const sql = args[0] as string;
    return {
      kind: 'unsafe',
      sql,
      text: sql,
      statement: sql,
      strings: [sql],
      values: args.slice(1),
      raw: args[0],
    };
  }
  const tagged = Array.isArray(args[0]);
  const query = tagged
    ? Prisma.sql(args[0] as TemplateStringsArray, ...args.slice(1))
    : (args[0] as Prisma.Sql);
  return {
    kind: tagged ? 'tagged' : 'prisma',
    sql: query.sql,
    text: query.text,
    statement: query.statement,
    strings: query.strings,
    values: query.values,
    raw: args[0],
  };
}
function queryOperation(query: Query, scope: Call['scope']): string {
  const sql = query.sql;
  if (sql.includes('statement_timeout')) return 'statementTimeout';
  if (scope === 'keyword') return /COUNT\(\*\)/i.test(sql) ? 'keywordCount' : 'keywordRows';
  if (sql.includes('context_embeddings')) return 'embeddingCandidates';
  if (sql.includes('FROM lda_issue_code')) return 'issueNames';
  if (sql.includes('FROM lda_client')) return 'issueCodes';
  if (sql.includes('FROM federal_register_document')) return 'regulations';
  if (sql.includes('FROM gao_report')) return 'gaoReports';
  if (sql.includes('FROM crs_report')) return 'crsReports';
  if (/SELECT id FROM congress_bill WHERE id/.test(sql)) return 'billExists';
  if (sql.includes('FROM congress_bill cb')) return 'billRows';
  return 'query';
}
function queryIo(state: State, scope: Call['scope'], transaction?: number, tenant?: string) {
  const run = (args: unknown[], unsafe = false, execute = false) => {
    const query = queryShape(args, unsafe);
    const operation = queryOperation(query, scope);
    const fallback = execute ? 1 : operation === 'keywordCount' ? [{ total: 0n }] : [];
    return respond(
      state,
      { operation, scope, transaction, tenantId: tenant, args, query },
      fallback,
    );
  };
  return {
    $queryRaw: jest.fn((...args: unknown[]) => run(args)),
    $queryRawUnsafe: jest.fn((...args: unknown[]) => run(args, true)),
    $executeRaw: jest.fn((...args: unknown[]) => run(args, false, true)),
  };
}
function tenantIo(state: State, transaction: number, tenant: string) {
  const model = (operation: string, fallback: unknown = []) =>
    jest.fn((...args: unknown[]) =>
      respond(state, { operation, scope: 'tenant', transaction, tenantId: tenant, args }, fallback),
    );
  return {
    ...queryIo(state, 'tenant', transaction, tenant),
    clientIntelMapping: { findMany: model('mappings') },
    clientCapability: { findMany: model('capabilities') },
    client: { findFirst: model('client', { id: clientId, issueCodes: [] }) },
    trackedBill: {
      findMany: model('trackedBills'),
      upsert: jest.fn((...args: unknown[]) => {
        const input = args[0] as { create: Record<string, unknown> };
        return respond(
          state,
          { operation: 'upsert', scope: 'tenant', transaction, tenantId: tenant, args },
          { id: 'pin-one', ...input.create, createdAt: now },
        );
      }),
      deleteMany: model('delete', { count: 0 }),
    },
  };
}
export interface Transaction {
  id: number;
  scope: 'tenant' | 'keyword';
  tenantId?: string;
  options?: unknown;
  tx: ReturnType<typeof tenantIo> | ReturnType<typeof queryIo>;
  outcome?: 'commit' | 'rollback';
}
function prismaIo(state: State) {
  const transactions: Transaction[] = [];
  const execute = async <T>(record: Transaction, work: (tx: Transaction['tx']) => Promise<T>) => {
    transactions.push(record);
    state.events.push(`${record.scope}.begin`);
    try {
      const value = await work(record.tx);
      record.outcome = 'commit';
      state.events.push(`${record.scope}.commit`);
      return value;
    } catch (error) {
      record.outcome = 'rollback';
      state.events.push(`${record.scope}.rollback`);
      throw error;
    }
  };
  const prisma = {
    ...queryIo(state, 'global'),
    withTenant: jest.fn(
      <T>(tenant: string, work: (tx: ReturnType<typeof tenantIo>) => Promise<T>) => {
        const id = transactions.length + 1;
        capture(state, {
          operation: 'withTenant',
          scope: 'tenant',
          tenantId: tenant,
          transaction: id,
          args: [tenant, work],
        });
        return execute(
          { id, scope: 'tenant', tenantId: tenant, tx: tenantIo(state, id, tenant) },
          work as (tx: Transaction['tx']) => Promise<T>,
        );
      },
    ),
    $transaction: jest.fn(
      <T>(work: (tx: ReturnType<typeof queryIo>) => Promise<T>, options?: unknown) => {
        const id = transactions.length + 1;
        capture(state, {
          operation: 'transaction',
          scope: 'keyword',
          transaction: id,
          args: [work, options],
        });
        return execute(
          { id, scope: 'keyword', options, tx: queryIo(state, 'keyword', id) },
          work as (tx: Transaction['tx']) => Promise<T>,
        );
      },
    ),
  };
  return { prisma, transactions };
}
function started(state: State, operation: string): Promise<void> {
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
  const embedding = jest.mocked(embedder.embedText);
  embedding
    .mockReset()
    .mockImplementation(
      (...args) =>
        respond(
          state,
          { operation: 'embed', scope: 'embedding', args },
          options.embedding ?? new Error('Embedding provider forbidden by characterization'),
        ) as Promise<number[]>,
    );
  const warnings = jest
    .spyOn(
      (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
      'warn',
    )
    .mockImplementation(() => undefined);
  const override = (method: string, value: unknown) => {
    const target = subject as unknown as Record<string, (...args: unknown[]) => unknown>;
    return jest.spyOn(target, method).mockImplementation((...args) => {
      capture(state, { operation: method, scope: 'override', args });
      return typeof value === 'function'
        ? (value as (...input: unknown[]) => unknown)(...args)
        : value instanceof Error
          ? Promise.reject(value)
          : Promise.resolve(value);
    });
  };
  return {
    service,
    subject,
    prisma,
    embedding,
    warnings,
    transactions,
    calls: state.calls,
    events: state.events,
    override,
    callsOf: (operation: string) => state.calls.filter((call) => call.operation === operation),
    started: (operation: string) => started(state, operation),
  };
}
