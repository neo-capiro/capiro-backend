import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
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
const OTHER_USER = '00000000-0000-0000-0000-000000000098';
const SAM_ID = '00000000-0000-0000-0000-0000000003aa';

interface FakeOpts {
  pursuable?: boolean;
  existingTask?: { id: string; title: string; ownerUserId: string | null; dueDate: Date | null } | null;
  failDecision?: boolean;
  failTaskInsert?: boolean;
  ownerInTenant?: boolean;
  deadline?: string | null;
}

function makeFake(opts: FakeOpts = {}) {
  const created: any[] = [];
  const decisions: any[] = [];
  let rolledBack = false;

  const tx = {
    engagementTask: {
      findFirst: jest.fn(async () => opts.existingTask ?? null),
      create: jest.fn(async (args: any) => {
        if (opts.failTaskInsert) throw new Error('task insert failed');
        created.push(args.data);
        return {
          id: 'task-1',
          title: args.data.title,
          ownerUserId: args.data.ownerUserId ?? null,
          dueDate: args.data.dueDate ?? null,
        };
      }),
    },
  };

  const prisma: any = {
    withTenant: jest.fn(async (_t: string, run: (t: any) => Promise<unknown>) => {
      try {
        return await run(tx);
      } catch (error) {
        // A real transaction discards every write on throw. The double models that,
        // so a test can assert nothing survived rather than trusting Prisma.
        rolledBack = true;
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
      decisions.push(input);
      return { id: 'wf-1', workflowStatus: input.workflowStatus };
    }),
  };

  const service = new FundingOpportunityActionsService(prisma, opportunities);
  return { service, prisma, opportunities, created, decisions, tx, wasRolledBack: () => rolledBack };
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

  test('the task due date and the opportunity next-action date are the same value', async () => {
    // Two dates that could drift is how a task says one thing and the inbox says
    // another about the same deadline.
    const { service, created, decisions } = makeFake();
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER });
    expect(created[0].dueDate?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(decisions[0].nextActionDueAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  test('an opportunity with no deadline yields no due date on either side', async () => {
    const { service, created, decisions } = makeFake({ deadline: null });
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER });
    expect(created[0].dueDate).toBeNull();
    expect(decisions[0].nextActionDueAt).toBeNull();
  });

  test('the task is tagged so it can be traced back to the opportunity', async () => {
    const { service, created } = makeFake();
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER });
    expect(created[0].sourceType).toBe(FUNDING_OPPORTUNITY_TASK_SOURCE);
    expect(created[0].sourceId).toBe(`sam_gov:${SAM_ID}:pursuit`);
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
});

// ── Idempotency ─────────────────────────────────────────────────────────────

describe('a retry returns the same task, never a second one', () => {
  test('an existing task for the same intent is reused', async () => {
    // Double-clicked button, retried request, replayed mutation — all land here.
    const { service, created, decisions } = makeFake({
      existingTask: { id: 'task-existing', title: 'Pursue: Turbofan Engine Sustainment', ownerUserId: null, dueDate: null },
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

  test('the lookup is scoped to tenant, source type and the derived key', async () => {
    const { service, tx } = makeFake();
    await service.act(TENANT, CLIENT, 'sam_gov', SAM_ID, { intent: 'pursuit', actorUserId: USER });
    const [args] = (tx.engagementTask.findFirst as jest.Mock).mock.calls[0]! as [any];
    expect(args.where).toEqual({
      tenantId: TENANT,
      sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
      sourceId: `sam_gov:${SAM_ID}:pursuit`,
    });
  });

  test('review and pursuit are DIFFERENT keys', () => {
    // Escalating a reviewed opportunity to a pursuit is a real second action and
    // deserves its own task. One shared key would silently swallow it.
    const review = FundingOpportunityActionsService.taskSourceId('sam_gov', SAM_ID, 'review');
    const pursuit = FundingOpportunityActionsService.taskSourceId('sam_gov', SAM_ID, 'pursuit');
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
    expect(FundingOpportunityActionsService.taskSourceId('sam_gov', SAM_ID, intent)).toBe(
      FundingOpportunityActionsService.taskSourceId('sam_gov', SAM_ID, intent),
    );
  });

  test('different opportunities never share a key', () => {
    const a = FundingOpportunityActionsService.taskSourceId('sam_gov', SAM_ID, 'pursuit');
    const b = FundingOpportunityActionsService.taskSourceId('grants_gov', SAM_ID, 'pursuit');
    expect(a).not.toBe(b);
  });
});

// ── The UI no longer bypasses this ──────────────────────────────────────────

describe('the web page routes through the atomic action', () => {
  const page = readFileSync(
    join(__dirname, '../../../web/src/pages/intelligence/opportunities/FundingOpportunitiesPage.tsx'),
    'utf8',
  );

  test('it no longer posts directly to /api/engagement/tasks', () => {
    // That call is the split-brain. It created a task and changed nothing else.
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
    expect(page).toMatch(/intent:\s*o\.isPursuable\s*&&\s*o\.isActive\s*\?\s*'pursuit'\s*:\s*'review'/);
  });
});
