import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  FUNDING_OPPORTUNITY_TASK_SOURCE,
  FundingOpportunityActionsService,
  OPPORTUNITY_ACTION_INTENTS,
} from './funding-opportunity-actions.service.js';

/**
 * P08 — one transaction, or nothing.
 *
 * The defect: the web page posted a task titled `Pursue: X` straight to
 * `/api/engagement/tasks` and did nothing else, so a task saying "pursue this"
 * existed while the opportunity was still an untouched machine suggestion — no
 * owner, no decision, status `suggested`. Two facts, two tables, two requests,
 * either able to succeed alone.
 *
 * So the tests that matter are the FAILURE ones: a rollback in each direction, and
 * a retry that does not duplicate.
 */

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000010';
const USER = '00000000-0000-0000-0000-000000000099';
const OTHER_CLIENT = '00000000-0000-0000-0000-000000000011';
const OTHER_USER = '00000000-0000-0000-0000-000000000098';
const SAM_ID = '00000000-0000-0000-0000-0000000003aa';

interface FakeTask {
  id: string;
  title: string;
  ownerUserId: string | null;
  dueDate: Date | null;
  clientId?: string;
}

interface FakeOpts {
  pursuable?: boolean;
  existingTask?: FakeTask | null;
  legacyTask?: FakeTask | null;
  failDecision?: boolean;
  failTaskInsert?: boolean;
  /** When set, the first `engagementTask.create` throws a P2002-shaped error, and a second `findFirst` returns this row (simulating the race winner). */
  raceWinner?: FakeTask;
  ownerInTenant?: boolean;
  deadline?: string | null;
  workflowOwnerUserId?: string | null;
  workflowFollowUp?: string | null;
  visibleClientIds?: string[];
  workflowRace?: boolean;
  workflowRaceClientId?: string;
}

function makeFake(opts: FakeOpts = {}) {
  const created: any[] = [];
  const decisions: any[] = [];
  let rolledBack = false;

  const rows: any[] = [];
  let raceCommitted = false;
  let workflowRaceCommitted = false;
  for (const [task, legacy] of [
    [opts.existingTask, false],
    [opts.legacyTask, true],
  ] as const) {
    if (task)
      rows.push({
        ...task,
        tenantId: TENANT,
        clientId: task.clientId ?? CLIENT,
        sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
        sourceId: legacy
          ? `sam_gov:${SAM_ID}:pursuit`
          : FundingOpportunityActionsService.taskSourceId(
              task.clientId ?? CLIENT,
              'sam_gov',
              SAM_ID,
              'pursuit',
            ),
      });
  }

  const tx = {
    client: {
      findMany: jest.fn(async () =>
        (opts.visibleClientIds ?? [CLIENT, OTHER_CLIENT]).map((id) => ({ id, memoryWall: false })),
      ),
    },
    clientMemoryAccess: { findMany: jest.fn(async () => []) },
    clientFundingOpportunity: {
      findFirst: jest.fn(async (args: any) =>
        workflowRaceCommitted &&
        args.where.tenantId === TENANT &&
        args.where.clientId === (opts.workflowRaceClientId ?? CLIENT)
          ? { id: 'concurrent-save-workflow' }
          : null,
      ),
    },
    engagementTask: {
      findFirst: jest.fn(async (args: any) => {
        const candidates = [...rows];
        if (raceCommitted && opts.raceWinner)
          candidates.push({
            ...opts.raceWinner,
            tenantId: TENANT,
            clientId: opts.raceWinner.clientId ?? CLIENT,
            sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
            sourceId: FundingOpportunityActionsService.taskSourceId(
              CLIENT,
              'sam_gov',
              SAM_ID,
              'pursuit',
            ),
          });
        return (
          candidates.find((row) =>
            Object.entries(args.where).every(([key, value]) => row[key] === value),
          ) ?? null
        );
      }),
      create: jest.fn(async (args: any) => {
        if (opts.failTaskInsert) throw new Error('task insert failed');
        if (opts.raceWinner && !raceCommitted) {
          raceCommitted = true;
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: '5.22.0',
          });
        }
        created.push(args.data);
        const task = { ...args.data, id: `task-${created.length}` };
        rows.push(task);
        return task;
      }),
    },
  };

  const prisma: any = {
    withTenant: jest.fn(async (_t: string, run: (t: any) => Promise<unknown>) => {
      const rowCount = rows.length;
      try {
        return await run(tx);
      } catch (error) {
        // A real transaction discards every write on throw. The double models that,
        // so a test can assert nothing survived rather than trusting Prisma.
        rolledBack = true;
        rows.length = rowCount;
        created.length = 0;
        decisions.length = 0;
        throw error;
      }
    }),
  };

  const opportunities: any = {
    describeForAction: jest.fn(async () => ({
      title: 'Turbofan Engine Sustainment',
      sourceReference: 'N0001926R0001',
      sourceUrl: 'https://sam.gov/x',
      responseDeadline: opts.deadline === undefined ? '2026-09-01T00:00:00.000Z' : opts.deadline,
      ownerUserId: opts.workflowOwnerUserId ?? null,
      nextActionDueAt: opts.workflowFollowUp ?? null,
      isPursuable: opts.pursuable !== false,
      pursuitRefusal:
        opts.pursuable === false
          ? 'A special notice is informational, not a solicitation, so it cannot be marked as being pursued.'
          : null,
    })),
    assertOwnerAssignable: jest.fn(async (_t: string, userId: string) => {
      if (opts.ownerInTenant === false) throw new BadRequestException('Owner not in tenant');
      return userId;
    }),
    applyActionDecision: jest.fn(async (_tx: unknown, input: any) => {
      if (opts.failDecision) throw new Error('decision write failed');
      if (opts.workflowRace && !workflowRaceCommitted) {
        workflowRaceCommitted = true;
        throw new Prisma.PrismaClientKnownRequestError('Concurrent Save created the workflow', {
          code: 'P2002',
          clientVersion: '5.22.0',
        });
      }
      decisions.push(input);
      return { id: 'wf-1', workflowStatus: input.workflowStatus, decision: input.decision };
    }),
  };

  const service = new FundingOpportunityActionsService(prisma, opportunities);
  return {
    service,
    prisma,
    opportunities,
    created,
    decisions,
    tx,
    wasRolledBack: () => rolledBack,
  };
}

// ── The happy paths ─────────────────────────────────────────────────────────

describe('one action writes both facts', () => {
  test('intent=pursuit creates the task AND records a pursue decision', async () => {
    const { service, created, decisions } = makeFake();
    const result = await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      intent: 'pursuit',
      actorUserId: USER,
    });
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('Pursue: Turbofan Engine Sustainment');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('pursue');
    expect(decisions[0].workflowStatus).toBe('pursuing');
    expect(result.decision).toBe('pursue');
    expect(result.task.reused).toBe(false);
  });

  test('intent=review saves and monitors — it is NOT a pursuit', async () => {
    const { service, created, decisions } = makeFake();
    const result = await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      intent: 'review',
      actorUserId: USER,
    });
    expect(created[0].title).toBe('Review: Turbofan Engine Sustainment');
    expect(decisions[0].decision).toBe('monitor');
    expect(decisions[0].workflowStatus).toBe('saved');
    expect(result.workflowStatus).toBe('saved');
  });

  test('both writes happen on the SAME transaction handle', async () => {
    // The mechanism. If the decision ran on a different connection, neither
    // rollback test below could pass, and the phase would be cosmetic.
    const { service, opportunities, tx } = makeFake();
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'review', actorUserId: USER });
    const [passedTx] = (opportunities.applyActionDecision as jest.Mock).mock.calls[0]!;
    expect(passedTx).toBe(tx);
  });

  test('an explicit follow-up date is shared by the task and opportunity', async () => {
    // Two dates that could drift is how a task says one thing and the inbox says
    // another about the same deadline.
    const { service, created, decisions } = makeFake();
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      intent: 'pursuit',
      actorUserId: USER,
      nextActionDueAt: '2026-08-25T12:00:00.000Z',
    });
    expect(created[0].dueDate?.toISOString()).toBe('2026-08-25T12:00:00.000Z');
    expect(decisions[0].nextActionDueAt?.toISOString()).toBe('2026-08-25T12:00:00.000Z');
  });

  test('an opportunity with no deadline yields no due date on either side', async () => {
    const { service, created, decisions } = makeFake({ deadline: null });
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER });
    expect(created[0].dueDate).toBeNull();
    expect(decisions[0].nextActionDueAt).toBeNull();
  });

  test('a source deadline does not silently become a team follow-up date', async () => {
    const { service, created, decisions } = makeFake();
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'review', actorUserId: USER });
    expect(created[0].dueDate).toBeNull();
    expect(decisions[0].nextActionDueAt).toBeNull();
  });

  test('omitted owner and follow-up inherit existing team choices, never the source deadline', async () => {
    const { service, created, decisions } = makeFake({
      workflowOwnerUserId: OTHER_USER,
      workflowFollowUp: '2026-08-25T12:00:00.000Z',
    });
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER });
    expect(created[0].ownerUserId).toBe(OTHER_USER);
    expect(created[0].dueDate?.toISOString()).toBe('2026-08-25T12:00:00.000Z');
    expect(decisions[0].ownerUserId).toBe(OTHER_USER);
  });

  test('explicit null owner and follow-up clear inherited choices for a new task', async () => {
    const { service, created, decisions } = makeFake({
      workflowOwnerUserId: OTHER_USER,
      workflowFollowUp: '2026-08-25T12:00:00.000Z',
    });
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      intent: 'pursuit',
      actorUserId: USER,
      ownerUserId: null,
      nextActionDueAt: null,
    });
    expect(created[0].ownerUserId).toBeNull();
    expect(created[0].dueDate).toBeNull();
    expect(decisions[0].ownerUserId).toBeNull();
  });

  test.each([undefined, null, '', '   '])(
    'a dated review with nextAction=%s has nonempty next-action text',
    async (nextAction) => {
      const { service, decisions } = makeFake();
      await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
        intent: 'review',
        actorUserId: USER,
        nextAction,
        nextActionDueAt: '2026-08-25T12:00:00.000Z',
      });
      expect(decisions[0].nextAction).toBe('Review: Turbofan Engine Sustainment');
      expect(decisions[0].nextActionDueAt?.toISOString()).toBe('2026-08-25T12:00:00.000Z');
    },
  );

  test('a forecast review uses a user follow-up date and identifies the source accurately', async () => {
    const { service, created, decisions } = makeFake({ pursuable: false, deadline: null });
    await service.act(TENANT, CLIENT, 'agency_forecast', 'forecast-1', {
      intent: 'review',
      actorUserId: USER,
      nextAction: 'Confirm agency acquisition timeline',
      nextActionDueAt: '2026-08-25T12:00:00.000Z',
    });
    expect(created[0].description).toContain('Agency procurement forecast');
    expect(decisions[0].nextAction).toBe('Confirm agency acquisition timeline');
    expect(decisions[0].nextActionDueAt?.toISOString()).toBe('2026-08-25T12:00:00.000Z');
  });

  test('the task is tagged so it can be traced back to the opportunity', async () => {
    const { service, created } = makeFake();
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER });
    expect(created[0].sourceType).toBe(FUNDING_OPPORTUNITY_TASK_SOURCE);
    expect(created[0].sourceId).toBe(
      FundingOpportunityActionsService.taskSourceId(CLIENT, 'sam_gov', SAM_ID, 'pursuit'),
    );
  });
});

// ── Atomicity, in both directions ───────────────────────────────────────────

describe('a failure on either side rolls back BOTH', () => {
  test('a failing decision write discards the task', async () => {
    const { service, created, decisions, wasRolledBack } = makeFake({ failDecision: true });
    await expect(
      service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER }),
    ).rejects.toThrow('decision write failed');
    expect(wasRolledBack()).toBe(true);
    expect(created).toHaveLength(0);
    expect(decisions).toHaveLength(0);
  });

  test('a failing task insert never reaches the decision', async () => {
    const { service, opportunities, decisions } = makeFake({ failTaskInsert: true });
    await expect(
      service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER }),
    ).rejects.toThrow('task insert failed');
    expect(decisions).toHaveLength(0);
    expect(opportunities.applyActionDecision).not.toHaveBeenCalled();
  });
});

// ── Validation happens BEFORE anything is written ───────────────────────────

describe('a refused action leaves nothing behind', () => {
  test('a client outside the actor visibility allowlist is refused before source reads or task writes', async () => {
    const { service, tx, opportunities } = makeFake({ visibleClientIds: [OTHER_CLIENT] });
    await expect(
      service.act(TENANT, CLIENT, 'agency_forecast', 'forecast-1', {
        intent: 'review',
        actorUserId: USER,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(opportunities.describeForAction).not.toHaveBeenCalled();
    expect(tx.engagementTask.create).not.toHaveBeenCalled();
    expect(opportunities.applyActionDecision).not.toHaveBeenCalled();
  });

  test('a non-pursuable notice cannot be pursued, and no task is created', async () => {
    // Order matters. Validating after the insert would leave an orphan task saying
    // "Pursue this" for a notice that can never be pursued.
    const { service, created, tx } = makeFake({ pursuable: false });
    await expect(
      service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(created).toHaveLength(0);
    expect(tx.engagementTask.create).not.toHaveBeenCalled();
  });

  test('the refusal explains itself and points at the alternative', async () => {
    const { service } = makeFake({ pursuable: false });
    await expect(
      service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER }),
    ).rejects.toThrow(/informational/i);
  });

  test('a non-pursuable notice CAN still get a review task', async () => {
    // The escape hatch the refusal names. An award notice is real intelligence; a
    // team must be able to put it on somebody's list without claiming a pursuit.
    const { service, created, decisions } = makeFake({ pursuable: false });
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'review', actorUserId: USER });
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('Review: Turbofan Engine Sustainment');
    expect(decisions[0].decision).toBe('monitor');
  });

  test('an owner outside the tenant is rejected before any write', async () => {
    const { service, created, tx } = makeFake({ ownerInTenant: false });
    await expect(
      service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
        intent: 'pursuit',
        actorUserId: USER,
        ownerUserId: OTHER_USER,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(created).toHaveLength(0);
    expect(tx.engagementTask.create).not.toHaveBeenCalled();
  });

  test('no owner given means no owner check is issued', async () => {
    const { service, opportunities } = makeFake();
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'review', actorUserId: USER });
    expect(opportunities.assertOwnerAssignable).not.toHaveBeenCalled();
  });

  test('an invalid follow-up date is rejected before writing a task', async () => {
    const { service, tx } = makeFake();
    await expect(
      service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
        intent: 'review',
        actorUserId: USER,
        nextActionDueAt: 'not a date',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.engagementTask.create).not.toHaveBeenCalled();
  });
});

// ── Idempotency ─────────────────────────────────────────────────────────────

describe('a retry returns the same task, never a second one', () => {
  test('an existing task for the same intent is reused', async () => {
    // Double-clicked button, retried request, replayed mutation — all land here.
    const { service, created, decisions } = makeFake({
      existingTask: {
        id: 'task-existing',
        title: 'Pursue: Turbofan Engine Sustainment',
        ownerUserId: null,
        dueDate: null,
      },
    });
    const result = await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      intent: 'pursuit',
      actorUserId: USER,
    });
    expect(result.task.id).toBe('task-existing');
    expect(result.task.reused).toBe(true);
    expect(created).toHaveLength(0);
    // The decision is still re-applied: the retry is idempotent, not a no-op, so a
    // decision lost to a half-failed first attempt still lands.
    expect(decisions).toHaveLength(1);
  });

  test('both current and legacy lookups include the actual client', async () => {
    const { service, tx } = makeFake();
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER });
    const [args] = (tx.engagementTask.findFirst as jest.Mock).mock.calls[0]! as [any];
    expect(args.where).toEqual({
      tenantId: TENANT,
      clientId: CLIENT,
      sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
      sourceId: FundingOpportunityActionsService.taskSourceId(CLIENT, 'sam_gov', SAM_ID, 'pursuit'),
    });
    expect(tx.engagementTask.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          tenantId: TENANT,
          clientId: CLIENT,
          sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
          sourceId: `sam_gov:${SAM_ID}:pursuit`,
        },
      }),
    );
  });

  test('review and pursuit are DIFFERENT keys', () => {
    // Escalating a reviewed opportunity to a pursuit is a real second action and
    // deserves its own task. One shared key would silently swallow it.
    const review = FundingOpportunityActionsService.taskSourceId(
      CLIENT,
      'sam_gov',
      SAM_ID,
      'review',
    );
    const pursuit = FundingOpportunityActionsService.taskSourceId(
      CLIENT,
      'sam_gov',
      SAM_ID,
      'pursuit',
    );
    expect(review).not.toBe(pursuit);
  });

  test('the key is derived, not caller-supplied', () => {
    // Two clients cannot disagree about what "the same action" means, and a client
    // cannot collide with another opportunity by reusing a key.
    const controller = readFileSync(join(__dirname, 'funding-opportunities.controller.ts'), 'utf8');
    const dto = /class OpportunityActionDto \{([\s\S]*?)\n\}/.exec(controller);
    expect(dto).not.toBeNull();
    expect(dto![1]!.toLowerCase()).not.toContain('idempotency');
  });

  test.each([...OPPORTUNITY_ACTION_INTENTS])('the %s key is stable across calls', (intent) => {
    expect(FundingOpportunityActionsService.taskSourceId(CLIENT, 'sam_gov', SAM_ID, intent)).toBe(
      FundingOpportunityActionsService.taskSourceId(CLIENT, 'sam_gov', SAM_ID, intent),
    );
  });

  test('different opportunities never share a key', () => {
    const a = FundingOpportunityActionsService.taskSourceId(CLIENT, 'sam_gov', SAM_ID, 'pursuit');
    const b = FundingOpportunityActionsService.taskSourceId(
      CLIENT,
      'grants_gov',
      SAM_ID,
      'pursuit',
    );
    expect(a).not.toBe(b);
  });

  test('two clients pursuing one notice get separate tasks, and each retry reuses its own task', async () => {
    const { service, created } = makeFake();
    const first = await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      intent: 'pursuit',
      actorUserId: USER,
    });
    const second = await service.act(TENANT, OTHER_CLIENT, 'sam_gov', SAM_ID, {
      intent: 'pursuit',
      actorUserId: USER,
    });
    const retry = await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      intent: 'pursuit',
      actorUserId: USER,
    });
    expect(first.task.id).not.toBe(second.task.id);
    expect(retry.task.id).toBe(first.task.id);
    expect(retry.task.reused).toBe(true);
    expect(created.map((task) => task.clientId)).toEqual([CLIENT, OTHER_CLIENT]);
  });

  test('a matching-client legacy task is reused without changing its identity or human edits', async () => {
    const { service, created, decisions } = makeFake({
      legacyTask: {
        id: 'old-task',
        title: 'Teammate edited this title',
        ownerUserId: OTHER_USER,
        dueDate: new Date('2026-08-26T12:00:00.000Z'),
      },
    });
    const result = await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      intent: 'pursuit',
      actorUserId: USER,
      ownerUserId: USER,
      nextActionDueAt: '2026-08-25T12:00:00.000Z',
    });
    expect(created).toHaveLength(0);
    expect(result.task).toMatchObject({
      id: 'old-task',
      title: 'Teammate edited this title',
      ownerUserId: OTHER_USER,
      dueDate: '2026-08-26T12:00:00.000Z',
      reused: true,
    });
    expect(decisions[0]).toMatchObject({
      ownerUserId: OTHER_USER,
      nextActionDueAt: new Date('2026-08-26T12:00:00.000Z'),
      reuseTask: true,
    });
  });

  test('a legacy task belonging to another client is never reused or reassigned', async () => {
    const { service, created } = makeFake({
      legacyTask: {
        id: 'other-client-task',
        clientId: OTHER_CLIENT,
        title: 'Another client pursuit',
        ownerUserId: OTHER_USER,
        dueDate: null,
      },
    });
    const result = await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      intent: 'pursuit',
      actorUserId: USER,
    });
    expect(result.task.id).not.toBe('other-client-task');
    expect(result.task.reused).toBe(false);
    expect(created).toHaveLength(1);
    expect(created[0].clientId).toBe(CLIENT);
  });

  test('a reused task reports the preserved decision returned by the workflow writer', async () => {
    const { service, opportunities } = makeFake({
      existingTask: { id: 'task-existing', title: 'Pursuit', ownerUserId: USER, dueDate: null },
    });
    opportunities.applyActionDecision.mockResolvedValue({
      id: 'wf-1',
      decision: 'pass',
      workflowStatus: 'dismissed',
    });
    const result = await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      intent: 'pursuit',
      actorUserId: USER,
    });
    expect(result).toMatchObject({ decision: 'pass', workflowStatus: 'dismissed' });
  });
});

// ── P2002 race recovery (F-1 fix) ──────────────────────────────────────────

describe('a concurrent race returns the winner as reused, not a 500', () => {
  test('a concurrent Save winning the workflow row without a task permits one full action retry', async () => {
    const { service, tx, created, decisions } = makeFake({ workflowRace: true });
    const result = await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      intent: 'pursuit',
      actorUserId: USER,
    });
    expect(result.task.reused).toBe(false);
    expect(created).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    expect(tx.engagementTask.create).toHaveBeenCalledTimes(2); // first insert was rolled back
    expect(tx.clientFundingOpportunity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, clientId: CLIENT, source: 'sam_gov' }),
      }),
    );
  });

  test('a workflow from another client cannot authorize the missing-task retry', async () => {
    const { service, tx, created } = makeFake({
      workflowRace: true,
      workflowRaceClientId: OTHER_CLIENT,
    });
    await expect(
      service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(tx.engagementTask.create).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(0);
  });

  test('a P2002 on task create re-reads the winner and returns reused:true', async () => {
    const winner = {
      id: 'task-winner',
      title: 'Pursue: Turbofan Engine Sustainment',
      ownerUserId: null,
      dueDate: null,
    };
    const { service, created } = makeFake({ raceWinner: winner });

    const result = await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, {
      intent: 'pursuit',
      actorUserId: USER,
    });

    expect(result.task.id).toBe('task-winner');
    expect(result.task.reused).toBe(true);
    // The loser's transaction rolled back — no task row was created by it.
    expect(created).toHaveLength(0);
  });

  test('a non-P2002 error is re-thrown, not swallowed', async () => {
    const { service } = makeFake({ failTaskInsert: true });

    await expect(
      service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER }),
    ).rejects.toThrow('task insert failed');
  });

  test('the race recovery lookup cannot return a task from another client', async () => {
    const { service, tx, opportunities } = makeFake({
      raceWinner: {
        id: 'wrong-client-winner',
        clientId: OTHER_CLIENT,
        title: 'Other task',
        ownerUserId: null,
        dueDate: null,
      },
    });
    await expect(
      service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(tx.engagementTask.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, clientId: CLIENT }),
      }),
    );
    expect(opportunities.applyActionDecision).not.toHaveBeenCalled();
  });
});

// ── The UI no longer bypasses this ──────────────────────────────────────────

describe('the web page routes through the atomic action', () => {
  /**
   * P11 split the page into a shell plus two views, and the workflow actions moved
   * to the Explore view with the rest of the catalog. The assertions below are
   * about behaviour, not about which file holds it, so they read BOTH: the shell
   * must still be free of the split-brain call, and the action route must exist
   * somewhere in the surface rather than in one named file.
   */
  const WEB = '../../../web/src/pages/intelligence/opportunities';
  const shell = readFileSync(join(__dirname, `${WEB}/FundingOpportunitiesPage.tsx`), 'utf8');
  const explore = readFileSync(join(__dirname, `${WEB}/FundingOpportunityExplore.tsx`), 'utf8');
  const inbox = readFileSync(join(__dirname, `${WEB}/FundingOpportunityInbox.tsx`), 'utf8');
  const page = [shell, explore, inbox].join('\n');

  test('it no longer posts directly to /api/engagement/tasks', () => {
    // That call is the split-brain. It created a task and changed nothing else.
    // Asserted across every file in the surface so the bypass cannot come back in
    // whichever view happens to be new.
    expect(page).not.toContain("'/api/engagement/tasks'");
  });

  test('it calls the action route instead', () => {
    // The page builds the client/source/id prefix once as `base` and appends.
    expect(page).toMatch(/api\.post\(`\$\{base\}\/action`/);
  });

  test('it chooses the intent from whether the notice is actually pursuable', () => {
    // Not a hardcoded 'pursuit'. An award or special notice is real intelligence
    // worth a review task, but the server refuses to record it as a pursuit — so
    // sending 'pursuit' unconditionally would turn every such click into a 400.
    expect(page).toMatch(
      /intent:\s*o\.isPursuable\s*&&\s*o\.isActive\s*\?\s*'pursuit'\s*:\s*'review'/,
    );
  });
});
