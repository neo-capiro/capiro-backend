import type { TenantContext } from '@capiro/shared';
import { ClientAdvocacyMatterService } from '../../src/clients/client-advocacy-matter.service.js';
import { ClientProfileFillCompletionService } from '../../src/clients/client-profile-fill-completion.service.js';
import type { ClientProfileFillReconciliation } from '../../src/clients/client-profile-fill-reconciliation.js';
import type { AdvancedFindingRow } from '../../src/clients/client-profile-fill-finding-review.shared.js';

export const ctx = {
  tenantId: 'tenant-one',
  userId: 'actor-one',
  role: 'standard_user',
} as TenantContext;
export const clientId = 'client-one';
export const runId = 'run-one';
export function row(id: string, overrides: Partial<AdvancedFindingRow> = {}): AdvancedFindingRow {
  return {
    id,
    kind: 'profile_field',
    targetKey: 'profile:name',
    source: 'public_web',
    factKind: 'fact',
    currentValue: null,
    proposedValue: { name: 'Acme', sector: 'Defense' },
    evidence: [],
    confidence: 0.9,
    status: 'pending',
    contentHash: `hash-${id}`,
    ...overrides,
  };
}
export function advocacy(id: string, overrides: Partial<AdvancedFindingRow> = {}) {
  return row(id, {
    kind: 'advocacy_record',
    targetKey: `advocacy:${id}`,
    source: id === 'a' ? 'lda' : 'client_submission',
    proposedValue: {
      title: 'alpha bravo charlie delta echo',
      activityDate: '2026-10-13T09:00:00.000Z',
    },
    ...overrides,
  });
}
interface Association {
  id: string;
  kind: string;
  proposedValue: unknown;
  status?: string;
}
interface Options {
  rows?: AdvancedFindingRow[];
  associations?: Association[];
  matterIds?: Record<string, string>;
  duplicateAffected?: number;
  failDuplicateAt?: number;
  insertResults?: Array<number | Error>;
  terminal?: boolean;
  linkErrors?: Record<string, Error>;
  pendingError?: Error;
  associationError?: Error;
}
export interface Call {
  operation: string;
  sql: string;
  args: unknown[];
  transaction: number;
}
interface Transaction {
  id: number;
  calls: Call[];
  result?: 'commit' | 'rollback';
}
interface State {
  options: Options;
  calls: Call[];
  events: string[];
  committedCalls: Call[];
  transactions: Transaction[];
  current: Transaction | null;
  duplicateAttempts: number;
  insertResults: Array<number | Error>;
}
function record(state: State, operation: string, sql: string, args: unknown[]): Call {
  if (!state.current) throw new Error('Unexpected raw I/O outside tenant transaction');
  const call = { operation, sql, args, transaction: state.current.id };
  state.calls.push(call);
  state.events.push(`${call.transaction}:${operation}`);
  return call;
}
function query(state: State) {
  return jest.fn(async (sql: string, ...args: unknown[]) => {
    const operation = sql.includes('content_hash = $3')
      ? 'terminal-check'
      : sql.includes("kind IN ('program_element', 'bill_recommendation')")
        ? 'associations'
        : sql.includes('FROM client_advocacy_matter')
          ? 'matter-lookup'
          : sql.includes('ORDER BY confidence DESC')
            ? 'pending'
            : null;
    if (!operation) throw new Error(`Unexpected reconciliation query: ${sql}`);
    record(state, operation, sql, args);
    if (operation === 'terminal-check')
      return state.options.terminal ? [{ id: 'already-reviewed' }] : [];
    if (operation === 'pending') {
      if (state.options.pendingError) throw state.options.pendingError;
      return state.options.rows ?? [];
    }
    if (operation === 'associations') {
      if (state.options.associationError) throw state.options.associationError;
      return state.options.associations ?? [];
    }
    const id = state.options.matterIds?.[String(args[2])];
    return id ? [{ id }] : [];
  });
}
function execute(state: State) {
  return jest.fn(async (sql: string, ...args: unknown[]) => {
    const operation = sql.includes('INSERT INTO client_advocacy_matter_link')
      ? 'matter-link'
      : sql.includes('INSERT INTO client_profile_fill_finding')
        ? 'finding-insert'
        : sql.includes('run_id <> $4')
          ? 'retire-prior'
          : sql.includes('WHERE id = $1::uuid')
            ? 'duplicate-update'
            : null;
    if (!operation) throw new Error(`Unexpected reconciliation write: ${sql}`);
    const call = record(state, operation, sql, args);
    let result = 1;
    if (operation === 'duplicate-update') {
      state.duplicateAttempts += 1;
      if (state.duplicateAttempts === state.options.failDuplicateAt)
        throw new Error('duplicate unavailable');
      result = state.options.duplicateAffected ?? 1;
    }
    if (operation === 'matter-link') {
      const error = state.options.linkErrors?.[String(args[3])];
      if (error) throw error;
    }
    if (operation === 'finding-insert') {
      const value = state.insertResults.shift() ?? 1;
      if (value instanceof Error) throw value;
      result = value;
    }
    state.current!.calls.push(call);
    return result;
  });
}
export function harness(options: Options = {}) {
  const state: State = {
    options,
    calls: [],
    events: [],
    committedCalls: [],
    transactions: [],
    current: null,
    duplicateAttempts: 0,
    insertResults: [...(options.insertResults ?? [])],
  };
  const tx = { $queryRawUnsafe: query(state), $executeRawUnsafe: execute(state) };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, fn: (value: typeof tx) => unknown) => {
      if (state.current) throw new Error('Unexpected nested reconciliation transaction');
      const transaction: Transaction = { id: state.transactions.length + 1, calls: [] };
      state.transactions.push(transaction);
      state.current = transaction;
      try {
        const result = await fn(tx);
        transaction.result = 'commit';
        state.committedCalls.push(...transaction.calls);
        state.events.push(`${transaction.id}:commit`);
        return result;
      } catch (error) {
        transaction.result = 'rollback';
        state.events.push(`${transaction.id}:rollback`);
        throw error;
      } finally {
        state.current = null;
      }
    }),
  };
  const matters = new ClientAdvocacyMatterService(prisma as never, {} as never);
  const service = new ClientProfileFillCompletionService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    matters,
  );
  const logger = (service as unknown as { logger: { warn(message: string): void } }).logger;
  const warning = jest.spyOn(logger, 'warn').mockImplementation((message) => {
    state.events.push(`outside:warn:${message}`);
  });
  const reconciliation = (
    service as unknown as { owners: { reconciliation: ClientProfileFillReconciliation } }
  ).owners.reconciliation;
  const reconcile = () => reconciliation.reconcileFindings(ctx, clientId, runId);
  const findingWrites = () =>
    state.calls
      .filter((call) => call.operation === 'finding-insert')
      .map((call) => ({
        call,
        runId: call.args[0],
        tenantId: call.args[1],
        clientId: call.args[2],
        kind: call.args[3],
        targetKey: call.args[4],
        source: call.args[5],
        factKind: call.args[6],
        currentValue: JSON.parse(String(call.args[7])),
        proposedValue: JSON.parse(String(call.args[8])),
        evidence: JSON.parse(String(call.args[9])),
        confidence: call.args[10],
        status: call.args[11],
        contentHash: call.args[12],
      }));
  return { service, matters, prisma, tx, state, warning, reconcile, findingWrites };
}
