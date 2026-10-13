import {
  ClientProfileFillCompletionService,
  type ClientProfileFillCompletionTaskType,
} from './client-profile-fill-completion.service.js';

const now = new Date('2026-10-13T12:00:00.000Z');
const sqlText = (sql: string) => sql.replace(/\s+/g, ' ').trim();
function task(overrides: Record<string, unknown> = {}) {
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
interface LedgerFacade {
  recoverStaleTasks(): Promise<void>;
  claimTasks(): Promise<Task[]>;
  finishTask(
    task: Task,
    status: 'completed' | 'skipped' | 'cancelled',
    summary: Record<string, unknown>,
  ): Promise<void>;
  deferTask(task: Task, reason: string): Promise<void>;
  failTask(task: Task, error: unknown): Promise<void>;
  heartbeat(task: Task): Promise<void>;
  assertCoreDependencies(task: Task): Promise<void>;
}
interface Call {
  sql: string;
  args: unknown[];
  transaction: number;
  operation: 'read' | 'write';
}
function harness(options: { rows?: unknown[]; changed?: number } = {}) {
  const calls: Call[] = [];
  let transaction = 0;
  const prisma = {
    withSystem: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const id = ++transaction;
      const tx = {
        $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
          calls.push({ sql, args, transaction: id, operation: 'read' });
          return options.rows ?? [];
        }),
        $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
          calls.push({ sql, args, transaction: id, operation: 'write' });
          return options.changed ?? 1;
        }),
      };
      return callback(tx);
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
  return { service, ledger: service as unknown as LedgerFacade, calls, prisma };
}
beforeEach(() => jest.useFakeTimers().setSystemTime(now));
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('recovers stale leases using the exact five-minute cutoff and incremented-attempt retry/cap calculation', async () => {
  const h = harness();
  await h.ledger.recoverStaleTasks();
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.args).toEqual([new Date('2026-10-13T11:55:00.000Z')]);
  expect(sqlText(h.calls[0]!.sql)).toBe(
    sqlText(`UPDATE client_profile_fill_extension_task
    SET status = CASE WHEN attempt + 1 >= max_attempts THEN 'failed' ELSE 'queued' END,
      attempt = attempt + 1, completed_at = CASE WHEN attempt + 1 >= max_attempts THEN now() ELSE NULL END,
      next_attempt_at = CASE WHEN attempt + 1 >= max_attempts THEN next_attempt_at
        ELSE now() + make_interval(secs => LEAST(120, 5 * (attempt + 1))) END,
      error_code = 'stale_worker', error_message = 'Worker heartbeat expired; task recovered from durable state',
      worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL, updated_at = now()
    WHERE status = 'running' AND COALESCE(heartbeat_at, claimed_at, updated_at) < $1`),
  );
});

it('claims four eligible tasks in durable order with a fresh lease for every batch', async () => {
  const rows = [task()];
  const h = harness({ rows });
  expect(await h.ledger.claimTasks()).toBe(rows);
  expect(await h.ledger.claimTasks()).toBe(rows);
  const [first, second] = h.calls;
  const workerId = process.env.HOSTNAME ?? `api-${process.pid}`;
  expect(first!.args[0]).toBe(4);
  expect(first!.args[1]).toEqual(
    expect.stringMatching(new RegExp(`^${workerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`)),
  );
  expect(String(first!.args[1]).slice(workerId.length + 1)).toMatch(/^[a-f0-9-]{36}$/);
  expect(second!.args[1]).not.toBe(first!.args[1]);
  expect(first!.transaction).not.toBe(second!.transaction);
  const sql = sqlText(first!.sql);
  for (const clause of [
    "t.status = 'queued'",
    't.next_attempt_at <= now()',
    "r.status <> 'cancelled'",
    'dependency.run_id = t.run_id',
    'dependency.task_key = ANY(t.depends_on)',
    "dependency.status IN ('queued', 'running')",
    'ORDER BY t.created_at ASC, t.task_key ASC',
    'FOR UPDATE OF t SKIP LOCKED LIMIT $1',
    "SET status = 'running', worker_id = $2, claimed_at = now()",
    'heartbeat_at = now(), updated_at = now()',
    'WHERE t.id = c.id',
    't.worker_id AS "workerId"',
    't.max_attempts AS "maxAttempts"',
    't.output_summary_jsonb AS "outputSummary"',
  ]) {
    expect(sql).toContain(clause);
  }
});

it.each(['completed', 'skipped', 'cancelled'] as const)(
  'finishes %s with the original lease and serialized summary',
  async (status) => {
    const h = harness({ changed: 0 });
    const row = task();
    await expect(
      h.ledger.finishTask(row, status, { count: 4, source: 'test' }),
    ).resolves.toBeUndefined();
    expect(h.calls[0]!.args).toEqual([
      row.id,
      row.runId,
      row.tenantId,
      status,
      '{"count":4,"source":"test"}',
      row.workerId,
    ]);
    expect(sqlText(h.calls[0]!.sql)).toBe(
      sqlText(`UPDATE client_profile_fill_extension_task
    SET status = $4, output_summary_jsonb = $5::jsonb, completed_at = now(), heartbeat_at = NULL,
      worker_id = NULL, error_code = NULL, error_message = NULL, updated_at = now()
    WHERE id = $1::uuid AND run_id = $2::uuid AND tenant_id = $3::uuid
      AND status = 'running' AND worker_id = $6`),
    );
  },
);

it('defers by two seconds without incrementing the attempt and ignores a lost lease', async () => {
  const h = harness({ changed: 0 });
  const row = task({ attempt: 2 });
  await expect(h.ledger.deferTask(row, 'Waiting')).resolves.toBeUndefined();
  expect(h.calls[0]!.args).toEqual([row.id, row.runId, row.tenantId, 'Waiting', row.workerId]);
  expect(sqlText(h.calls[0]!.sql)).toBe(
    sqlText(`UPDATE client_profile_fill_extension_task
    SET status = 'queued', next_attempt_at = now() + interval '2 seconds',
      claimed_at = NULL, heartbeat_at = NULL, worker_id = NULL,
      error_code = 'waiting_for_dependency', error_message = $4, updated_at = now()
    WHERE id = $1::uuid AND run_id = $2::uuid AND tenant_id = $3::uuid
      AND status = 'running' AND worker_id = $5`),
  );
});

it.each([
  [0, 3, 'queued'],
  [1, 3, 'queued'],
  [2, 3, 'failed'],
  [0, 0, 'failed'],
] as const)(
  'fails attempt %i of %i as %s with capped retry SQL and sanitized errors',
  async (attempt, maxAttempts, status) => {
    const h = harness();
    const row = task({ attempt, maxAttempts });
    await h.ledger.failTask(row, new Error('authorization: secret-value unavailable'));
    expect(h.calls[0]!.args).toEqual([
      row.id,
      row.runId,
      row.tenantId,
      status,
      'authorization=[redacted] unavailable',
      row.workerId,
    ]);
    const sql = sqlText(h.calls[0]!.sql);
    expect(sql).toContain('attempt = attempt + 1');
    expect(sql).toContain("completed_at = CASE WHEN $4 = 'failed' THEN now() ELSE NULL END");
    expect(sql).toContain(
      "WHEN $4 = 'failed' THEN next_attempt_at ELSE now() + make_interval(secs => LEAST(120, 5 * (attempt + 1)))",
    );
    expect(sql).toContain("error_code = 'task_error', error_message = $5");
    expect(sql).toContain(
      "WHERE id = $1::uuid AND run_id = $2::uuid AND tenant_id = $3::uuid AND status = 'running' AND worker_id = $6",
    );
  },
);

it('stringifies non-Error failures and limits their durable message to 800 characters', async () => {
  const h = harness();
  await h.ledger.failTask(task(), 'x'.repeat(900));
  expect(h.calls[0]!.args[4]).toBe('x'.repeat(800));
});

it('heartbeats using only the task id and running lease, preserving the existing narrower fence', async () => {
  const h = harness({ changed: 0 });
  const row = task();
  await expect(h.ledger.heartbeat(row)).resolves.toBeUndefined();
  expect(h.calls[0]!.args).toEqual([row.id, row.workerId]);
  expect(sqlText(h.calls[0]!.sql)).toBe(
    sqlText(`UPDATE client_profile_fill_extension_task
    SET heartbeat_at = now(), updated_at = now()
    WHERE id = $1::uuid AND status = 'running' AND worker_id = $2`),
  );
});

it.each([
  ['federal_market', ['sam_gov'], false],
  ['facility_resolution', ['public_web', 'sam_gov', 'client_document'], false],
  ['advocacy_history', ['synced_email', 'lda', 'program_elements', 'bill_tracker'], false],
  ['lifecycle_outcomes', ['program_elements', 'bill_tracker'], false],
  ['reconciliation', [], true],
  ['completion_audit', [], true],
] as const)('gates %s on its exact core requirements', async (taskType, required, waitForAll) => {
  const h = harness({ rows: [{ pending: 1 }] });
  const row = task({ taskType });
  let error: unknown;
  try {
    await h.ledger.assertCoreDependencies(row);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).constructor.name).toBe('TaskDeferredError');
  expect((error as Error).message).toBe('Waiting for prerequisite Fill specialists');
  expect(h.calls[0]!.args).toEqual([row.runId, row.tenantId, required, waitForAll]);
  expect(sqlText(h.calls[0]!.sql)).toBe(
    sqlText(`SELECT COUNT(*)::int AS pending
    FROM client_profile_fill_task WHERE run_id = $1::uuid AND tenant_id = $2::uuid
      AND ($4::boolean OR task_type = ANY($3::text[])) AND status IN ('queued', 'running')`),
  );
});

it.each<[unknown[]]>([[[]], [[{ pending: 0 }]], [[{ pending: '0' }]]])(
  'permits ready core dependency rows %j',
  async (rows) => {
    const h = harness({ rows });
    await expect(
      h.ledger.assertCoreDependencies(task({ taskType: 'federal_market' })),
    ).resolves.toBeUndefined();
  },
);

it('does not query core dependencies for district nexus tasks', async () => {
  const h = harness({ rows: [{ pending: 10 }] });
  await h.ledger.assertCoreDependencies(task());
  expect(h.calls).toEqual([]);
  expect(h.prisma.withSystem).not.toHaveBeenCalled();
});
