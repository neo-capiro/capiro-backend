import type { TenantContext } from '@capiro/shared';
import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';

const ctx = { tenantId: 'tenant-one', userId: 'actor-one' } as TenantContext;
const clientId = 'client-one';
const runId = 'run-one';
const completedAt = '2026-10-13T12:00:00.000Z';
interface Options {
  core?: Record<string, unknown>;
  latest?: Record<string, unknown> | null;
  present?: boolean;
  extensions?: Array<Record<string, unknown>>;
}
function harness(options: Options = {}) {
  const core = options.core ?? { id: runId, status: 'running', completedAt, tasks: [] };
  const query = jest.fn(async (sql: string, ..._args: unknown[]) => {
    if (sql.includes('SELECT EXISTS')) return [{ present: options.present ?? true }];
    if (sql.includes('FROM client_profile_fill_extension_task')) return options.extensions ?? [];
    throw new Error(`Unexpected run read: ${sql}`);
  });
  const prisma = {
    withTenant: jest.fn(
      async (_tenant: string, fn: (tx: { $queryRawUnsafe: typeof query }) => unknown) =>
        fn({ $queryRawUnsafe: query }),
    ),
  };
  const workflow = {
    getRun: jest.fn(async () => core),
    getLatest: jest.fn(async () => (options.latest === undefined ? core : options.latest)),
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
  return { service, prisma, workflow, query, core };
}

describe('Completion run read model — core-only and missing latest reads', () => {
  test.each(['getRun', 'getLatest'] as const)(
    '%s returns the unchanged core object when there is no extension ledger',
    async (method) => {
      const h = harness({ present: false });
      const result =
        method === 'getRun'
          ? await h.service.getRun(ctx, clientId, runId)
          : await h.service.getLatest(ctx, clientId);
      expect(result).toBe(h.core);
      expect(h.query).toHaveBeenCalledTimes(1);
      expect(h.query.mock.calls[0]!.slice(1)).toEqual([ctx.tenantId, runId]);
    },
  );
  test.each([
    { label: 'null', latest: null },
    { label: 'missing-id', latest: { status: 'completed' } },
  ])(
    'returns $label latest without extension reads when the core response has no run id',
    async ({ latest }) => {
      const h = harness({ latest });
      expect(await h.service.getLatest(ctx, clientId)).toBe(latest);
      expect(h.query).not.toHaveBeenCalled();
    },
  );
});

describe('Completion run read model — combined terminal status matrix', () => {
  test.each([
    { tasks: ['failed'], status: 'failed', stage: 'failed' },
    { tasks: ['failed', 'skipped'], status: 'partial', stage: 'review_ready' },
    { tasks: ['cancelled'], status: 'completed', stage: 'review_ready' },
    { tasks: ['unknown-status'], status: 'running', stage: 'review_ready' },
    { tasks: [], status: 'running', stage: 'review_ready' },
  ])(
    'merges $tasks into $status/$stage while preserving core completed time',
    async ({ tasks, status, stage }) => {
      const h = harness({
        extensions: tasks.map((value, index) => ({
          taskType: `task-${index}`,
          status: value,
          outputSummary: {},
        })),
      });
      expect(await h.service.getRun(ctx, clientId, runId)).toMatchObject({
        status,
        stage,
        completedAt,
      });
      expect(h.query.mock.calls[1]!.slice(1)).toEqual([ctx.tenantId, clientId, runId]);
      expect(h.query.mock.calls[1]![0]).toContain('ORDER BY created_at ASC, task_key ASC');
    },
  );
});

describe('Completion run read model — active review stages and merge order', () => {
  test.each(['reconciliation', 'completion_audit'])(
    'reports reconciliation while the %s extension is running',
    async (taskType) => {
      const h = harness({ extensions: [{ taskType, status: 'running' }] });
      expect(await h.service.getRun(ctx, clientId, runId)).toMatchObject({
        status: 'running',
        stage: 'reconciliation',
        completedAt: null,
      });
    },
  );
  test('preserves core findings, combines core tasks first, and overwrites only matching extension source states with numeric count', async () => {
    const coreTask = { taskType: 'lda', status: 'queued' };
    const coreFindings = [{ id: 'accepted', status: 'accepted' }];
    const extensions = [
      {
        taskType: 'federal_market',
        status: 'completed',
        outputSummary: { count: '7' },
        errorMessage: null,
      },
      {
        taskType: 'completion_audit',
        status: 'failed',
        outputSummary: {},
        errorMessage: 'unavailable',
      },
    ];
    const h = harness({
      core: {
        id: runId,
        status: 'partial',
        completedAt,
        tasks: [coreTask],
        findings: coreFindings,
        sourceStates: { lda: { count: 2 }, federal_market: { stale: true } },
      },
      extensions,
    });
    const result = await h.service.getRun(ctx, clientId, runId);
    expect(result.tasks).toEqual([coreTask, ...extensions]);
    expect(result.findings).toBe(coreFindings);
    expect(result.sourceStates).toEqual({
      lda: { count: 2 },
      federal_market: { status: 'completed', count: 7, error: null },
      completion_audit: { status: 'failed', count: 0, error: 'unavailable' },
    });
    expect(result.progress).toEqual({
      total: 3,
      queued: 1,
      running: 0,
      completed: 1,
      failed: 1,
      cancelled: 0,
    });
    expect(result).toMatchObject({ status: 'running', stage: 'research', completedAt: null });
    expect(h.core.sourceStates).toEqual({ lda: { count: 2 }, federal_market: { stale: true } });
  });
  test('keeps cancelled run authority while retaining its progress and merged task snapshot', async () => {
    const h = harness({
      core: { id: runId, status: 'cancelled', completedAt, tasks: [] },
      extensions: [{ taskType: 'reconciliation', status: 'running' }],
    });
    expect(await h.service.getRun(ctx, clientId, runId)).toMatchObject({
      status: 'cancelled',
      stage: 'cancelled',
      completedAt,
      progress: { running: 1 },
      tasks: [{ taskType: 'reconciliation', status: 'running' }],
    });
  });
});
