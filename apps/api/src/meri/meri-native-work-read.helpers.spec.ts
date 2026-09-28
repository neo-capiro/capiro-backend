import type { TenantContext } from '@capiro/shared';
import { classifyApiToolReadOutcome } from '@capiro/shared/meri-read-outcome';
import { buildMeriTaskReadResult, parseMeriTaskReadInput } from './meri-task-read.helpers';
import {
  buildMeriActionItemReadResult,
  parseMeriActionItemReadInput,
} from './meri-action-item-read.helpers';
import {
  currentNativeWorkSourceScopeAuthorization,
  currentOwnerResultAuthorizesReplay,
  supportsDurableOwnerReauthorization,
} from './meri-research-replay-authorization';
import { publicResearchSourceTool } from './meri-report-provenance';
import { researchToolVersion, sealDurableResearchResult } from './meri-research-durable-result';
import { MeriResearchService } from './meri-research.service';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
const clone = <T>(value: T): T => structuredClone(value);
const statuses = ['todo', 'in_progress', 'done', 'blocked', 'canceled'];

function task(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    clientId: 'client-1',
    meetingId: 'meeting-1',
    contactId: null,
    mailThreadId: 'thread-1',
    title: `Task ${id}`,
    description: 'Exact task body',
    ownerUserId: null,
    dueDate: null,
    status: 'done',
    sourceType: 'meeting',
    sourceId: 'meeting-1',
    createdByUserId: 'user-1',
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
    updatedAt: new Date(`2026-09-2${id === 'task-1' ? '1' : '2'}T00:00:00.000Z`),
    client: { id: 'client-1', name: 'Aster' },
    meeting: { id: 'meeting-1', subject: 'Demo review' },
    ...overrides,
  } as any;
}

function action(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    clientId: 'client-1',
    clientName: 'Aster',
    peCode: null,
    programId: null,
    deltaId: null,
    actionType: 'monitor',
    issueTitle: `Recommendation ${id}`,
    whatChanged: 'A source changed.',
    whyItMatters: 'Client impact.',
    recommendedAction: 'Consider a follow-up.',
    targetAudience: [],
    suggestedArtifactType: null,
    deadline: null,
    deadlineSource: null,
    ownerUserId: null,
    priority: 2,
    confidence: { materiality: 'medium' },
    uncertainty: null,
    evidence: [{ sourceType: 'delta', sourceId: 'delta-1', description: 'Observed delta' }],
    status: 'outreach_completed',
    dismissalReason: null,
    outcome: 'Recommendation workflow closed.',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: id === 'action-1' ? '2026-09-21T00:00:00.000Z' : '2026-09-22T00:00:00.000Z',
    ...overrides,
  } as any;
}

describe('canonical native task/action-item reads', () => {
  it('returns exact task fields, unknown owner/date, version/hash, and does not promote done to delivery', () => {
    const selection = parseMeriTaskReadInput(ctx, { clientId: 'client-1' }, 'client-1', statuses);
    const result = buildMeriTaskReadResult(ctx, selection, {
      rows: [task('task-1')],
      total: 1,
      sourceStatus: 'healthy',
      sourceReason: null,
    });
    expect(result.tasks[0]).toMatchObject({
      id: 'task-1',
      title: 'Task task-1',
      body: 'Exact task body',
      ownerUserId: null,
      dueDate: null,
      clientId: 'client-1',
      meetingId: 'meeting-1',
      sourceId: 'meeting-1',
      recordKind: 'native_task',
      recommendation: false,
      nativeCompletion: { completed: true, establishesDeliveryOrAcceptance: false },
      sourceProof: { owner: 'engagement_tasks', sourceVersion: '2026-09-21T00:00:00.000Z' },
    });
    expect(result.tasks[0]!.sourceProof.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(classifyApiToolReadOutcome('query_tasks', result)).toEqual({ kind: 'complete' });
    expect(currentOwnerResultAuthorizesReplay('query_tasks', result, clone(result))).toBe(true);
  });

  it('paginates every task honestly, distinguishes complete empty, partial mutation, and rejects dedup ambiguity', () => {
    const firstSelection = parseMeriTaskReadInput(
      ctx,
      { clientId: 'client-1', limit: 1 },
      'client-1',
      statuses,
    );
    const first = buildMeriTaskReadResult(ctx, firstSelection, {
      rows: [task('task-1')],
      total: 2,
      sourceStatus: 'healthy',
      sourceReason: null,
    });
    expect(classifyApiToolReadOutcome('query_tasks', first)).toEqual({
      kind: 'partial',
      reason: 'query_tasks_coverage_incomplete',
    });
    const secondSelection = parseMeriTaskReadInput(
      ctx,
      { clientId: 'client-1', limit: 1, cursor: first.coverage.nextCursor },
      'client-1',
      statuses,
    );
    const second = buildMeriTaskReadResult(ctx, secondSelection, {
      rows: [task('task-2')],
      total: 2,
      sourceStatus: 'healthy',
      sourceReason: null,
    });
    expect(new Set([...first.tasks, ...second.tasks].map((row) => row.id))).toEqual(
      new Set(['task-1', 'task-2']),
    );
    expect(second.coverage).toMatchObject({ paginationComplete: true, complete: false });

    const empty = buildMeriTaskReadResult(ctx, firstSelection, {
      rows: [],
      total: 0,
      sourceStatus: 'healthy',
      sourceReason: null,
    });
    expect(empty.coverage.absenceSupported).toBe(true);
    expect(classifyApiToolReadOutcome('query_tasks', empty)).toEqual({ kind: 'empty' });

    const changed = buildMeriTaskReadResult(ctx, firstSelection, {
      rows: [],
      total: 1,
      sourceStatus: 'degraded',
      sourceReason: 'task_source_changed_during_read',
    });
    expect(changed.coverage.absenceSupported).toBe(false);
    expect(classifyApiToolReadOutcome('query_tasks', changed)).toEqual({
      kind: 'partial',
      reason: 'query_tasks_source_changed',
    });
    expect(() =>
      buildMeriTaskReadResult(ctx, firstSelection, {
        rows: [task('task-1'), task('task-1')],
        total: 2,
        sourceStatus: 'healthy',
        sourceReason: null,
      }),
    ).toThrow('ambiguous');
  });

  it('keeps an action recommendation distinct from an accepted/completed task and verifies current versions', () => {
    const selection = parseMeriActionItemReadInput(ctx, { clientId: 'client-1' }, 'client-1');
    const result = buildMeriActionItemReadResult(ctx, selection, {
      data: [action('action-1')],
      total: 1,
      page: 1,
      limit: 20,
      sourceStatus: 'healthy',
      sourceReason: null,
    });
    expect(result.actions[0]).toMatchObject({
      id: 'action-1',
      title: 'Recommendation action-1',
      body: 'Consider a follow-up.',
      status: 'outreach_completed',
      ownerUserId: null,
      deadline: null,
      recordKind: 'action_recommendation',
      recommendation: true,
      acceptedAsTask: false,
      nativeCompletion: { completed: false, establishesDeliveryOrAcceptance: false },
    });
    expect(classifyApiToolReadOutcome('query_action_items', result)).toEqual({ kind: 'complete' });
    expect(currentOwnerResultAuthorizesReplay('query_action_items', result, clone(result))).toBe(
      true,
    );
    const edited = clone(result);
    edited.actions[0]!.body = 'Edited recommendation';
    expect(currentOwnerResultAuthorizesReplay('query_action_items', result, edited)).toBe(false);
    for (const [field, value] of [
      ['targetAudience', [{ kind: 'office', id: 'private', label: 'Private audience' }]],
      ['priority', 99],
      ['confidence', { clientRelevance: 'low' }],
      ['uncertainty', 'New uncertainty'],
      ['dismissalReason', 'New reason'],
    ] as const) {
      const changed = clone(result);
      changed.actions[0]![field] = value as never;
      expect(currentOwnerResultAuthorizesReplay('query_action_items', result, changed)).toBe(false);
    }
  });

  it('publishes only the finite canonical families and requires focused current wall authority', async () => {
    for (const tool of ['query_tasks', 'query_action_items']) {
      expect(supportsDurableOwnerReauthorization(tool)).toBe(true);
      expect(publicResearchSourceTool(tool)).toBe(tool);
    }
    const selection = parseMeriTaskReadInput(ctx, { clientId: 'client-1' }, 'client-1', statuses);
    const saved = buildMeriTaskReadResult(ctx, selection, {
      rows: [task('task-1')],
      total: 1,
      sourceStatus: 'healthy',
      sourceReason: null,
    });
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]) };
    await expect(
      currentNativeWorkSourceScopeAuthorization({
        tx: tx as never,
        ctx,
        sessionClientId: 'client-1',
        tool: 'query_tasks',
        originalInput: { clientId: 'client-1' },
        savedResult: saved,
      }),
    ).resolves.toMatchObject({ requestedClientId: 'client-1' });
    await expect(
      currentNativeWorkSourceScopeAuthorization({
        tx: tx as never,
        ctx,
        sessionClientId: null,
        tool: 'query_tasks',
        originalInput: { clientId: 'client-1' },
        savedResult: saved,
      }),
    ).resolves.toBeNull();
    tx.$queryRawUnsafe.mockResolvedValueOnce([{ allowed: false }]);
    await expect(
      currentNativeWorkSourceScopeAuthorization({
        tx: tx as never,
        ctx,
        sessionClientId: 'client-1',
        tool: 'query_tasks',
        originalInput: { clientId: 'client-1' },
        savedResult: saved,
      }),
    ).resolves.toBeNull();
  });

  it('replays a receipted task only after focused current-owner authorization', async () => {
    const selection = parseMeriTaskReadInput(ctx, { clientId: 'client-1' }, 'client-1', statuses);
    const saved = buildMeriTaskReadResult(ctx, selection, {
      rows: [task('task-1')],
      total: 1,
      sourceStatus: 'healthy',
      sourceReason: null,
    });
    const input = { clientId: 'client-1' };
    const schema = { type: 'object', properties: { clientId: { type: 'string' } } };
    const toolVersion = researchToolVersion(schema);
    const sealed = sealDurableResearchResult({
      executionId: 'execution-1',
      providerCallId: 'provider-1',
      runId: 'run-1',
      leaseEpoch: 1,
      tool: 'query_tasks',
      toolVersion,
      classifier: 'complete',
      input,
      result: saved,
      completedAt: '2026-09-28T00:00:00.000Z',
    });
    const receipt = {
      version: 2,
      receiptId: 'receipt-1',
      runId: 'run-1',
      leaseEpoch: 1,
      sequence: 1,
      effectClass: 'safe_read',
      toolCallId: 'provider-1',
      tool: 'query_tasks',
      label: 'Tasks',
      status: 'complete',
      summary: 'Completed',
      completedAt: '2026-09-28T00:00:00.000Z',
      executionId: 'execution-1',
      providerCallId: 'provider-1',
      toolVersion,
      inputSha256: sealed.envelope.inputSha256,
      resultSha256: sealed.envelope.resultSha256,
      resultBodySha256: sealed.bodySha256,
      resultRef: 'safe-result-1',
      resultByteSize: sealed.byteSize,
      classifier: 'complete',
    };
    const session: any = {
      id: 'session-1',
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      clientId: 'client-1',
      metadata: {
        backingConversationId: 'conversation-1',
        run: {
          id: 'run-2',
          leaseEpoch: 2,
          eventSequence: 1,
          phase: 'research',
          status: 'running',
          stage: 'Researching',
          startedAt: '2026-09-28T00:01:00.000Z',
          heartbeatAt: new Date().toISOString(),
        },
        durableStepReceipts: [receipt],
      },
    };
    const tx = {
      clioResearchSession: { findFirst: jest.fn(async () => session) },
      clioArtifact: { findFirst: jest.fn().mockResolvedValue({ bodyText: sealed.body }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    };
    const execute = jest.fn().mockResolvedValue(clone(saved));
    const service = Object.assign(Object.create(MeriResearchService.prototype), {
      prisma: {
        withTenant: jest.fn(async (_tenant: string, fn: (value: typeof tx) => unknown) => fn(tx)),
      },
      tools: { execute },
      assertResearchPublicationAuthorized: jest.fn(),
      assertCurrentSafeReadPolicy: jest.fn(),
    }) as MeriResearchService;
    const request = { leaseEpoch: 2, tool: 'query_tasks', toolVersion, input };
    await expect(
      service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toMatchObject({
      replayed: true,
      result: { tasks: [{ id: 'task-1' }] },
    });
    expect(execute).toHaveBeenCalledWith(ctx, 'query_tasks', input);

    session.clientId = null;
    execute.mockClear();
    await expect(
      service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toEqual({
      replayed: false,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
