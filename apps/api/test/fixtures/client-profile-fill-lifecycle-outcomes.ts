import type { TenantContext } from '@capiro/shared';
import { ClientProfileFillCompletionService } from '../../src/clients/client-profile-fill-completion.service.js';
import type { ClientProfileFillLifecycleOutcomes } from '../../src/clients/client-profile-fill-lifecycle-outcomes.js';

export const tenantId = '11111111-1111-1111-1111-111111111111';
export const clientId = '22222222-2222-2222-2222-222222222222';
export const runId = '33333333-3333-3333-3333-333333333333';
export const now = '2026-10-13T12:00:00.000Z';
export const ctx: TenantContext = {
  tenantId,
  tenantSlug: 'lifecycle-test',
  userId: 'lifecycle-actor',
  clerkUserId: 'clerk-lifecycle-actor',
  role: 'standard_user',
};

export interface OutcomeRow {
  id: string;
  kind: string;
  sourceType: string;
  sourceId: string | null;
  evidence: unknown;
  notes: string | null;
  observedAt: Date;
}
export interface MatterRow {
  id: string;
  primaryPeCode: string | null;
  primaryBillId: string | null;
}
export interface Options {
  findings?: unknown[];
  persisted?: unknown[];
  outcomes?: OutcomeRow[];
  matters?: MatterRow[];
  snapshotFailure?: 'findings' | 'records' | 'events' | 'matters';
  terminalAt?: number[];
  insertResults?: number[];
  failInsertAt?: number;
  failCursor?: boolean;
  onOperation?: (operation: string) => void;
}
export interface Call {
  operation: string;
  transaction: number;
  sql?: string;
  args: unknown[];
}
export interface FindingWrite {
  runId: unknown;
  tenantId: unknown;
  clientId: unknown;
  kind: unknown;
  targetKey: unknown;
  source: unknown;
  factKind: unknown;
  currentValue: unknown;
  proposedValue: Record<string, unknown>;
  evidence: Array<{ label: string; source: string; metadata: Record<string, unknown> }>;
  confidence: unknown;
  status: unknown;
  contentHash: unknown;
}
interface CursorWrite {
  tenantId: unknown;
  clientId: unknown;
  source: unknown;
  watermark: Record<string, unknown>;
}
interface Transaction {
  id: number;
  tenantId: string;
  status: 'pending' | 'commit' | 'rollback';
  findings: FindingWrite[];
  cursors: CursorWrite[];
}
interface State {
  options: Options;
  calls: Call[];
  transactions: Transaction[];
  attempts: FindingWrite[];
  findings: FindingWrite[];
  cursorAttempts: CursorWrite[];
  cursors: CursorWrite[];
  terminalCount: number;
  active: boolean;
}

export function advocacy(overrides: Record<string, unknown> = {}) {
  return {
    externalKey: 'advocacy:one',
    recordType: 'lobbying',
    title: 'alpha',
    summary: null,
    activityDate: '2026-01-01T00:00:00.000Z',
    sourceType: 'test-source',
    sourceId: 'source-one',
    metadata: {},
    matterId: null,
    ...overrides,
  };
}
export function persisted(overrides: Record<string, unknown> = {}) {
  return {
    external_key: 'advocacy:persisted',
    record_type: 'lobbying',
    title: 'alpha',
    summary: null,
    activity_date: '2026-01-01T00:00:00.000Z',
    source_type: 'test-source',
    source_id: 'source-one',
    metadata_jsonb: {},
    matter_id: null,
    ...overrides,
  };
}
export function outcome(overrides: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    id: 'outcome-one',
    kind: 'result',
    sourceType: 'test-source',
    sourceId: 'source-one',
    evidence: {},
    notes: null,
    observedAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}
export function matter(overrides: Partial<MatterRow> = {}): MatterRow {
  return { id: 'matter-one', primaryPeCode: null, primaryBillId: null, ...overrides };
}
function capture(state: State, tx: Transaction, operation: string, args: unknown[], sql?: string) {
  state.calls.push({ operation, args, sql, transaction: tx.id });
  state.options.onOperation?.(operation);
  if (state.options.snapshotFailure === operation) throw new Error(`${operation} failed`);
}
function queryRows(state: State, tx: Transaction, sql: string, args: unknown[]) {
  if (sql.includes('SELECT proposed_value_jsonb')) {
    capture(state, tx, 'findings', args, sql);
    return (state.options.findings ?? []).map((proposedValue) => ({ proposedValue }));
  }
  if (sql.includes('SELECT to_jsonb(a)')) {
    capture(state, tx, 'records', args, sql);
    return (state.options.persisted ?? []).map((data) => ({ data }));
  }
  if (sql.includes('primary_pe_code AS')) {
    capture(state, tx, 'matters', args, sql);
    return state.options.matters ?? [];
  }
  if (sql.includes("status IN ('accepted', 'rejected')")) {
    capture(state, tx, 'terminal', args, sql);
    state.terminalCount += 1;
    return state.options.terminalAt?.includes(state.terminalCount) ? [{ id: 'terminal' }] : [];
  }
  throw new Error(`Unexpected lifecycle query: ${sql}`);
}
function decodeFinding(args: unknown[]): FindingWrite {
  return {
    runId: args[0],
    tenantId: args[1],
    clientId: args[2],
    kind: args[3],
    targetKey: args[4],
    source: args[5],
    factKind: args[6],
    currentValue: JSON.parse(args[7] as string),
    proposedValue: JSON.parse(args[8] as string),
    evidence: JSON.parse(args[9] as string),
    confidence: args[10],
    status: args[11],
    contentHash: args[12],
  };
}
function executeWrite(state: State, tx: Transaction, sql: string, args: unknown[]) {
  if (sql.includes('UPDATE client_profile_fill_finding')) {
    capture(state, tx, 'retire', args, sql);
    return 1;
  }
  if (sql.includes('INSERT INTO client_profile_fill_finding')) {
    capture(state, tx, 'insert', args, sql);
    const finding = decodeFinding(args);
    state.attempts.push(finding);
    if (state.options.failInsertAt === state.attempts.length) throw new Error('insert failed');
    const result = state.options.insertResults?.[state.attempts.length - 1] ?? 1;
    if (result > 0) tx.findings.push(finding);
    return result;
  }
  if (sql.includes('INSERT INTO client_profile_fill_source_cursor')) {
    capture(state, tx, 'cursor', args, sql);
    const cursor = {
      tenantId: args[0],
      clientId: args[1],
      source: args[2],
      watermark: JSON.parse(args[3] as string),
    };
    state.cursorAttempts.push(cursor);
    if (state.options.failCursor) throw new Error('cursor failed');
    tx.cursors.push(cursor);
    return 1;
  }
  throw new Error(`Unexpected lifecycle write: ${sql}`);
}
function createTx(state: State, tx: Transaction) {
  return {
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) =>
      queryRows(state, tx, sql, args),
    ),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) =>
      executeWrite(state, tx, sql, args),
    ),
    outcomeEvent: {
      findMany: jest.fn(async (input: unknown) => {
        capture(state, tx, 'events', [input]);
        return state.options.outcomes ?? [];
      }),
    },
  };
}
function tenantRunner(state: State) {
  return async (tenant: string, callback: (tx: unknown) => Promise<unknown>) => {
    if (state.active) throw new Error('Unexpected nested transaction');
    state.active = true;
    const tx: Transaction = {
      id: state.transactions.length + 1,
      tenantId: tenant,
      status: 'pending',
      findings: [],
      cursors: [],
    };
    state.transactions.push(tx);
    capture(state, tx, 'begin', [tenant]);
    try {
      const result = await callback(createTx(state, tx));
      tx.status = 'commit';
      state.findings.push(...tx.findings);
      state.cursors.push(...tx.cursors);
      capture(state, tx, 'commit', []);
      return result;
    } catch (error) {
      tx.status = 'rollback';
      capture(state, tx, 'rollback', []);
      throw error;
    } finally {
      state.active = false;
    }
  };
}
export function harness(options: Options = {}) {
  const state: State = {
    options,
    calls: [],
    transactions: [],
    attempts: [],
    findings: [],
    cursorAttempts: [],
    cursors: [],
    terminalCount: 0,
    active: false,
  };
  const unexpected = jest.fn(async () => {
    throw new Error('Unexpected non-tenant I/O');
  });
  const prisma = {
    withTenant: jest.fn(tenantRunner(state)),
    withSystem: unexpected,
    withTenantUser: unexpected,
    $queryRawUnsafe: unexpected,
    $executeRawUnsafe: unexpected,
  };
  const service = new ClientProfileFillCompletionService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const completion = (
    service as unknown as { owners: { lifecycleOutcomes: ClientProfileFillLifecycleOutcomes } }
  ).owners.lifecycleOutcomes;
  return {
    ...state,
    prisma,
    service,
    unexpected,
    gather: () => completion.gather(ctx, clientId, runId),
    callsOf: (operation: string) => state.calls.filter((call) => call.operation === operation),
  };
}
export const sqlText = (sql: string | undefined) => (sql ?? '').replace(/\s+/g, ' ').trim();
export function installLifecycleClock() {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(now));
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider request'));
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
