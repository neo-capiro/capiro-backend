import type { TenantContext } from '@capiro/shared';
import { ClientProfileFillCompletionService } from '../../src/clients/client-profile-fill-completion.service.js';
import type { ClientProfileFillCompletionPersistence } from '../../src/clients/client-profile-fill-completion-persistence.js';

export const tenantId = '11111111-1111-1111-1111-111111111111';
export const clientId = '22222222-2222-2222-2222-222222222222';
export const runId = '33333333-3333-3333-3333-333333333333';
export const ctx = {
  tenantId,
  userId: 'actor-one',
  role: 'standard_user',
} as unknown as TenantContext;
export const taskLease = {
  id: '44444444-4444-4444-4444-444444444444',
  workerId: 'worker:lease-one',
};
export interface FindingInput {
  kind: string;
  targetKey: string;
  source: string;
  factKind: 'fact' | 'recommendation';
  currentValue: unknown;
  proposedValue: unknown;
  confidence: number;
  evidence: unknown[];
  status: 'pending' | 'informational';
}
export interface Call {
  operation: string;
  sql?: string;
  args: unknown[];
  transaction: number;
}
export interface Options {
  terminalRows?: Array<{ id: string }>;
  leaseRows?: Array<{ id: string }>;
  insertResult?: unknown;
  cursorRows?: Array<{ watermark: unknown }>;
  mappings?: string[];
  errorOperation?: string;
  error?: Error;
  onRetire?: () => void;
  onBegin?: () => void;
}
export function findingInput(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    kind: 'profile_completion',
    targetKey: 'profile-completion',
    source: 'completion_audit',
    factKind: 'fact',
    currentValue: { old: true },
    proposedValue: { z: 2, a: { d: 'date', b: 1 }, list: [{ z: 9, a: 4 }, 5] },
    confidence: 0.9,
    evidence: [{ label: 'Audit evidence', metadata: { z: 2, a: 1 } }],
    status: 'informational',
    ...overrides,
  };
}
function operation(sql: string) {
  if (sql.includes('FROM client_profile_fill_extension_task')) return 'lease';
  if (sql.includes('FROM client_profile_fill_source_cursor')) return 'cursor-read';
  if (sql.includes('INSERT INTO client_profile_fill_source_cursor')) return 'cursor-write';
  if (sql.includes('INSERT INTO client_profile_fill_finding')) return 'insert';
  if (sql.includes('UPDATE client_profile_fill_finding')) return 'retire';
  if (sql.includes('FROM client_profile_fill_finding')) return 'terminal';
  throw new Error(`Unexpected persistence SQL: ${sql}`);
}
function createTx(calls: Call[], phases: string[], options: Options, transaction: number) {
  const capture = (operation: string, args: unknown[], sql?: string) => {
    calls.push({ operation, args, sql, transaction });
    phases.push(operation);
    if (options.errorOperation === operation)
      throw options.error ?? new Error(`${operation} failed`);
  };
  return {
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      const op = operation(sql);
      capture(op, args, sql);
      if (op === 'lease') return options.leaseRows ?? [{ id: taskLease.id }];
      if (op === 'terminal') return options.terminalRows ?? [];
      return options.cursorRows ?? [];
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      const op = operation(sql);
      capture(op, args, sql);
      if (op === 'retire') options.onRetire?.();
      return op === 'insert' ? ('insertResult' in options ? options.insertResult : 1) : 1;
    }),
    clientIntelMapping: {
      findMany: jest.fn(async (input: unknown) => {
        capture('mapping', [input]);
        return (options.mappings ?? []).map((externalId) => ({ externalId }));
      }),
    },
  };
}
export function harness(options: Options = {}) {
  const calls: Call[] = [],
    phases: string[] = [];
  const transactions: Array<{
    id: number;
    tenantId: string;
    tx: ReturnType<typeof createTx>;
    status: 'pending' | 'commit' | 'rollback';
  }> = [];
  let active = false;
  const prisma = {
    withTenant: jest.fn(async (tenant: string, callback: (tx: unknown) => Promise<unknown>) => {
      if (active) throw new Error('Nested tenant transaction forbidden');
      active = true;
      const id = transactions.length + 1;
      const transaction = {
        id,
        tenantId: tenant,
        tx: createTx(calls, phases, options, id),
        status: 'pending' as 'pending' | 'commit' | 'rollback',
      };
      transactions.push(transaction);
      phases.push('begin');
      try {
        options.onBegin?.();
        const result = await callback(transaction.tx);
        transaction.status = 'commit';
        phases.push('commit');
        return result;
      } catch (error) {
        transaction.status = 'rollback';
        phases.push('rollback');
        throw error;
      } finally {
        active = false;
      }
    }),
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
  const persistence = (
    service as unknown as { owners: { persistence: ClientProfileFillCompletionPersistence } }
  ).owners.persistence;
  return {
    service,
    persistence,
    prisma,
    calls,
    phases,
    transactions,
    callsOf: (operation: string) => calls.filter((call) => call.operation === operation),
    add: (input = findingInput(), task?: { id: string; workerId: string | null }) =>
      persistence.addFinding(tenantId, clientId, runId, input, task),
    readCursor: (source = 'advocacy_history') => persistence.getCursor(tenantId, clientId, source),
    writeCursor: (watermark: Record<string, unknown>, source = 'advocacy_history') =>
      persistence.recordCursor(tenantId, clientId, source, watermark),
    mapping: (source = 'fara') => persistence.getConfirmedIntelMappingKeys(ctx, clientId, source),
  };
}
export const sqlText = (sql: string | undefined) => (sql ?? '').replace(/\s+/g, ' ').trim();
