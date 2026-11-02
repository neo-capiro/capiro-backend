import type { TenantContext } from '@capiro/shared';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { ClientProfileFillCompletionService } from '../../src/clients/client-profile-fill-completion.service.js';
import { reviewHash } from '../../src/clients/client-profile-fill-review-snapshot.js';
import type {
  ReviewCommand,
  ReviewTransaction,
} from '../../src/clients/client-profile-fill-review-store.js';

export const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'user_admin',
  clerkUserId: 'synthetic-reviewer',
  tenantSlug: 'synthetic-review',
};
export const clientId = '33333333-3333-4333-8333-333333333333';
export const runId = '44444444-4444-4444-8444-444444444444';
export const matterId = '55555555-5555-4555-8555-555555555555';
export const now = new Date('2026-10-13T12:00:00.000Z');
export const runResponse = { id: runId, status: 'completed', findings: [] };
export const fixtureId = (name: string) => {
  const hex = createHash('sha256').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export interface Finding {
  id: string;
  runId: string;
  clientId: string;
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  rejectionReason: string | null;
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
    externalKey: 'lda:filing-one',
    title: 'Funding request',
    recordType: 'federal_lobbying',
    sourceType: 'lda',
    metadata: {},
    ...overrides,
  };
}

export function finding(kind = 'advocacy_record', overrides: Partial<Finding> = {}): Finding {
  const proposals: Record<string, unknown> = {
    advocacy_record: recordProposal(),
    advocacy_outcome: {
      advocacyExternalKey: 'lda:filing-one',
      outcomeKind: 'funding',
      outcomeEventId: 'event-one',
    },
    regulatory_outcome: { matterId, documentNumber: '2026-00002', docketId: 'DOD-2026-1' },
    federal_footprint: { awards: 2 },
  };
  return {
    id: fixtureId(`finding-${kind}`),
    runId,
    clientId,
    appliedAt: null,
    createdAt: now,
    updatedAt: now,
    rejectionReason: null,
    kind,
    targetKey: `target-${kind}`,
    source: 'advocacy_history',
    factKind: 'recommendation',
    currentValue: null,
    proposedValue: proposals[kind] ?? {},
    evidence: [],
    confidence: 0.9,
    status: 'pending',
    contentHash: `hash-${kind}`,
    ...overrides,
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
  receiptError?: Error;
  commitError?: Error;
  wallAllowed?: boolean;
  membership?: boolean;
  runPresent?: boolean;
  recordLocked?: boolean;
  recordRejected?: boolean;
}

interface Call {
  operation: string;
  args: unknown[];
  transaction: number | null;
}
interface ReviewTx {
  scope: number;
  $queryRaw: jest.Mock;
  $queryRawUnsafe: jest.Mock;
  $executeRawUnsafe: jest.Mock;
  auditLog: { create: jest.Mock; findFirst: jest.Mock };
  tenantMembership: { findFirst: jest.Mock };
  client: { findFirst: jest.Mock };
  clientIntelMapping: { findMany: jest.Mock };
  outcomeEvent: { create: jest.Mock };
}
interface Transaction {
  id: number;
  tx: ReviewTx;
  effects: Call[];
  savepoint?: number;
  result?: 'commit' | 'rollback';
}
interface State {
  rows: Finding[];
  options: Options;
  events: string[];
  calls: Call[];
  committed: Call[];
  transactions: Transaction[];
  current: Transaction | null;
  receipts: Map<string, Receipt>;
}
interface Receipt {
  id: string;
  action: string;
  entityId: string;
  actorUserId: string;
  after: unknown;
}

function canonicalRows(state: State) {
  return [
    state.options.client === null
      ? []
      : [{ value: state.options.client ?? { id: clientId, intakeData: {} } }],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
  ];
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
    $queryRaw: jest.fn(async (sql: TemplateStringsArray | Prisma.Sql) => {
      const text = 'text' in sql ? sql.text : sql.join('?');
      if (text.includes('tenant_memberships'))
        return state.options.membership === false ? [] : [{ role: ctx.role }];
      if (text.includes('FROM clients'))
        return state.options.client === null ? [] : [{ version: 1, primary: ctx.userId }];
      if (text.includes('client_memory_access')) return [];
      throw new Error(`Unexpected bound review query: ${text}`);
    }),
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      if (sql.includes('AS allowed')) return [{ allowed: state.options.wallAllowed !== false }];
      if (sql.includes('SELECT to_jsonb(r)')) {
        record(state, 'revision', [sql, ...args]);
        return sql.includes('FROM clients r') ? canonicalRows(state)[0] : [];
      }
      if (sql.includes('FROM client_profile_fill_run'))
        return state.options.runPresent === false ? [] : [{ id: runId }];
      if (sql.includes('FROM client_profile_fill_finding')) {
        record(state, 'load', [sql, ...args]);
        return structuredClone(state.rows);
      }
      if (sql.includes('FROM client_advocacy_record')) {
        record(state, 'lookup', [sql, ...args]);
        return [
          {
            matterId:
              state.options.recordMatterId === undefined ? matterId : state.options.recordMatterId,
            locked: state.options.recordLocked ?? false,
            rejected: state.options.recordRejected ?? false,
          },
        ];
      }
      if (sql.includes('FROM client_advocacy_matter')) return [{ id: matterId }];
      throw new Error(`Unexpected review query: ${sql}`);
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      if (sql === 'SAVEPOINT reviewed_finding') {
        if (!state.current) throw new Error('Savepoint outside a transaction');
        state.current.savepoint = state.current.effects.length;
        record(state, 'savepoint');
        return 0;
      }
      if (sql === 'ROLLBACK TO SAVEPOINT reviewed_finding') {
        if (!state.current || state.current.savepoint === undefined)
          throw new Error('Missing review savepoint');
        state.current.effects.splice(state.current.savepoint);
        record(state, 'savepoint-rollback');
        return 0;
      }
      if (sql === 'RELEASE SAVEPOINT reviewed_finding') {
        if (!state.current || state.current.savepoint === undefined)
          throw new Error('Missing review savepoint');
        delete state.current.savepoint;
        record(state, 'savepoint-release');
        return 0;
      }
      const operation = sql.includes('INSERT INTO client_advocacy_record')
        ? 'upsert'
        : sql.includes('UPDATE client_advocacy_record')
          ? 'outcome-update'
          : sql.includes('UPDATE clients')
            ? 'footprint'
            : 'accept';
      record(state, operation, [sql, ...args], true);
      if (operation === 'accept' && state.options.acceptanceError)
        throw state.options.acceptanceError;
      return operation === 'outcome-update' ? (state.options.outcomeChanged ?? 1) : 1;
    }),
  };
}

function modelMethods(state: State) {
  return {
    auditLog: {
      findFirst: jest.fn(
        async ({ where }: { where: { id: string } }) => state.receipts.get(where.id) ?? null,
      ),
      create: jest.fn(async (input: { data: Receipt }) => {
        const receipt = input.data.action === 'client_profile_fill.reviewed_application';
        record(state, receipt ? 'receipt' : 'audit', [input], true);
        if (receipt && state.options.receiptError) throw state.options.receiptError;
        if (!receipt && state.options.auditError) throw state.options.auditError;
        return {};
      }),
    },
    tenantMembership: {
      findFirst: jest.fn(async () =>
        state.options.membership === false ? null : { role: ctx.role },
      ),
    },
    client: {
      findFirst: jest.fn(async (input: unknown) => {
        record(state, 'client', [input]);
        return state.options.client === undefined
          ? { id: clientId, intakeData: {} }
          : state.options.client;
      }),
    },
    clientIntelMapping: {
      findMany: jest.fn(async (input: unknown) => {
        record(state, 'mapping', [input]);
        return (state.options.confirmedKeys ?? []).map((externalId) => ({ externalId }));
      }),
    },
    outcomeEvent: {
      create: jest.fn(async (input: { data: Record<string, unknown> }) => {
        record(state, 'event-create', [input], true);
        return { id: 'created-event', ...input.data };
      }),
    },
  };
}

function prismaStub(state: State) {
  const methods = { ...rawMethods(state), ...modelMethods(state) };
  const transaction = async (callback: (tx: ReviewTx) => Promise<unknown>) => {
    const id = state.transactions.length + 1;
    const transaction: Transaction = { id, tx: { scope: id, ...methods }, effects: [] };
    state.transactions.push(transaction);
    state.current = transaction;
    state.events.push(`${id}:begin`);
    try {
      const result = await callback(transaction.tx);
      if (state.options.commitError) throw state.options.commitError;
      transaction.result = 'commit';
      state.committed.push(...transaction.effects);
      for (const effect of transaction.effects) {
        if (effect.operation === 'accept') {
          const row = state.rows.find((candidate) => candidate.id === effect.args[1]);
          if (row) {
            row.status = 'accepted';
            row.appliedAt = now;
            row.updatedAt = now;
            row.rejectionReason = null;
          }
        }
        if (effect.operation === 'receipt') {
          const input = effect.args[0] as { data: Receipt };
          state.receipts.set(input.data.id, input.data);
        }
      }
      state.events.push(`${id}:commit`);
      return result;
    } catch (error) {
      transaction.result = 'rollback';
      state.events.push(`${id}:rollback`);
      throw error;
    } finally {
      state.current = null;
    }
  };
  return {
    withTenant: jest.fn(async (_tenantId: string, callback: (tx: ReviewTx) => Promise<unknown>) =>
      transaction(callback),
    ),
    withTenantUser: jest.fn(
      async (_tenantId: string, _actorId: string, callback: (tx: ReviewTx) => Promise<unknown>) =>
        transaction(callback),
    ),
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
  const state: State = {
    rows,
    options,
    events: [],
    calls: [],
    committed: [],
    transactions: [],
    current: null,
    receipts: new Map(),
  };
  const prisma = prismaStub(state);
  const matters = matterStub(state);
  const fill = {
    applyFindingInTransaction: jest.fn(async (scope: ReviewTransaction, ...args: unknown[]) => {
      if (!Object.is(scope.tx, state.current?.tx))
        throw new Error('Core finding escaped the review transaction');
      record(state, 'core', [scope, ...args], true);
      if (options.coreError) throw options.coreError;
      return options.coreResult ?? { applied: [], errors: [] };
    }),
    afterReviewedFindings: jest.fn(async (...args: unknown[]) => {
      record(state, 'after-applied', args);
    }),
  };
  const service = new ClientProfileFillCompletionService(
    prisma as never,
    {} as never,
    fill as never,
    {} as never,
    {} as never,
    {} as never,
    matters as never,
  );
  service.getRun = jest.fn(async (...args: unknown[]) => {
    record(state, 'run', args);
    return runResponse as never;
  });
  const logger = (service as unknown as { logger: { warn(message: string): void } }).logger;
  const warning = jest.spyOn(logger, 'warn').mockImplementation((message) => {
    record(state, 'warning', [message]);
  });
  const command = (ids = rows.map((row) => row.id)): ReviewCommand => ({
    requestId: randomUUID(),
    expectedClientRevision: reviewHash(canonicalRows(state)),
    findings: ids.map((id) => ({
      id,
      revision: reviewHash(rows.find((row) => row.id === id) ?? null),
    })),
  });
  return {
    ...state,
    prisma,
    matters,
    fill,
    service,
    warning,
    callsOf: (operation: string) => state.calls.filter((call) => call.operation === operation),
    command,
    submit: (input: ReviewCommand, actor = ctx) =>
      service.applyFindings(actor, clientId, runId, input),
    apply: (ids = rows.map((row) => row.id), actor = ctx) =>
      service.applyFindings(actor, clientId, runId, command(ids)),
    assign: (
      target: { matterId: string } | { newMatter: { title: string } },
      id = rows[0]?.id ?? 'missing',
    ) => service.applyAdvocacyFindingToMatter(ctx, clientId, runId, id, target, command([id])),
  };
}

export function installHooks() {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
