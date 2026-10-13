import type { TenantContext } from '@capiro/shared';
import { ClientProfileFillCompletionService } from '../../src/clients/client-profile-fill-completion.service.js';

export const ctx = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  role: 'user_admin',
} as unknown as TenantContext;
export const clientId = '33333333-3333-3333-3333-333333333333';
export const runId = '44444444-4444-4444-4444-444444444444';
export const matterId = '55555555-5555-5555-5555-555555555555';
export const now = new Date('2026-10-13T12:00:00.000Z');
export const runResponse = { id: runId, status: 'completed', findings: [] };

export interface Finding {
  id: string;
  kind: string;
  targetKey: string;
  source: string;
  factKind: string;
  currentValue: unknown;
  proposedValue: unknown;
  evidence: unknown;
  confidence: number | string;
  status: string;
  contentHash: string;
}

export function recordProposal(overrides: Record<string, unknown> = {}) {
  return {
    externalKey: 'lda:filing-one', title: 'Funding request', recordType: 'federal_lobbying',
    sourceType: 'lda', metadata: {}, ...overrides,
  };
}

export function finding(kind = 'advocacy_record', overrides: Partial<Finding> = {}): Finding {
  const proposals: Record<string, unknown> = {
    advocacy_record: recordProposal(),
    advocacy_outcome: { advocacyExternalKey: 'lda:filing-one', outcomeKind: 'funding', outcomeEventId: 'event-one' },
    regulatory_outcome: { matterId, documentNumber: '2026-00002', docketId: 'DOD-2026-1' },
    federal_footprint: { awards: 2 },
  };
  return {
    id: `finding-${kind}`, kind, targetKey: `target-${kind}`, source: 'advocacy_history',
    factKind: 'recommendation', currentValue: null, proposedValue: proposals[kind] ?? {},
    evidence: [], confidence: 0.9, status: 'pending', contentHash: `hash-${kind}`, ...overrides,
  };
}

interface Options {
  confirmedKeys?: string[];
  recordMatterId?: string | null;
  client?: { id: string; intakeData?: unknown } | null;
  outcomeChanged?: number;
  coreResult?: unknown;
  coreError?: Error;
  targetError?: Error;
  automaticError?: Error;
  linkError?: Error;
  acceptanceError?: Error;
  auditError?: Error;
}

interface Call { operation: string; args: unknown[]; transaction: number | null }
interface ReviewTx {
  scope: number;
  $queryRawUnsafe: jest.Mock;
  $executeRawUnsafe: jest.Mock;
  auditLog: { create: jest.Mock };
  client: { findFirst: jest.Mock };
  clientIntelMapping: { findMany: jest.Mock };
  outcomeEvent: { create: jest.Mock };
}
interface Transaction { id: number; tx: ReviewTx; effects: Call[]; result?: 'commit' | 'rollback' }
interface State {
  rows: Finding[];
  options: Options;
  events: string[];
  calls: Call[];
  committed: Call[];
  transactions: Transaction[];
  current: Transaction | null;
}

function record(state: State, operation: string, args: unknown[] = [], write = false) {
  const transaction = state.current?.id ?? null;
  const call = { operation, args, transaction };
  state.events.push(`${transaction ?? 'outside'}:${operation}`);
  state.calls.push(call);
  if (write) state.current?.effects.push(call);
  return call;
}

function rawMethods(state: State) {
  return {
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      if (sql.includes('FROM client_profile_fill_finding')) {
        record(state, 'load', [sql, ...args]);
        return state.rows;
      }
      if (sql.includes('FROM client_advocacy_record')) {
        record(state, 'lookup', [sql, ...args]);
        return [{ matterId: state.options.recordMatterId === undefined ? matterId : state.options.recordMatterId }];
      }
      throw new Error(`Unexpected review query: ${sql}`);
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      const operation = sql.includes('INSERT INTO client_advocacy_record') ? 'upsert'
        : sql.includes('UPDATE client_advocacy_record') ? 'outcome-update'
          : sql.includes('UPDATE clients') ? 'footprint' : 'accept';
      record(state, operation, [sql, ...args], true);
      if (operation === 'accept' && state.options.acceptanceError) throw state.options.acceptanceError;
      return operation === 'outcome-update' ? state.options.outcomeChanged ?? 1 : 1;
    }),
  };
}

function modelMethods(state: State) {
  return {
    auditLog: { create: jest.fn(async (input: unknown) => {
      record(state, 'audit', [input], true);
      if (state.options.auditError) throw state.options.auditError;
      return {};
    }) },
    client: { findFirst: jest.fn(async (input: unknown) => {
      record(state, 'client', [input]);
      return state.options.client === undefined ? { id: clientId, intakeData: {} } : state.options.client;
    }) },
    clientIntelMapping: { findMany: jest.fn(async (input: unknown) => {
      record(state, 'mapping', [input]);
      return (state.options.confirmedKeys ?? []).map((externalId) => ({ externalId }));
    }) },
    outcomeEvent: { create: jest.fn(async (input: { data: Record<string, unknown> }) => {
      record(state, 'event-create', [input], true);
      return { id: 'created-event', ...input.data };
    }) },
  };
}

function prismaStub(state: State) {
  const methods = { ...rawMethods(state), ...modelMethods(state) };
  return {
    withTenant: jest.fn(async (tenantId: string, callback: (tx: ReviewTx) => Promise<unknown>) => {
      const id = state.transactions.length + 1;
      const transaction: Transaction = { id, tx: { scope: id, ...methods }, effects: [] };
      state.transactions.push(transaction);
      state.current = transaction;
      state.events.push(`${id}:begin`);
      try {
        const result = await callback(transaction.tx);
        transaction.result = 'commit';
        state.committed.push(...transaction.effects);
        state.events.push(`${id}:commit`);
        return result;
      } catch (error) {
        transaction.result = 'rollback';
        state.events.push(`${id}:rollback`);
        throw error;
      } finally {
        state.current = null;
      }
    }),
  };
}

function matterStub(state: State) {
  return {
    assignSpecificMatterForRecord: jest.fn(async (...args: unknown[]) => {
      record(state, 'target', args, true);
      if (state.options.targetError) throw state.options.targetError;
      return matterId;
    }),
    assignMatterForRecord: jest.fn(async (...args: unknown[]) => {
      record(state, 'automatic', args);
      if (state.options.automaticError) throw state.options.automaticError;
      return matterId;
    }),
    linkToMatter: jest.fn(async (...args: unknown[]) => {
      record(state, 'link', args);
      if (state.options.linkError) throw state.options.linkError;
    }),
  };
}

// All application SQL/helpers execute unchanged. Only transaction I/O and the
// canonical Matter boundary are fakes; each withTenant receives a distinct tx.
export function harness(rows: Finding[] = [], options: Options = {}) {
  const state: State = { rows, options, events: [], calls: [], committed: [], transactions: [], current: null };
  const prisma = prismaStub(state);
  const matters = matterStub(state);
  const fill = { applyFindings: jest.fn(async (...args: unknown[]) => {
    record(state, 'core', args);
    if (options.coreError) throw options.coreError;
    return options.coreResult ?? { applied: [], errors: [] };
  }) };
  const service = new ClientProfileFillCompletionService(
    prisma as never, {} as never, fill as never, {} as never,
    {} as never, {} as never, matters as never,
  );
  service.getRun = jest.fn(async (...args: unknown[]) => {
    record(state, 'run', args);
    return runResponse as never;
  });
  const logger = (service as unknown as { logger: { warn(message: string): void } }).logger;
  const warning = jest.spyOn(logger, 'warn').mockImplementation((message) => {
    record(state, 'warning', [message]);
  });
  return {
    ...state, prisma, matters, fill, service, warning,
    callsOf: (operation: string) => state.calls.filter((call) => call.operation === operation),
    apply: (ids = rows.map((row) => row.id), actor = ctx) => service.applyFindings(actor, clientId, runId, ids),
    assign: (target: { matterId: string } | { newMatter: { title: string } }, id = rows[0]?.id ?? 'missing') =>
      service.applyAdvocacyFindingToMatter(ctx, clientId, runId, id, target),
  };
}

export function installHooks() {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
}
