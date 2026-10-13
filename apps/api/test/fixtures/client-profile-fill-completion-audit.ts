import type { TenantContext } from '@capiro/shared';
import { ClientProfileFillCompletionService } from '../../src/clients/client-profile-fill-completion.service.js';

export const ctx = {
  tenantId: 'audit-tenant',
  userId: 'audit-user',
  role: 'standard_user',
} as unknown as TenantContext;
export const clientId = 'audit-client';
export const runId = 'audit-run';
export const now = new Date('2026-10-13T12:00:00Z');
export const labels = [
  'Federal identity',
  'Company website',
  'Company overview',
  'Government identifiers',
  'Capabilities',
  'Relationships and history',
  'Facilities',
  'District Nexus',
  'Federal Market footprint',
  'Lobbying history',
  'Advocacy history',
  'Program Elements',
  'Bill recommendations',
];
export const advocacySql = `SELECT COUNT(*)::int AS count FROM client_advocacy_record WHERE tenant_id = $1::uuid AND client_id = $2::uuid`;
export const findingSql = `SELECT kind, COUNT(*)::int AS count FROM client_profile_fill_finding
  WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid GROUP BY kind`;
export const failuresSql = `SELECT task_type AS "taskType", error_message AS "errorMessage"
  FROM client_profile_fill_extension_task WHERE tenant_id = $1::uuid AND client_id = $2::uuid
    AND run_id = $3::uuid AND status = 'failed'`;
export const leaseSql = `SELECT id FROM client_profile_fill_extension_task
  WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
    AND run_id = $4::uuid AND status = 'running' AND worker_id = $5 FOR UPDATE`;

interface Counts {
  capabilities: number;
  people: number;
  facilities: number;
  meetings: number;
  mailThreads: number;
}
interface Profile {
  website: string | null;
  description: string | null;
  uei: string | null;
  cageCode: string | null;
  ldaClientIds: number[];
  intakeData: unknown;
  _count: Counts;
}
export function client(
  overrides: Partial<Omit<Profile, '_count'>> & { _count?: Partial<Counts> } = {},
): Profile {
  return {
    website: null,
    description: null,
    uei: null,
    cageCode: null,
    ldaClientIds: [],
    intakeData: null,
    ...overrides,
    _count: {
      capabilities: 0,
      people: 0,
      facilities: 0,
      meetings: 0,
      mailThreads: 0,
      ...overrides._count,
    },
  };
}
export interface AuditTask {
  id: string;
  tenantId: string;
  clientId: string;
  runId: string;
  workerId: string | null;
  [key: string]: unknown;
}
export const task: AuditTask = {
  id: 'audit-task',
  tenantId: ctx.tenantId,
  clientId,
  runId,
  workerId: 'audit-worker:lease',
  taskType: 'completion_audit',
  taskKey: 'completion_audit',
  status: 'running',
  dependsOn: ['reconciliation'],
  attempt: 0,
  maxAttempts: 3,
  input: {},
  outputSummary: {},
  errorCode: null,
  errorMessage: null,
  claimedAt: now,
  heartbeatAt: now,
  nextAttemptAt: now,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
};
type AdvocacyCount = { count: number | string };
type FindingCount = { kind: string; count: number | string };
interface Options {
  client?: Profile | null;
  resolvedFacilities?: number;
  advocacyRows?: AdvocacyCount[];
  findingRows?: FindingCount[];
  failedTasks?: Array<{ taskType: string; errorMessage: string | null }>;
  lease?: AuditTask | null;
  terminal?: boolean;
  inserted?: number;
  errors?: Record<string, Error>;
  onFailures?: () => void;
  onLease?: () => void;
  holdCounts?: {
    facilities?: Promise<number>;
    advocacy?: Promise<AdvocacyCount[]>;
    findings?: Promise<FindingCount[]>;
  };
}
interface Call {
  operation: string;
  transaction: number;
  tenantId: string;
  args: unknown[];
  sql?: string;
}
interface State {
  options: Options;
  calls: Call[];
  phases: string[];
  nextTransaction: number;
}
interface AuditFacade {
  runCompletionAudit(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    task: AuditTask,
  ): Promise<number>;
  addFinding(
    tenantId: string,
    clientId: string,
    runId: string,
    input: unknown,
    task?: AuditTask,
  ): Promise<boolean>;
}
function record(
  state: State,
  transaction: number,
  tenantId: string,
  operation: string,
  args: unknown[],
  sql?: string,
) {
  state.calls.push({ operation, transaction, tenantId, args, sql });
  state.phases.push(`${transaction}:${operation}`);
  if (state.options.errors?.[operation]) throw state.options.errors[operation];
}
function raw(state: State, transaction: number, tenantId: string) {
  const { options } = state;
  return {
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      const operation = sql.includes('FROM client_advocacy_record')
        ? 'advocacy-count'
        : sql.includes('GROUP BY kind')
          ? 'finding-count'
          : sql.includes("status = 'failed'")
            ? 'failures'
            : sql.includes('FOR UPDATE')
              ? 'lease'
              : sql.includes("status IN ('accepted', 'rejected')")
                ? 'terminal'
                : '';
      if (!operation) throw new Error(`Unexpected completion audit query: ${sql}`);
      record(state, transaction, tenantId, operation, args, sql);
      if (operation === 'advocacy-count')
        return options.holdCounts?.advocacy ?? options.advocacyRows ?? [];
      if (operation === 'finding-count')
        return options.holdCounts?.findings ?? options.findingRows ?? [];
      if (operation === 'failures') {
        options.onFailures?.();
        return options.failedTasks ?? [];
      }
      if (operation === 'terminal') return options.terminal ? [{ id: 'terminal' }] : [];
      options.onLease?.();
      const expected = options.lease === undefined ? task : options.lease;
      return expected &&
        expected.workerId !== null &&
        args.every(
          (value, index) =>
            value ===
            [expected.id, expected.tenantId, expected.clientId, expected.runId, expected.workerId][
              index
            ],
        )
        ? [{ id: expected.id }]
        : [];
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      const operation = sql.includes('INSERT INTO client_profile_fill_finding')
        ? 'insert'
        : sql.includes('UPDATE client_profile_fill_finding')
          ? 'retire'
          : '';
      if (!operation) throw new Error(`Unexpected completion audit write: ${sql}`);
      record(state, transaction, tenantId, operation, args, sql);
      return operation === 'insert' ? (options.inserted ?? 1) : 1;
    }),
  };
}
function transactionMethods(state: State, transaction: number, tenantId: string) {
  return {
    ...raw(state, transaction, tenantId),
    client: {
      findFirst: jest.fn(async (input: unknown) => {
        record(state, transaction, tenantId, 'client', [input]);
        return state.options.client === undefined ? client() : state.options.client;
      }),
    },
    clientFacility: {
      count: jest.fn(async (input: unknown) => {
        record(state, transaction, tenantId, 'facilities-count', [input]);
        return state.options.holdCounts?.facilities ?? state.options.resolvedFacilities ?? 0;
      }),
    },
  };
}
export function fixture(options: Options = {}) {
  const state: State = { options, calls: [], phases: [], nextTransaction: 0 };
  const prisma = {
    withTenant: jest.fn(async (tenantId: string, callback: (tx: unknown) => Promise<unknown>) => {
      const transaction = ++state.nextTransaction;
      state.phases.push(`${transaction}:begin`);
      try {
        const result = await callback(transactionMethods(state, transaction, tenantId));
        state.phases.push(`${transaction}:commit`);
        return result;
      } catch (error) {
        state.phases.push(`${transaction}:rollback`);
        throw error;
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
  const facade = service as unknown as Pick<AuditFacade, 'addFinding'>;
  const auditOwner = (
    service as unknown as { owners: { completionAudit: Pick<AuditFacade, 'runCompletionAudit'> } }
  ).owners.completionAudit;
  // Observation only: the original hashing/lease/durability implementation runs.
  const ledger = jest.spyOn(facade, 'addFinding');
  return {
    service,
    options,
    calls: state.calls,
    phases: state.phases,
    ledger,
    audit: (auditTask = task) => auditOwner.runCompletionAudit(ctx, clientId, runId, auditTask),
    callsOf: (operation: string) => state.calls.filter((call) => call.operation === operation),
    finding: () => {
      const args = state.calls.find((call) => call.operation === 'insert')!.args;
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
    },
  };
}
export function installHooks() {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error('Provider calls forbidden by completion audit characterization'),
      );
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
