import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { FundingOpportunitiesService } from './funding-opportunities.service.js';
import type { HumanDecision } from './funding-opportunities.types.js';
import { readVisibleClientIds, type InboxSource } from './funding-opportunity-inbox.service.js';
import {
  FUNDING_OPPORTUNITY_TASK_SOURCE,
  findFundingOpportunityTask,
  fundingOpportunityTaskSourceId,
} from './funding-opportunity-task-link.js';
import { sourceRecordWhere } from './funding-opportunity-identity.js';

/**
 * One action that creates an Engagement task AND records the decision, in ONE
 * database transaction.
 *
 * WHAT WAS WRONG BEFORE P08
 * -------------------------
 * The web page posted straight to `/api/engagement/tasks` with a title of
 * `Pursue: <opportunity>`, and did nothing else. So a task saying "Pursue this"
 * existed while the opportunity itself was still an untouched machine suggestion:
 * no owner, no decision, workflow status `suggested`. The two facts lived in
 * different tables written by different requests, and either could succeed alone.
 *
 * Worse in the failure direction: the task creation could succeed and the page
 * could then fail to refresh, leaving a task nobody could trace back to a
 * pursuit, and a pursuit nobody had recorded.
 *
 * WHY THE TASK ROW IS CREATED HERE RATHER THAN BY EngagementService
 * ----------------------------------------------------------------
 * `EngagementService.createTask` opens its own `withTenant` transaction. Calling
 * it from here would mean two transactions and no atomicity — precisely the
 * defect. `engagementTask.create` is a plain insert with no side effects beyond
 * the row, so issuing it inside this transaction is equivalent, and the tenant
 * scoping is identical because both go through `withTenant`.
 *
 * IDEMPOTENCY WITHOUT A MIGRATION
 * -------------------------------
 * `EngagementTask` already carries `sourceType` / `sourceId`, which is how the
 * lifecycle processor dedupes its alerts. The key is derived, not supplied by the
 * caller, so two clients cannot disagree about what "the same action" means:
 *
 *     sourceType = 'funding_opportunity'
 *     sourceId   = 'v2:<clientId>:<source>:<encodedRecordId>:<intent>'
 *
 * A double-clicked button, a retried request and a replayed mutation all land on
 * the same key and get the SAME task back. `review` and `pursuit` are separate
 * keys on purpose: escalating a reviewed opportunity to a pursuit is a real second
 * action and deserves its own task. Older keys are reused only when the task's
 * actual client matches; existing rows and human edits are never reassigned.
 */

export { FUNDING_OPPORTUNITY_TASK_SOURCE };

export const OPPORTUNITY_ACTION_INTENTS = ['review', 'pursuit'] as const;
export type OpportunityActionIntent = (typeof OPPORTUNITY_ACTION_INTENTS)[number];

export interface OpportunityActionResult {
  task: {
    id: string;
    title: string;
    ownerUserId: string | null;
    dueDate: string | null;
    /** True when an existing task was returned rather than a new one created. */
    reused: boolean;
  };
  /** The decision recorded alongside the task. */
  decision: HumanDecision;
  workflowStatus: string;
}

@Injectable()
export class FundingOpportunityActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly opportunities: FundingOpportunitiesService,
  ) {}

  /** Deterministic, derived from the target and the intent. Never caller-supplied. */
  static taskSourceId(
    clientId: string,
    source: InboxSource,
    sourceRecordId: string,
    intent: OpportunityActionIntent,
  ): string {
    return fundingOpportunityTaskSourceId(clientId, source, sourceRecordId, intent);
  }

  /**
   * Create (or return) the task, and record the matching decision, atomically.
   *
   * `review`  -> decision `monitor`, workflow `saved`. Somebody is looking at it.
   * `pursuit` -> decision `pursue`,  workflow `pursuing`. Subject to the SAME
   *              source guard as every other pursuit, so a closed or informational
   *              notice is refused here exactly as it is on the save path — and
   *              refused BEFORE any task is written, so a rejected pursuit leaves
   *              no orphan task behind.
   */
  async act(
    tenantId: string,
    clientId: string,
    source: InboxSource,
    sourceRecordId: string,
    input: {
      intent: OpportunityActionIntent;
      actorUserId: string;
      ownerUserId?: string | null;
      notes?: string | null;
      nextAction?: string | null;
      /** Team follow-up date. Never inferred from a source deadline or estimate. */
      nextActionDueAt?: string | null;
    },
  ): Promise<OpportunityActionResult> {
    // Actions can be called outside the catalog UI. Tenant membership alone
    // does not grant access to a client behind an ethical wall.
    const assertVisibleClient = async (tx: Prisma.TransactionClient) => {
      const visibleClientIds = await readVisibleClientIds(tx, tenantId, input.actorUserId);
      if (!visibleClientIds.includes(clientId)) throw new NotFoundException('Client not found.');
    };
    await this.prisma.withTenant(tenantId, assertVisibleClient);
    const target = await this.opportunities.describeForAction(
      tenantId,
      clientId,
      source,
      sourceRecordId,
    );

    // Validate BEFORE writing anything. A pursuit the source forbids must not
    // leave a task behind, and an owner from another tenant must not be assigned.
    if (input.intent === 'pursuit' && !target.isPursuable) {
      throw new BadRequestException(
        target.pursuitRefusal ??
          'This opportunity cannot be pursued. Create a review task instead.',
      );
    }
    if (input.ownerUserId != null) {
      await this.opportunities.assertOwnerAssignable(tenantId, input.ownerUserId);
    }

    const decision = input.intent === 'pursuit' ? 'pursue' : 'monitor';
    const workflowStatus = input.intent === 'pursuit' ? 'pursuing' : 'saved';
    const sourceId = FundingOpportunityActionsService.taskSourceId(
      clientId,
      source,
      sourceRecordId,
      input.intent,
    );
    const title = (
      input.intent === 'pursuit' ? `Pursue: ${target.title}` : `Review: ${target.title}`
    ).slice(0, 240);
    const description = [
      `${SOURCE_LABELS[source]} opportunity ${target.sourceReference ?? sourceRecordId}`,
      target.sourceUrl ?? null,
      input.notes?.trim() || null,
    ]
      .filter(Boolean)
      .join('\n');

    // A response deadline belongs to the source. A follow-up date belongs to
    // the team, and can precede it or be absent entirely (including forecasts).
    const followUp =
      input.nextActionDueAt !== undefined ? input.nextActionDueAt : target.nextActionDueAt;
    const dueDate = followUp == null ? null : new Date(followUp);
    if (dueDate && !Number.isFinite(dueDate.getTime())) {
      throw new BadRequestException('Follow-up date must be a valid ISO date.');
    }
    const nextAction = input.nextAction?.trim() || title;
    const taskSelect = { id: true, title: true, ownerUserId: true, dueDate: true } as const;
    const findTask = async (tx: Prisma.TransactionClient) =>
      findFundingOpportunityTask(tx, {
        tenantId,
        clientId,
        source,
        sourceRecordId,
        intent: input.intent,
      });

    const recordDecision = async (
      tx: Prisma.TransactionClient,
      task: { id: string; title: string; ownerUserId: string | null; dueDate: Date | null },
      reused: boolean,
    ): Promise<OpportunityActionResult> => {
      // A retry reuses the task's actual owner and date. Replaying an older
      // request must not overwrite a teammate's task edits or make the workflow
      // disagree with that task. The decision writer preserves existing human
      // decisions, notes and next-action text when reuseTask is true.
      const saved = await this.opportunities.applyActionDecision(tx, {
        tenantId,
        clientId,
        source,
        sourceRecordId,
        actorUserId: input.actorUserId,
        decision,
        workflowStatus,
        ownerUserId: task.ownerUserId,
        notes: input.notes,
        nextAction,
        nextActionDueAt: task.dueDate,
        taskId: task.id,
        reuseTask: reused,
      });
      return {
        task: {
          id: task.id,
          title: task.title,
          ownerUserId: task.ownerUserId ?? null,
          dueDate: task.dueDate ? task.dueDate.toISOString() : null,
          reused,
        },
        decision: saved.decision,
        workflowStatus: saved.workflowStatus,
      };
    };

    const write = async (): Promise<OpportunityActionResult> =>
      this.prisma.withTenant(tenantId, async (tx) => {
        await assertVisibleClient(tx);
        const existingTask = await findTask(tx);

        const task =
          existingTask ??
          (await tx.engagementTask.create({
            data: {
              tenantId,
              clientId,
              title,
              description: description || null,
              ownerUserId:
                input.ownerUserId !== undefined ? input.ownerUserId : (target.ownerUserId ?? null),
              dueDate,
              sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
              sourceId,
              createdByUserId: input.actorUserId,
            },
            select: taskSelect,
          }));

        // Same transaction. If this throws, the task insert above rolls back with
        // it — which is the entire point of the phase.
        return recordDecision(tx, task, existingTask != null);
      });

    try {
      return await write();
    } catch (error) {
      // engagement_tasks_tenant_source_uniq is the concurrency backstop — the
      // SAME pattern client_funding_opportunity's writers already use (see
      // decide() in funding-opportunities.service.ts): two simultaneous
      // identical actions can both observe no existing task, and the loser
      // must return the WINNER's row as `reused: true` rather than leaking a
      // P2002. PrismaClientExceptionFilter does not special-case P2002 (only
      // P2023/P2000/P2025/P2024/P2028 are mapped), so an uncaught one would
      // reach the caller as a raw 500 — precisely the regression this catch
      // exists to prevent now that the unique index can produce one.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const recovered = await this.prisma.withTenant(tenantId, async (tx) => {
        await assertVisibleClient(tx);
        const winner = await findTask(tx);
        if (winner) return recordDecision(tx, winner, true);
        // A concurrent Save/Watch can win the workflow insert without creating
        // a task. Our task insert then rolls back with the losing workflow write.
        // Verify that exact client/source row exists before one full retry; the
        // retry rechecks the locked decision and cannot reopen a passed record.
        const workflowWinner = await tx.clientFundingOpportunity.findFirst({
          where: { tenantId, clientId, ...sourceRecordWhere(source, sourceRecordId) },
          select: { id: true },
        });
        if (!workflowWinner) throw error;
        return null;
      });
      return recovered ?? write();
    }
  }
}

const SOURCE_LABELS: Record<InboxSource, string> = {
  grants_gov: 'Grants.gov',
  sam_gov: 'SAM.gov',
  agency_forecast: 'Agency procurement forecast',
  dibbs: 'DIBBS',
  sbir_sttr: 'SBIR/STTR',
};

/** Thrown-shape guard so a missing target reads as 404 rather than a 500. */
export function assertTargetFound<T>(value: T | null, message = 'Opportunity not found'): T {
  if (value == null) throw new NotFoundException(message);
  return value;
}
