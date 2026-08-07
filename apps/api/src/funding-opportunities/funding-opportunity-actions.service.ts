import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { FundingOpportunitiesService } from './funding-opportunities.service.js';
import type { OpportunitySource } from './funding-opportunities.types.js';

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
 *     sourceId   = '<source>:<sourceRecordId>:<intent>'
 *
 * A double-clicked button, a retried request and a replayed mutation all land on
 * the same key and get the SAME task back. `review` and `pursuit` are separate
 * keys on purpose: escalating a reviewed opportunity to a pursuit is a real second
 * action and deserves its own task.
 */

export const FUNDING_OPPORTUNITY_TASK_SOURCE = 'funding_opportunity';

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
  decision: 'pursue' | 'monitor';
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
    source: OpportunitySource,
    sourceRecordId: string,
    intent: OpportunityActionIntent,
  ): string {
    return `${source}:${sourceRecordId}:${intent}`;
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
    source: OpportunitySource,
    sourceRecordId: string,
    input: {
      intent: OpportunityActionIntent;
      actorUserId: string;
      ownerUserId?: string | null;
      notes?: string | null;
      nextAction?: string | null;
    },
  ): Promise<OpportunityActionResult> {
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
      source,
      sourceRecordId,
      input.intent,
    );
    const title = (
      input.intent === 'pursuit' ? `Pursue: ${target.title}` : `Review: ${target.title}`
    ).slice(0, 240);
    const description = [
      `${source === 'grants_gov' ? 'Grants.gov' : 'SAM.gov'} opportunity ${target.sourceReference ?? sourceRecordId}`,
      target.sourceUrl ?? null,
      input.notes?.trim() || null,
    ]
      .filter(Boolean)
      .join('\n');

    // The task's due date and the opportunity's next-action date are the SAME
    // value, taken from the source deadline. Two dates that could drift is how a
    // task says one thing and the inbox says another.
    const dueDate = target.responseDeadline ? new Date(target.responseDeadline) : null;

    return this.prisma.withTenant(tenantId, async (tx) => {
      const existingTask = await tx.engagementTask.findFirst({
        where: { tenantId, sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE, sourceId },
        select: { id: true, title: true, ownerUserId: true, dueDate: true },
      });

      const task =
        existingTask ??
        (await tx.engagementTask.create({
          data: {
            tenantId,
            clientId,
            title,
            description: description || null,
            ownerUserId: input.ownerUserId ?? null,
            dueDate,
            sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
            sourceId,
            createdByUserId: input.actorUserId,
          },
          select: { id: true, title: true, ownerUserId: true, dueDate: true },
        }));

      // Same transaction. If this throws, the task insert above rolls back with
      // it — which is the entire point of the phase.
      const saved = await this.opportunities.applyActionDecision(tx, {
        tenantId,
        clientId,
        source,
        sourceRecordId,
        actorUserId: input.actorUserId,
        decision,
        workflowStatus,
        ownerUserId: input.ownerUserId,
        notes: input.notes,
        nextAction: input.nextAction ?? (input.intent === 'pursuit' ? title : null),
        nextActionDueAt: dueDate,
        taskId: task.id,
      });

      return {
        task: {
          id: task.id,
          title: task.title,
          ownerUserId: task.ownerUserId ?? null,
          dueDate: task.dueDate ? task.dueDate.toISOString() : null,
          reused: existingTask != null,
        },
        decision,
        workflowStatus: saved.workflowStatus,
      };
    });
  }
}

/** Thrown-shape guard so a missing target reads as 404 rather than a 500. */
export function assertTargetFound<T>(value: T | null, message = 'Opportunity not found'): T {
  if (value == null) throw new NotFoundException(message);
  return value;
}
