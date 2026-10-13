import type { TenantContext } from '@capiro/shared';
import {
  ClientProfileFillCompletionService,
  type ClientProfileFillCompletionTaskType,
} from '../../src/clients/client-profile-fill-completion.service.js';

export const now = new Date('2026-10-13T12:00:00.000Z');
export function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-one',
    runId: 'run-one',
    tenantId: 'tenant-one',
    clientId: 'client-one',
    taskType: 'district_nexus' as ClientProfileFillCompletionTaskType,
    taskKey: 'district_nexus',
    status: 'running',
    dependsOn: [],
    attempt: 0,
    maxAttempts: 3,
    input: {},
    outputSummary: {},
    errorCode: null,
    errorMessage: null,
    workerId: 'worker:lease-one',
    claimedAt: now,
    heartbeatAt: now,
    nextAttemptAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
type Task = ReturnType<typeof task>;
interface WorkerFacade {
  executeClaimedTask(task: Task): Promise<void>;
  executeTask(ctx: TenantContext, task: Task): Promise<unknown>;
  withTaskTimeout<T>(promise: Promise<T>): Promise<T>;
}
interface Call {
  operation: string;
  sql: string;
  args: unknown[];
  transaction: number;
}
export interface Options {
  tasks?: Task[];
  run?: { status: string; createdByUserId: string | null } | null;
  pending?: number;
  profile?: unknown;
  profilePromise?: Promise<unknown>;
  recoverError?: Error;
  claimError?: Error;
  actorError?: Error;
  finalizeError?: Error;
  heartbeatError?: Error;
  finishError?: Error;
  profileError?: Error;
  facilityRows?: unknown[];
}
function operation(sql: string) {
  if (sql.includes('stale_worker')) return 'recover';
  if (sql.includes('WITH candidates')) return 'claim';
  if (sql.includes('created_by_user_id AS')) return 'actor';
  if (sql.includes('SELECT COUNT(*)::int AS pending')) return 'dependencies';
  if (sql.includes('SELECT r.id AS "runId"')) return 'finalize';
  if (sql.includes('waiting_for_dependency')) return 'defer';
  if (sql.includes('task_error')) return 'fail';
  if (sql.includes('SET heartbeat_at = now()')) return 'heartbeat';
  if (sql.includes('output_summary_jsonb = $5::jsonb')) return 'finish';
  if (sql.includes('INSERT INTO client_profile_fill_source_cursor')) return 'cursor';
  if (sql.includes('INSERT INTO client_profile_fill_finding')) return 'finding';
  return 'read';
}
function txFor(calls: Call[], phases: string[], options: Options, transaction: number) {
  const capture = (sql: string, args: unknown[]) => {
    const op = operation(sql);
    calls.push({ operation: op, sql, args, transaction });
    phases.push(op);
    const error = (
      {
        recover: options.recoverError,
        claim: options.claimError,
        actor: options.actorError,
        finalize: options.finalizeError,
        heartbeat: options.heartbeatError,
        finish: options.finishError,
      } as Record<string, Error | undefined>
    )[op];
    if (error) throw error;
    return op;
  };
  return {
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      const op = capture(sql, args);
      if (op === 'claim') return options.tasks ?? [];
      if (op === 'actor')
        return options.run === null
          ? []
          : [options.run ?? { status: 'running', createdByUserId: 'actor-one' }];
      if (op === 'dependencies') return [{ pending: options.pending ?? 0 }];
      return [];
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      capture(sql, args);
      return 1;
    }),
    clientFacility: {
      findMany: jest.fn(async (input: unknown) => {
        phases.push('facility-read');
        return options.facilityRows ?? [];
      }),
      count: jest.fn(async () => 0),
    },
    client: {
      findFirst: jest.fn(async () => ({
        id: 'client-one',
        name: null,
        ldaClientIds: [],
        intakeData: {},
        _count: { capabilities: 0, people: 0, facilities: 0, meetings: 0, mailThreads: 0 },
      })),
    },
    clientIntelMapping: { findMany: jest.fn(async () => []) },
    outcomeEvent: { findMany: jest.fn(async () => []) },
  };
}
export function harness(options: Options = {}) {
  const calls: Call[] = [],
    phases: string[] = [];
  let transaction = 0;
  const withScope = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback(txFor(calls, phases, options, ++transaction)),
  );
  const prisma = {
    withSystem: withScope,
    withTenant: jest.fn(async (_tenant: string, callback: (tx: unknown) => Promise<unknown>) =>
      withScope(callback),
    ),
    withTenantUser: jest.fn(
      async (_tenant: string, _user: string, callback: (tx: unknown) => Promise<unknown>) =>
        withScope(callback),
    ),
    $queryRawUnsafe: jest.fn(async () => []),
  };
  const intelligence = {
    getClientProfile: jest.fn(async (...args: unknown[]) => {
      phases.push(`profile:${String(args[0])}`);
      if (options.profileError) throw options.profileError;
      return options.profilePromise ?? options.profile ?? {};
    }),
  };
  const facilities = {
    resolveFacilityDistrict: jest.fn(async (...args: unknown[]) => ({
      congressionalDistrict: 'VA-08',
      stateHouseDistrict: null,
      stateSenateDistrict: null,
      geocodeStatus: 'matched',
      geocodeMatchedAddress: 'Address',
      districtSource: 'census',
    })),
  };
  const service = new ClientProfileFillCompletionService(
    prisma as never,
    {} as never,
    {} as never,
    intelligence as never,
    facilities as never,
    {} as never,
    {} as never,
  );
  return {
    service,
    worker: service as unknown as WorkerFacade,
    calls,
    phases,
    prisma,
    intelligence,
    facilities,
    callsOf: (op: string) => calls.filter((call) => call.operation === op),
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
