import type { TenantContext } from '@capiro/shared';
import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';
import { buildClientProfileFillCompletionPlan } from './client-profile-fill-completion-projection.js';

const ctx = { tenantId: 'tenant-one', userId: 'actor-one' } as TenantContext;
const clientId = 'client-one';
const runId = 'run-one';
interface Options {
  present?: boolean;
  seedFound?: boolean;
  lockFound?: boolean;
  retryChanged?: number;
  cancelChanged?: number;
  seedChanged?: number;
  activeRun?: string;
  failWrite?: string;
}
interface Call {
  operation: string;
  sql: string;
  args: unknown[];
  transaction: number;
}
interface Seams {
  ensureCompletionTasks(ctx: TenantContext, clientId: string, runId: string): Promise<void>;
  requestTaskSweep(): void;
}
function rawMethods(
  options: Options,
  record: (operation: string, sql: string, args: unknown[]) => void,
) {
  return {
    client: {
      findFirst: jest.fn(async (input: unknown) => {
        record('access', '', [input]);
        return { id: clientId };
      }),
    },
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      const operation = sql.includes('SELECT EXISTS')
        ? 'presence'
        : sql.includes('SELECT DISTINCT')
          ? 'active-run'
          : sql.includes('workflow_version >= 2')
            ? 'seed-run'
            : 'run-lock';
      record(operation, sql, args);
      if (operation === 'presence') return [{ present: options.present ?? true }];
      if (operation === 'active-run') return options.activeRun ? [{ id: options.activeRun }] : [];
      return (operation === 'seed-run' ? options.seedFound : options.lockFound) === false
        ? []
        : [{ id: runId }];
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      const operation = sql.includes('INSERT INTO')
        ? 'seed-task'
        : sql.includes("task_type IN ('reconciliation', 'completion_audit')")
          ? 'review-checks'
          : sql.includes('client_profile_fill_extension_task')
            ? 'extension-write'
            : sql.includes('client_profile_fill_task')
              ? 'core-write'
              : 'run-write';
      record(operation, sql, args);
      if (options.failWrite === operation) throw new Error(`Failed ${operation}`);
      if (operation === 'seed-task') return options.seedChanged ?? 1;
      if (operation === 'extension-write' && sql.includes("status = 'failed'")) {
        return options.retryChanged ?? 1;
      }
      if (operation === 'run-write' && sql.includes("status = 'cancelled'")) {
        return options.cancelChanged ?? 1;
      }
      return 1;
    }),
  };
}

function harness(options: Options = {}) {
  const calls: Call[] = [];
  const events: string[] = [];
  let current = 0;
  let next = 0;
  const record = (operation: string, sql: string, args: unknown[]) => {
    calls.push({ operation, sql, args, transaction: current });
    events.push(`${current}:${operation}`);
  };
  const tx = rawMethods(options, record);
  const scoped = async (fn: (value: typeof tx) => unknown) => {
    if (current) throw new Error('Unexpected nested transaction');
    current = ++next;
    try {
      const value = await fn(tx);
      events.push(`${current}:commit`);
      return value;
    } catch (error) {
      events.push(`${current}:rollback`);
      throw error;
    } finally {
      current = 0;
    }
  };
  const prisma = {
    withTenant: jest.fn((_tenant: string, fn: (value: typeof tx) => unknown) => scoped(fn)),
    withTenantUser: jest.fn((_tenant: string, _user: string, fn: (value: typeof tx) => unknown) =>
      scoped(fn),
    ),
  };
  const workflow = {
    startRun: jest.fn(async () => {
      events.push('outside:workflow-start');
      return { id: runId };
    }),
    cancelRun: jest.fn(async () => {
      events.push('outside:core-cancel');
      return { core: true };
    }),
    retryTask: jest.fn(async () => {
      events.push('outside:core-retry');
      return { core: true };
    }),
  };
  const service = new ClientProfileFillCompletionService(
    prisma as never,
    workflow as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const internal = service as unknown as Seams;
  internal.requestTaskSweep = jest.fn(() => {
    events.push('outside:sweep');
  });
  const review = { id: runId, tasks: ['core', 'extension'], findings: ['accepted'] };
  jest.spyOn(service, 'getRun').mockImplementation(async () => {
    events.push('outside:read');
    return review;
  });
  return { service, internal, prisma, workflow, tx, calls, events, review };
}

describe('Completion run lifecycle — extension seeding', () => {
  test('seeds the canonical seven task scopes despite duplicate inserts and merges the setup marker in the same transaction', async () => {
    const h = harness({ seedChanged: 0 });
    await h.internal.ensureCompletionTasks(ctx, clientId, runId);
    const seed = h.calls.find((call) => call.operation === 'seed-run')!;
    expect(seed.args).toEqual([runId, ctx.tenantId, clientId]);
    expect(seed.sql).toContain('workflow_version >= 2');
    const inserts = h.calls.filter((call) => call.operation === 'seed-task');
    expect(inserts.map((call) => call.args)).toEqual(
      buildClientProfileFillCompletionPlan().map((task) => [
        runId,
        ctx.tenantId,
        clientId,
        task.taskType,
        task.taskKey,
        task.dependsOn,
      ]),
    );
    expect(
      inserts.every((call) => call.sql.includes('ON CONFLICT (run_id, task_key) DO NOTHING')),
    ).toBe(true);
    const marker = h.calls.at(-1)!;
    expect(marker.sql).toContain('setup_jsonb = setup_jsonb ||');
    expect(marker.sql).toContain('"completionWorkflowVersion":1');
    expect(marker.args).toEqual([runId, ctx.tenantId, clientId]);
    expect(new Set(h.calls.map((call) => call.transaction))).toEqual(new Set([1]));
    expect(h.events.at(-1)).toBe('1:commit');
  });
  test('rejects an absent or old-version run before any task or setup write', async () => {
    const h = harness({ seedFound: false });
    await expect(h.internal.ensureCompletionTasks(ctx, clientId, runId)).rejects.toThrow(
      'Agentic Fill with Meri run not found',
    );
    expect(h.tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(h.events).toEqual(['1:seed-run', '1:rollback']);
  });
  test('starts the core run, seeds extensions, commits, then requests sweep and reads the full run', async () => {
    const h = harness();
    const input = { sources: ['lda' as const] };
    expect(await h.service.startRun(ctx, clientId, input)).toBe(h.review);
    expect(h.workflow.startRun).toHaveBeenCalledWith(ctx, clientId, input);
    expect(h.events.slice(0, 3)).toEqual(['1:active-run', '1:commit', 'outside:workflow-start']);
    expect(h.events.slice(-3)).toEqual(['2:commit', 'outside:sweep', 'outside:read']);
  });
});

describe('Completion run lifecycle — existing run and cancellation', () => {
  test('returns an active extension run without starting or seeding another core run', async () => {
    const h = harness({ activeRun: 'existing-run' });
    await h.service.startRun(ctx, clientId, { sources: ['lda'] });
    expect(h.service.getRun).toHaveBeenCalledWith(ctx, clientId, 'existing-run');
    expect(h.workflow.startRun).not.toHaveBeenCalled();
    expect(h.tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(h.internal.requestTaskSweep).not.toHaveBeenCalled();
  });
  test('delegates a core-only cancellation after access/presence reads without extension writes or a second run read', async () => {
    const h = harness({ present: false });
    expect(await h.service.cancelRun(ctx, clientId, runId)).toEqual({ core: true });
    expect(h.prisma.withTenantUser).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      expect.any(Function),
    );
    expect(h.workflow.cancelRun).toHaveBeenCalledWith(ctx, clientId, runId);
    expect(h.tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(h.service.getRun).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      '1:access',
      '1:commit',
      '2:presence',
      '2:commit',
      'outside:core-cancel',
    ]);
  });
  test('locks scoped run before cancelling extension, core and run state atomically and reading after commit', async () => {
    const h = harness();
    expect(await h.service.cancelRun(ctx, clientId, runId)).toBe(h.review);
    const lock = h.calls.find((call) => call.operation === 'run-lock')!;
    expect(lock.args).toEqual([runId, ctx.tenantId, clientId]);
    expect(lock.sql).toContain('FOR UPDATE');
    const writes = h.calls.filter((call) => call.operation.endsWith('write'));
    expect(writes.map((call) => call.operation)).toEqual([
      'extension-write',
      'core-write',
      'run-write',
    ]);
    expect(writes.every((call) => call.transaction === lock.transaction)).toBe(true);
    expect(writes.map((call) => call.args)).toEqual(Array(3).fill([runId, ctx.tenantId, clientId]));
    expect(writes[0]!.sql).toContain("status IN ('queued', 'running')");
    expect(writes[1]!.sql).toContain('worker_id = NULL');
    expect(writes[2]!.sql).toContain("status <> 'cancelled'");
    expect(h.events.slice(-2)).toEqual(['3:commit', 'outside:read']);
    expect(h.workflow.cancelRun).not.toHaveBeenCalled();
  });
});

describe('Completion run lifecycle — cancellation row-count gate', () => {
  test.each([0, 2])(
    'rejects cancellation when %s scoped run rows change and never reads a successful review',
    async (changed) => {
      const h = harness({ cancelChanged: changed });
      await expect(h.service.cancelRun(ctx, clientId, runId)).rejects.toThrow(
        'This run cannot be cancelled',
      );
      expect(h.events.at(-1)).toBe('3:rollback');
      expect(h.service.getRun).not.toHaveBeenCalled();
      expect(h.workflow.cancelRun).not.toHaveBeenCalled();
    },
  );
});

describe('Completion run lifecycle — extension retry', () => {
  test('requeues the failed extension and canonical review checks under run lock, commits, then sweeps and reads', async () => {
    const h = harness();
    expect(await h.service.retryTask(ctx, clientId, runId, 'extension-task')).toBe(h.review);
    const lock = h.calls.find((call) => call.operation === 'run-lock')!;
    expect(lock.args).toEqual([runId, ctx.tenantId, clientId]);
    expect(lock.sql).toContain("status <> 'cancelled' FOR UPDATE");
    expect(h.prisma.withTenantUser).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      expect.any(Function),
    );
    const writes = h.calls.filter(
      (call) => call.operation !== 'access' && call.operation !== 'run-lock',
    );
    expect(writes.map((call) => call.operation)).toEqual([
      'extension-write',
      'review-checks',
      'run-write',
    ]);
    expect(writes.map((call) => call.args)).toEqual([
      ['extension-task', runId, ctx.tenantId, clientId],
      [runId, ctx.tenantId],
      [runId, ctx.tenantId],
    ]);
    expect(writes.every((call) => call.transaction === lock.transaction)).toBe(true);
    expect(writes[0]!.sql).toContain("status = 'failed'");
    expect(writes[0]!.sql).toContain('max_attempts = GREATEST(max_attempts, attempt + 3)');
    expect(writes[1]!.sql).toContain(
      "task_type IN ('reconciliation', 'completion_audit') AND status <> 'cancelled'",
    );
    expect(writes[1]!.sql).toContain("output_summary_jsonb = '{}'::jsonb");
    expect(writes[2]!.sql).toContain("status = 'running', stage = 'research'");
    expect(h.workflow.retryTask).not.toHaveBeenCalled();
    expect(h.events.slice(-3)).toEqual(['2:commit', 'outside:sweep', 'outside:read']);
  });
  test('rejects a missing/cancelled scoped run before writes, fallback, sweep or read', async () => {
    const h = harness({ lockFound: false });
    await expect(h.service.retryTask(ctx, clientId, runId, 'task')).rejects.toThrow(
      'This run cannot be retried',
    );
    expect(h.events).toEqual(['1:access', '1:commit', '2:run-lock', '2:rollback']);
    expect(h.tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(h.workflow.retryTask).not.toHaveBeenCalled();
    expect(h.internal.requestTaskSweep).not.toHaveBeenCalled();
    expect(h.service.getRun).not.toHaveBeenCalled();
  });
});

describe('Completion run lifecycle — retry fallback and transaction failure', () => {
  test.each([0, 2])(
    'falls back to the core retry for %s extension changes before late-bound sweep and fresh run read',
    async (changed) => {
      const h = harness({ retryChanged: changed });
      expect(await h.service.retryTask(ctx, clientId, runId, 'core-task')).toBe(h.review);
      expect(
        h.calls.filter((call) => call.operation.endsWith('write')).map((call) => call.operation),
      ).toEqual(['extension-write']);
      expect(h.workflow.retryTask).toHaveBeenCalledWith(ctx, clientId, runId, 'core-task');
      expect(h.events.slice(-4)).toEqual([
        '2:commit',
        'outside:core-retry',
        'outside:sweep',
        'outside:read',
      ]);
    },
  );
  test('does not fall back or request a read when canonical review-check requeue fails in the extension transaction', async () => {
    const h = harness({ failWrite: 'review-checks' });
    await expect(h.service.retryTask(ctx, clientId, runId, 'extension-task')).rejects.toThrow(
      'Failed review-checks',
    );
    expect(h.events.at(-1)).toBe('2:rollback');
    expect(h.calls.filter((call) => call.operation === 'run-write')).toEqual([]);
    expect(h.workflow.retryTask).not.toHaveBeenCalled();
    expect(h.internal.requestTaskSweep).not.toHaveBeenCalled();
    expect(h.service.getRun).not.toHaveBeenCalled();
  });
});
