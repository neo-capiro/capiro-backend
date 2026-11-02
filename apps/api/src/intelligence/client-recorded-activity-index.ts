import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from '../clients/client-ordered-owner.access.js';
import {
  canReadEncryptedEntry,
  ownMailThreadWhere,
  ownMeetingWhere,
  ownOutreachRecordWhere,
} from '../engagement/engagement-access.helpers.js';
import {
  ClassicOutreachObservationChangedError,
  ClassicOutreachObservationIncompleteError,
  withClassicOutreachEligibleIds,
} from '../engagement/classic-outreach-authority.js';
import { assertOwnedResearchPortfolioTask } from '../engagement/research-portfolio-task-access.js';
import {
  RecordedActivityBudget,
  recordedActivityUnavailable,
} from './client-recorded-activity-budget.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_ROWS_PER_SOURCE = 250;
const MAX_OBSERVATION_BYTES = 1_048_576;
const excludedMeetingStatuses = ['pending', 'deleted', 'archived', 'canceled', 'cancelled'];
export type ActivityBreakdown = {
  meetings: number;
  emails: number;
  tasksCompleted: number;
  debriefs: number;
  outreachSent: number;
};
const empty = (): ActivityBreakdown => ({
  meetings: 0,
  emails: 0,
  tasksCompleted: 0,
  debriefs: 0,
  outreachSent: 0,
});
export const recordedActivityScore = (counts: ActivityBreakdown) =>
  Math.min(
    100,
    counts.meetings * 15 +
      counts.emails * 2 +
      counts.tasksCompleted * 10 +
      counts.debriefs * 20 +
      counts.outreachSent * 5,
  );
class IncompleteObservation extends Error {}

async function observe(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  asOf: Date,
  budget: RecordedActivityBudget,
) {
  await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
  const range = { gte: new Date(asOf.getTime() - 2 * WEEK_MS), lt: asOf };
  const base = { tenantId: ctx.tenantId, clientId };
  const page = { take: MAX_ROWS_PER_SOURCE + 1, orderBy: { id: 'asc' as const } };
  // Only bounded metadata is read; bodies, subjects and recipients are not part
  // of the metric. Direct client assignment is the existing measure's scope.
  const meetings = await tx.meeting.findMany({
    where: {
      ...base,
      startsAt: range,
      AND: [ownMeetingWhere(ctx.userId), { status: { notIn: excludedMeetingStatuses } }],
    },
    select: { id: true, startsAt: true, updatedAt: true },
    ...page,
  });
  const emails = await tx.mailThread.findMany({
    where: { ...base, lastMessageAt: range, ...ownMailThreadWhere(ctx.userId) },
    select: { id: true, lastMessageAt: true, updatedAt: true },
    ...page,
  });
  const tasks = await tx.engagementTask.findMany({
    where: { ...base, status: 'done', updatedAt: range },
    select: {
      id: true,
      tenantId: true,
      updatedAt: true,
      sourceType: true,
      sourceId: true,
      ownerUserId: true,
      createdByUserId: true,
    },
    ...page,
  });
  const debriefs = await tx.meetingDebrief.findMany({
    where: {
      ...base,
      createdAt: range,
      meeting: {
        tenantId: ctx.tenantId,
        clientId,
        startsAt: { lt: asOf },
        status: { notIn: excludedMeetingStatuses },
      },
    },
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      confidential: true,
      accessLevel: true,
      authorUserId: true,
    },
    ...page,
  });
  const outreach = await tx.outreachRecord.findMany({
    where: {
      ...base,
      sentAt: range,
      deletedAt: null,
      ...ownOutreachRecordWhere(ctx.userId),
      status: { notIn: ['canceled', 'cancelled', 'deleted'] },
    },
    select: { id: true, sentAt: true, updatedAt: true },
    ...page,
  });
  const populations = [meetings, emails, tasks, debriefs, outreach];
  if (populations.some((rows) => rows.length > MAX_ROWS_PER_SOURCE))
    throw new IncompleteObservation();
  const metadata = JSON.stringify(populations);
  if (Buffer.byteLength(metadata) > MAX_OBSERVATION_BYTES) throw new IncompleteObservation();
  const eligibleTasks = [];
  for (const task of tasks) {
    budget.remaining();
    try {
      await assertOwnedResearchPortfolioTask(tx, ctx, task);
      eligibleTasks.push(task);
    } catch (error) {
      if (!(error instanceof ForbiddenException || error instanceof NotFoundException)) throw error;
    }
  }
  const eligibleDebriefs = debriefs.filter((row) => canReadEncryptedEntry(ctx, row));
  // Reuse the canonical complete Classic population guard, including private
  // saved-prep sources. Its existing 100-candidate ceiling refuses the entire
  // index even when the excess records fall outside this date window.
  const eligibleOutreach = await withClassicOutreachEligibleIds(
    {
      withTenant: async (_tenant, read) => read(tx),
    },
    ctx,
    { kind: 'client', clientId },
    {
      maxCandidates: 100,
      assertActive: () => {
        budget.remaining();
      },
    },
    async (ids) => outreach.filter((row) => ids.includes(row.id)),
  );
  await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
  const current = empty();
  const prior = empty();
  const add = (key: keyof ActivityBreakdown, dates: Array<Date | null>) => {
    for (const date of dates) {
      if (!date || date < range.gte || date >= asOf) throw new IncompleteObservation();
      (date.getTime() >= asOf.getTime() - WEEK_MS ? current : prior)[key] += 1;
    }
  };
  add(
    'meetings',
    meetings.map((row) => row.startsAt),
  );
  add(
    'emails',
    emails.map((row) => row.lastMessageAt),
  );
  add(
    'tasksCompleted',
    eligibleTasks.map((row) => row.updatedAt),
  );
  add(
    'debriefs',
    eligibleDebriefs.map((row) => row.createdAt),
  );
  add(
    'outreachSent',
    eligibleOutreach.map((row) => row.sentAt),
  );
  return {
    current,
    prior,
    key: createHash('sha256')
      .update(
        JSON.stringify([
          metadata,
          eligibleTasks.map((row) => row.id),
          eligibleDebriefs.map((row) => row.id),
          eligibleOutreach.map((row) => row.id),
        ]),
      )
      .digest('hex'),
  };
}

/** Versioned card read. Legacy report/profile/prompt callers retain their API. */
export async function readClientRecordedActivityIndex(
  prisma: PrismaService,
  context: TenantContext,
  clientId: string,
  signal?: AbortSignal,
  now: () => Date = () => new Date(),
) {
  const ctx = { ...context };
  const asOf = now();
  const budget = new RecordedActivityBudget(signal);
  const common = {
    version: 1 as const,
    measure: 'recorded_activity_index' as const,
    basis: 'Recorded activity index',
    disclosure: 'Measures internal logging, not relationship quality or effectiveness.',
    scope: { tenantId: ctx.tenantId, actorUserId: ctx.userId, clientId },
    asOf: asOf.toISOString(),
    period: '7d' as const,
    window: { from: new Date(asOf.getTime() - WEEK_MS).toISOString(), to: asOf.toISOString() },
    comparisonWindow: {
      from: new Date(asOf.getTime() - 2 * WEEK_MS).toISOString(),
      to: new Date(asOf.getTime() - WEEK_MS).toISOString(),
    },
    timestampBasis: {
      meetings: 'startsAt',
      emails: 'mailThread.lastMessageAt',
      tasksCompleted: 'doneTask.updatedAt',
      debriefs: 'createdAt',
      outreachSent: 'sentAt',
    },
  };
  try {
    const read = (tx: Prisma.TransactionClient) => observe(tx, ctx, clientId, asOf, budget);
    const first = await budget.transaction(prisma, ctx.tenantId, read);
    const second = await budget.transaction(prisma, ctx.tenantId, read);
    if (first.key !== second.key) throw new ClassicOutreachObservationChangedError();
    budget.remaining();
    const score = recordedActivityScore(second.current);
    const priorScore = recordedActivityScore(second.prior);
    return {
      ...common,
      status: 'complete' as const,
      reason: null,
      score,
      priorScore,
      breakdown: second.current,
      priorBreakdown: second.prior,
      trend:
        score > priorScore + 5
          ? ('improving' as const)
          : score < priorScore - 5
            ? ('declining' as const)
            : ('stable' as const),
    };
  } catch (error) {
    if (error instanceof ForbiddenException || error instanceof NotFoundException) throw error;
    if (
      error instanceof IncompleteObservation ||
      error instanceof ClassicOutreachObservationIncompleteError ||
      error instanceof ClassicOutreachObservationChangedError
    ) {
      return {
        ...common,
        status: 'incomplete' as const,
        reason:
          error instanceof ClassicOutreachObservationChangedError
            ? ('changed' as const)
            : ('capacity' as const),
        score: null,
        priorScore: null,
        breakdown: null,
        priorBreakdown: null,
        trend: null,
      };
    }
    throw recordedActivityUnavailable();
  }
}
