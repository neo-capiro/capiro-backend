import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from '../clients/client-ordered-owner.access.js';
import { assertOwnedResearchPortfolioTask } from '../engagement/research-portfolio-task-access.js';
import {
  ClassicOutreachObservationChangedError,
  ClassicOutreachObservationIncompleteError,
  withClassicOutreachEligibleIds,
} from '../engagement/classic-outreach-authority.js';
import {
  readClientRecordedActivityIndex,
  recordedActivityScore,
} from './client-recorded-activity-index.js';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { IntelligenceController } from './intelligence.controller.js';
import { IntelligenceService } from './intelligence.service.js';

jest.mock('../clients/client-ordered-owner.access.js', () => ({ requireOwnerClient: jest.fn() }));
jest.mock('../engagement/research-portfolio-task-access.js', () => ({
  assertOwnedResearchPortfolioTask: jest.fn(),
}));
jest.mock('../engagement/classic-outreach-authority.js', () => ({
  ...jest.requireActual('../engagement/classic-outreach-authority.js'),
  withClassicOutreachEligibleIds: jest.fn(),
}));
const ctx = {
  tenantId: 'synthetic-tenant',
  userId: 'synthetic-actor',
  clerkUserId: 'synthetic-clerk',
  role: 'standard_user',
} as TenantContext;
const asOf = new Date('2026-10-31T12:00:00.000Z');
const day = 86_400_000;
const ago = (days: number) => new Date(asOf.getTime() - days * day);
const owner = jest.mocked(requireOwnerClient);
const taskAccess = jest.mocked(assertOwnedResearchPortfolioTask);
const classic = jest.mocked(withClassicOutreachEligibleIds);
function harness() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    meeting: { findMany: jest.fn().mockResolvedValue([]) },
    mailThread: { findMany: jest.fn().mockResolvedValue([]) },
    engagementTask: { findMany: jest.fn().mockResolvedValue([]) },
    meetingDebrief: { findMany: jest.fn().mockResolvedValue([]) },
    outreachRecord: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const withTenant = jest.fn(async (_tenant, read) => read(tx));
  return {
    tx,
    withTenant,
    read: (signal?: AbortSignal) =>
      readClientRecordedActivityIndex(
        { withTenant } as unknown as PrismaService,
        ctx,
        'synthetic-client',
        signal,
        () => asOf,
      ),
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  owner.mockResolvedValue({ version: 1, primary: null });
  taskAccess.mockResolvedValue(undefined);
  classic.mockImplementation(async (_prisma, _ctx, _scope, _control, read) => read(['outreach']));
});
it('publishes a complete empty zero only after two coherent observations and current authority', async () => {
  const h = harness();
  expect(await h.read()).toMatchObject({
    version: 1,
    status: 'complete',
    score: 0,
    priorScore: 0,
    trend: 'stable',
    asOf: asOf.toISOString(),
    scope: { tenantId: ctx.tenantId, actorUserId: ctx.userId, clientId: 'synthetic-client' },
    window: { from: ago(7).toISOString(), to: asOf.toISOString() },
    comparisonWindow: { from: ago(14).toISOString(), to: ago(7).toISOString() },
  });
  expect(h.withTenant).toHaveBeenCalledTimes(2);
  expect(owner).toHaveBeenCalledTimes(4);
  expect(owner).toHaveBeenCalledWith(
    expect.anything(),
    ctx,
    'synthetic-client',
    false,
    false,
    'share',
  );
});
it('preserves the five weights and caps each period independently', () => {
  expect(
    recordedActivityScore({
      meetings: 1,
      emails: 1,
      tasksCompleted: 1,
      debriefs: 1,
      outreachSent: 1,
    }),
  ).toBe(52);
  expect(
    recordedActivityScore({
      meetings: 7,
      emails: 0,
      tasksCompleted: 0,
      debriefs: 0,
      outreachSent: 0,
    }),
  ).toBe(100);
});
it('uses the exact seven-day boundary, thread count and done-task update timestamp', async () => {
  const h = harness();
  h.tx.meeting.findMany.mockResolvedValue([{ id: 'meeting', startsAt: ago(7), updatedAt: ago(1) }]);
  h.tx.mailThread.findMany.mockResolvedValue([
    { id: 'thread', lastMessageAt: ago(14), updatedAt: ago(1) },
  ]);
  h.tx.engagementTask.findMany.mockResolvedValue([{ id: 'task', updatedAt: ago(1) }]);
  h.tx.meetingDebrief.findMany.mockResolvedValue([
    { id: 'debrief', createdAt: ago(1), confidential: false },
  ]);
  h.tx.outreachRecord.findMany.mockResolvedValue([{ id: 'outreach', sentAt: ago(1) }]);
  expect(await h.read()).toMatchObject({
    score: 50,
    priorScore: 2,
    trend: 'improving',
    breakdown: { meetings: 1, emails: 0, tasksCompleted: 1, debriefs: 1, outreachSent: 1 },
    priorBreakdown: { meetings: 0, emails: 1, tasksCompleted: 0, debriefs: 0, outreachSent: 0 },
  });
});
it.each([
  [3, 0, 'improving'],
  [0, 3, 'declining'],
  [2, 0, 'stable'],
  [0, 2, 'stable'],
])(
  'retains trend threshold for %s current / %s prior mail threads',
  async (current, prior, trend) => {
    const h = harness();
    h.tx.mailThread.findMany.mockResolvedValue([
      ...Array.from({ length: current as number }, (_, id) => ({
        id: 'c' + id,
        lastMessageAt: ago(1),
      })),
      ...Array.from({ length: prior as number }, (_, id) => ({
        id: 'p' + id,
        lastMessageAt: ago(8),
      })),
    ]);
    expect(await h.read()).toMatchObject({ trend });
  },
);
it('binds all populations to tenant/client and excludes future/canceled/deleted sources in SQL', async () => {
  const h = harness();
  await h.read();
  for (const delegate of [
    h.tx.meeting,
    h.tx.mailThread,
    h.tx.engagementTask,
    h.tx.meetingDebrief,
    h.tx.outreachRecord,
  ]) {
    expect(delegate.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { tenantId: ctx.tenantId, clientId: 'synthetic-client' },
      take: 251,
      orderBy: { id: 'asc' },
    });
  }
  expect(h.tx.meeting.findMany.mock.calls[0]?.[0].where).toMatchObject({
    startsAt: { gte: ago(14), lt: asOf },
    AND: [
      { OR: [{ createdByUserId: ctx.userId }, { connection: { createdByUserId: ctx.userId } }] },
      { status: { notIn: expect.arrayContaining(['canceled', 'cancelled', 'deleted']) } },
    ],
  });
  expect(h.tx.mailThread.findMany.mock.calls[0]?.[0].where).toMatchObject({
    connection: { createdByUserId: ctx.userId },
    messages: { some: { removedAt: null } },
    lastMessageAt: { gte: ago(14), lt: asOf },
  });
  expect(h.tx.engagementTask.findMany.mock.calls[0]?.[0].where).toMatchObject({
    status: 'done',
    updatedAt: { gte: ago(14), lt: asOf },
  });
  expect(h.tx.meetingDebrief.findMany.mock.calls[0]?.[0].where.meeting).toMatchObject({
    tenantId: ctx.tenantId,
    clientId: 'synthetic-client',
    startsAt: { lt: asOf },
  });
  expect(h.tx.outreachRecord.findMany.mock.calls[0]?.[0].where).toMatchObject({
    createdByUserId: ctx.userId,
    deletedAt: null,
    sentAt: { gte: ago(14), lt: asOf },
    AND: [{ type: { notIn: ['outreach_v3'] } }],
  });
});
it('omits restricted debriefs, private research tasks and noneligible Classic sources', async () => {
  const h = harness();
  h.tx.meetingDebrief.findMany.mockResolvedValue([
    {
      id: 'private',
      createdAt: ago(1),
      confidential: true,
      authorUserId: 'other',
      accessLevel: 'private',
    },
    {
      id: 'author',
      createdAt: ago(1),
      confidential: true,
      authorUserId: ctx.userId,
      accessLevel: 'private',
    },
  ]);
  h.tx.engagementTask.findMany.mockResolvedValue([{ id: 'private-task', updatedAt: ago(1) }]);
  taskAccess.mockRejectedValue(new NotFoundException());
  h.tx.outreachRecord.findMany.mockResolvedValue([{ id: 'unreadable', sentAt: ago(1) }]);
  expect(await h.read()).toMatchObject({
    score: 20,
    breakdown: { debriefs: 1, tasksCompleted: 0, outreachSent: 0 },
  });
  expect(classic).toHaveBeenCalledWith(
    expect.anything(),
    ctx,
    { kind: 'client', clientId: 'synthetic-client' },
    { maxCandidates: 100, assertActive: expect.any(Function) },
    expect.any(Function),
  );
});
it.each([new ForbiddenException(), new NotFoundException()])(
  'propagates canonical scope denial',
  async (error) => {
    const h = harness();
    owner.mockRejectedValue(error);
    await expect(h.read()).rejects.toBe(error);
    expect(h.tx.meeting.findMany).not.toHaveBeenCalled();
  },
);
it('refuses when membership/client/wall changes before the second observation', async () => {
  const h = harness();
  owner
    .mockResolvedValueOnce({ version: 1, primary: null })
    .mockResolvedValueOnce({ version: 1, primary: null })
    .mockRejectedValueOnce(new NotFoundException());
  await expect(h.read()).rejects.toBeInstanceOf(NotFoundException);
});
it('withholds every count when a population changes, even if the score is still capped', async () => {
  const h = harness();
  const rows = Array.from({ length: 8 }, (_, id) => ({ id: String(id), startsAt: ago(1) }));
  h.tx.meeting.findMany
    .mockResolvedValueOnce(rows)
    .mockResolvedValueOnce([...rows, { id: 'new', startsAt: ago(1) }]);
  expect(await h.read()).toMatchObject({
    status: 'incomplete',
    reason: 'changed',
    score: null,
    breakdown: null,
    trend: null,
  });
});
it('does not turn a source access revocation into a lower complete score', async () => {
  const h = harness();
  h.tx.engagementTask.findMany.mockResolvedValue([{ id: 'task', updatedAt: ago(1) }]);
  taskAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new NotFoundException());
  expect(await h.read()).toMatchObject({ status: 'incomplete', reason: 'changed', score: null });
});
it('refuses overflow instead of taking the first 250', async () => {
  const h = harness();
  h.tx.meeting.findMany.mockResolvedValue(
    Array.from({ length: 251 }, (_, id) => ({ id, startsAt: ago(1) })),
  );
  expect(await h.read()).toMatchObject({
    status: 'incomplete',
    reason: 'capacity',
    score: null,
    breakdown: null,
  });
});
it.each([
  new ClassicOutreachObservationIncompleteError(),
  new ClassicOutreachObservationChangedError(),
])('propagates canonical Classic incompleteness without a partial score', async (error) => {
  const h = harness();
  classic.mockRejectedValue(error);
  expect(await h.read()).toMatchObject({
    status: 'incomplete',
    score: null,
    priorScore: null,
    breakdown: null,
  });
});
it('sanitizes an operational failure and never returns empty zero', async () => {
  const h = harness();
  h.tx.mailThread.findMany.mockRejectedValue(new Error('private database detail'));
  await expect(h.read()).rejects.toMatchObject({
    response: {
      code: 'RECORDED_ACTIVITY_UNAVAILABLE',
      message: 'Recorded activity is temporarily unavailable.',
    },
  });
});
it('rejects a canceled request before opening a transaction', async () => {
  const h = harness();
  const abort = new AbortController();
  abort.abort();
  await expect(h.read(abort.signal)).rejects.toMatchObject({ status: 503 });
  expect(h.withTenant).not.toHaveBeenCalled();
});
it('mounts the existing health-score route on the actor-qualified facade, keeping legacy calls separate', async () => {
  expect(Reflect.getMetadata('path', IntelligenceController.prototype.getHealthScore)).toBe(
    'clients/:clientId/health-score',
  );
  const getRecordedActivityIndex = jest.fn().mockResolvedValue({ status: 'complete', score: 0 });
  const facade = Object.assign(Object.create(IntelligenceService.prototype), {
    clientSources: { health: { getRecordedActivityIndex } },
  }) as IntelligenceService;
  const signal = new AbortController().signal;
  expect(await facade.getRecordedActivityIndex(ctx, 'synthetic-client', signal)).toEqual({
    status: 'complete',
    score: 0,
  });
  expect(getRecordedActivityIndex).toHaveBeenCalledWith(ctx, 'synthetic-client', signal);
  expect(IntelligenceService.prototype.computeEngagementHealth.length).toBe(2);
});
it.each(['success', 'failure', 'disconnect'])(
  'cleans controller listeners after %s',
  async (outcome) => {
    const request = Object.assign(new EventEmitter(), { aborted: false }) as unknown as Request;
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      setHeader: jest.fn(),
    }) as unknown as Response;
    let captured: AbortSignal | undefined;
    const getRecordedActivityIndex = jest.fn(async (_ctx, _clientId, signal: AbortSignal) => {
      captured = signal;
      expect(request.listenerCount('aborted')).toBe(1);
      expect(response.listenerCount('close')).toBe(1);
      if (outcome === 'disconnect') response.emit('close');
      if (outcome !== 'success') throw new Error('test failure');
      return { status: 'complete', score: 0 };
    });
    const controller = Object.assign(Object.create(IntelligenceController.prototype), {
      service: { getRecordedActivityIndex },
    }) as IntelligenceController;
    const read = controller.getHealthScore(ctx, 'synthetic-client', request, response);
    if (outcome === 'success') await expect(read).resolves.toMatchObject({ score: 0 });
    else await expect(read).rejects.toThrow('test failure');
    expect(captured?.aborted).toBe(outcome === 'disconnect');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(request.listenerCount('aborted')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  },
);
