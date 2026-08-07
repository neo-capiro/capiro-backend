import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { FORECAST_INBOX_SOURCE } from './funding-opportunity-inbox.service.js';
import type { OpportunityWorkflowStatus } from './funding-opportunities.types.js';

/**
 * The pursuit pipeline (Funding Opportunities P35).
 *
 * ── Why a second field rather than a wider workflow_status ───────────────────
 *
 * `workflow_status` already carries seven values, and two of them are not
 * capture stages at all: `suggested` is the producer's own output and `expired`
 * is a mechanical consequence of the source closing. A capture pipeline needs
 * `qualified` and `submitted`, which that column has no room for, and it must NOT
 * have `suggested`/`expired`, which it cannot drop without breaking every reader.
 *
 * So the stage is an ADDITIVE nullable column beside the old one, and the old one
 * keeps working untouched. That is also what makes the rolling deploy safe — see
 * below.
 *
 * ── The rolling-deploy rule, stated once ─────────────────────────────────────
 *
 * During a rolling deploy, OLD pods keep writing `workflow_status` and know
 * nothing about `pipeline_stage`. So a row can end up with a recorded stage that
 * its legacy status has since moved past — a pod that recorded a win while the
 * stage still said `pursuing`.
 *
 * The rule that resolves it: **`workflow_status` wins for anything it can
 * express; `pipeline_stage` only adds resolution the legacy column cannot.**
 * {@link effectiveStage} implements exactly that, and reports which of the two it
 * used, so a reader is never shown a stage that contradicts the status the whole
 * fleet agrees on.
 *
 * `qualified` and `submitted` are the only two stages with no legacy equivalent;
 * both project onto `pursuing`. Everything else round-trips.
 *
 * ── An unstaged row is unstaged, and that is not "reviewing" ─────────────────
 *
 * A producer-created `suggested` row has NO stage, and the backfill deliberately
 * left it that way. Mapping it to `reviewing` would put a machine suggestion
 * nobody has opened onto a board column labelled with a human activity — which is
 * the same false claim `HUMAN_DECISION_STATUSES` exists to prevent, drawn on a
 * Kanban instead of in a column.
 *
 * `expired` is likewise unstaged: Capiro does not know which stage a row was in
 * when the source closed underneath it, and picking one would fabricate a capture
 * history. The board reports both counts explicitly rather than hiding them.
 *
 * ── Producers cannot move a stage ────────────────────────────────────────────
 *
 * Nothing but {@link FundingOpportunityPipelineService.transition} writes
 * `pipeline_stage`, and that method requires an actor. The nightly candidate
 * generators and the lifecycle processor do not mention the column — asserted
 * structurally in the spec, because "we would notice" is not a constraint.
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * The stage vocabulary, in board order.
 *
 * Bounded and CHECK-constrained in the migration. Declaration order IS the
 * left-to-right column order, and it is the order work actually moves in, so a
 * board never has to be re-sorted to be read.
 */
export const PIPELINE_STAGES = [
  'reviewing',
  'qualified',
  'pursuing',
  'submitted',
  'won',
  'lost',
  'passed',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Stages nothing moves out of. A won bid is not re-opened; it is a new pursuit. */
export const TERMINAL_STAGES: ReadonlySet<PipelineStage> = new Set<PipelineStage>(['won', 'lost']);

/**
 * Stages that may only ever be reached by an explicit human action, and that
 * require a stated reason.
 *
 * A recorded loss with no explanation is a loss nobody can learn from, and a
 * submission nobody attributed is a submission nobody can be asked about. The
 * migration CHECKs the reason on the transition row as well, so the rule survives
 * a caller that bypasses this service.
 */
export const HUMAN_ONLY_STAGES: ReadonlySet<PipelineStage> = new Set<PipelineStage>([
  'submitted',
  'won',
  'lost',
  'passed',
]);

/**
 * Stages a forecast may never enter.
 *
 * Byte-for-byte the judgement P26's `FORECAST_FORBIDDEN_ACTIONS` already makes:
 * a forecast is a pre-solicitation signal, so there is nothing to pursue and
 * nothing to submit. `reviewing`, `qualified` and `passed` remain open, because
 * deciding a forecast is worth watching — or worth ignoring — is a real decision.
 */
export const FORECAST_FORBIDDEN_STAGES: ReadonlySet<PipelineStage> = new Set<PipelineStage>([
  'pursuing',
  'submitted',
  'won',
  'lost',
]);

/**
 * The allowed moves. `null` is the key for a row not yet in the pipeline.
 *
 * `won` and `lost` are reachable ONLY from `submitted`, deliberately: a bid
 * cannot be won or lost if it was never submitted, and letting a user jump
 * straight to `won` from `reviewing` produces a pipeline whose conversion numbers
 * describe nothing that happened.
 *
 * `passed` re-opens to `reviewing`, because agencies repost and a team that
 * passed in March may want it in September. Nothing else re-opens.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly PipelineStage[]>> = Object.freeze(
  {
    // Entering the pipeline. Only at the front — a row nobody has staged cannot
    // be declared submitted, however far along the work actually is, because the
    // stages in between are the record that it happened.
    unstaged: ['reviewing'],
    reviewing: ['qualified', 'passed'],
    qualified: ['pursuing', 'passed'],
    pursuing: ['submitted', 'passed'],
    submitted: ['won', 'lost'],
    won: [],
    lost: [],
    passed: ['reviewing'],
  },
);

/** The key {@link ALLOWED_TRANSITIONS} uses for a row with no stage yet. */
export const UNSTAGED = 'unstaged';

// ── Legacy compatibility ─────────────────────────────────────────────────────

/**
 * `workflow_status` → the stage it implies, or null when it implies none.
 *
 * `suggested` and `expired` map to NOTHING on purpose — see the module note.
 */
export const LEGACY_STATUS_TO_STAGE: Readonly<
  Record<OpportunityWorkflowStatus, PipelineStage | null>
> = Object.freeze({
  suggested: null,
  expired: null,
  saved: 'reviewing',
  pursuing: 'pursuing',
  dismissed: 'passed',
  won: 'won',
  lost: 'lost',
});

/**
 * The inverse projection: which legacy status a stage corresponds to.
 *
 * `qualified` and `submitted` both project onto `pursuing`, which is the whole
 * reason the extra column exists. This map is what {@link effectiveStage} uses to
 * decide whether a recorded stage and a legacy status AGREE — a comparison in the
 * other direction would call `qualified` stale every single time.
 */
export const STAGE_TO_LEGACY_STATUS: Readonly<Record<PipelineStage, OpportunityWorkflowStatus>> =
  Object.freeze({
    reviewing: 'saved',
    qualified: 'pursuing',
    pursuing: 'pursuing',
    submitted: 'pursuing',
    won: 'won',
    lost: 'lost',
    passed: 'dismissed',
  });

/**
 * Where a row actually is, and which column said so.
 *
 *   `recorded`         a human moved the stage, and the legacy status agrees.
 *   `workflow_status`  no stage recorded; the legacy status is all there is.
 *   `legacy_override`  a stage IS recorded and the legacy status has moved past
 *                      it. Almost always an old pod mid-rolling-deploy. The
 *                      legacy status wins, and the caller is told.
 *   `unstaged`         neither column places this row in the pipeline.
 */
export const STAGE_BASES = ['recorded', 'workflow_status', 'legacy_override', 'unstaged'] as const;
export type StageBasis = (typeof STAGE_BASES)[number];

export interface EffectiveStage {
  stage: PipelineStage | null;
  basis: StageBasis;
  /** One sentence. Never a claim beyond what the two columns support. */
  explanation: string;
}

/**
 * PURE. The one place the two columns are reconciled.
 *
 * There is deliberately no writing here and no clock: a read that repaired a
 * stale stage as a side effect would mean two pods disagreeing about a row
 * silently rewriting each other's work for as long as the deploy lasted.
 */
export function effectiveStage(row: {
  workflowStatus: string;
  pipelineStage: string | null;
}): EffectiveStage {
  const legacy = LEGACY_STATUS_TO_STAGE[row.workflowStatus as OpportunityWorkflowStatus] ?? null;
  const recorded = isPipelineStage(row.pipelineStage) ? row.pipelineStage : null;

  if (recorded == null) {
    return legacy == null
      ? {
          stage: null,
          basis: 'unstaged',
          explanation:
            row.workflowStatus === 'expired'
              ? 'The source closed before anybody staged this. Which stage it was in is not recorded, and it is not guessed.'
              : 'Not in the pipeline. A machine suggestion is not a stage somebody is working.',
        }
      : {
          stage: legacy,
          basis: 'workflow_status',
          explanation: `Derived from the workflow status “${row.workflowStatus}”. No finer stage has been recorded.`,
        };
  }

  if (STAGE_TO_LEGACY_STATUS[recorded] === row.workflowStatus) {
    return { stage: recorded, basis: 'recorded', explanation: 'Moved here by a person.' };
  }

  // The legacy column moved and the stage did not. An older pod is the usual
  // cause; either way the status every version of the code writes is the one that
  // should be believed.
  return legacy == null
    ? {
        stage: null,
        basis: 'legacy_override',
        explanation: `The workflow status is now “${row.workflowStatus}”, which is not a pipeline stage. The recorded stage “${recorded}” is out of date.`,
      }
    : {
        stage: legacy,
        basis: 'legacy_override',
        explanation: `The workflow status moved to “${row.workflowStatus}” without the stage following. Showing ${legacy}; the recorded stage “${recorded}” is out of date.`,
      };
}

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === 'string' && (PIPELINE_STAGES as readonly string[]).includes(value);
}

/** Why a move is refused, or null when it is allowed. */
export function refuseTransition(input: {
  from: PipelineStage | null;
  to: PipelineStage;
  source: string;
  reason: string | null;
}): string | null {
  if (!isPipelineStage(input.to)) return `“${String(input.to)}” is not a pipeline stage.`;
  if (input.from === input.to) {
    return `This opportunity is already at ${input.to}. Moving it there again is not a change.`;
  }
  if (input.from != null && TERMINAL_STAGES.has(input.from)) {
    return `${input.from} is final. Record a new pursuit rather than re-opening this one.`;
  }

  const allowed = ALLOWED_TRANSITIONS[input.from ?? UNSTAGED] ?? [];
  if (!allowed.includes(input.to)) {
    return allowed.length === 0
      ? `Nothing moves out of ${input.from}.`
      : `${input.from ?? 'An unstaged opportunity'} moves to ${allowed.join(' or ')}, not to ${input.to}.`;
  }

  if (input.source === FORECAST_INBOX_SOURCE && FORECAST_FORBIDDEN_STAGES.has(input.to)) {
    return `A forecast is a pre-solicitation signal, so it cannot be moved to ${input.to}. There is nothing to respond to yet.`;
  }

  if (HUMAN_ONLY_STAGES.has(input.to) && (input.reason == null || input.reason.trim() === '')) {
    return `Moving to ${input.to} needs a stated reason. A recorded ${input.to} nobody explained is one nobody can learn from.`;
  }

  return null;
}

// ── The board ────────────────────────────────────────────────────────────────

export interface BoardCounts {
  /** One entry per stage, always all seven, zeros included. */
  stages: Array<{ stage: PipelineStage; count: number }>;
  /**
   * Rows in NO stage, split by why. Reported rather than folded into a stage:
   * `suggested` rows are the producer's backlog and `expired` ones are history,
   * and a board that quietly added either to `reviewing` would claim work nobody
   * is doing.
   */
  unstaged: { suggested: number; expired: number; other: number };
  /** Every workflow row for this client. The stage counts plus the unstaged ones. */
  total: number;
  /**
   * How many rows are showing a stage derived from the legacy column rather than
   * a recorded one. Non-zero is normal mid-deploy and after the backfill; it is
   * surfaced so a board that looks coarse can be explained rather than doubted.
   */
  derivedFromWorkflowStatus: number;
}

/**
 * PURE. Fold a `(pipeline_stage, workflow_status)` aggregate into board counts.
 *
 * Takes the GROUPED result rather than rows, because the counts must describe
 * every workflow row a client has and a board that counted a fetched page would
 * silently under-report the moment a client passed one page of saved
 * opportunities. Postgres does the grouping; at most 7 stages × 7 statuses come
 * back, so this fold is bounded regardless of corpus size.
 */
export function foldBoardCounts(
  groups: ReadonlyArray<{ pipelineStage: string | null; workflowStatus: string; count: number }>,
): BoardCounts {
  const stageCounts = new Map<PipelineStage, number>(PIPELINE_STAGES.map((s) => [s, 0]));
  const unstaged = { suggested: 0, expired: 0, other: 0 };
  let total = 0;
  let derived = 0;

  for (const group of groups) {
    total += group.count;
    const resolved = effectiveStage(group);
    if (resolved.stage == null) {
      if (group.workflowStatus === 'suggested') unstaged.suggested += group.count;
      else if (group.workflowStatus === 'expired') unstaged.expired += group.count;
      else unstaged.other += group.count;
      continue;
    }
    stageCounts.set(resolved.stage, (stageCounts.get(resolved.stage) ?? 0) + group.count);
    if (resolved.basis !== 'recorded') derived += group.count;
  }

  return {
    stages: PIPELINE_STAGES.map((stage) => ({ stage, count: stageCounts.get(stage) ?? 0 })),
    unstaged,
    total,
    derivedFromWorkflowStatus: derived,
  };
}

// ── The service ──────────────────────────────────────────────────────────────

export interface PipelineRow {
  id: string;
  clientId: string;
  source: string;
  sourceRecordId: string | null;
  workflowStatus: string;
  pipelineStage: string | null;
  pipelineStageVersion: number;
  pipelineStageAt: Date | null;
  pipelineStageByUserId: string | null;
  title: string | null;
  responseDeadline: Date | null;
}

export interface PipelinePort {
  visibleClientIds(tenantId: string, actorUserId: string): Promise<string[]>;
  readRow(tenantId: string, clientId: string, rowId: string): Promise<PipelineRow | null>;
  /** The GROUPED aggregate. Never a page of rows. */
  countByStage(
    tenantId: string,
    clientId: string,
  ): Promise<Array<{ pipelineStage: string | null; workflowStatus: string; count: number }>>;
  /**
   * Conditional update. Returns false when no row matched the expected version,
   * which is how a concurrent transition is DETECTED rather than overwritten.
   */
  commitTransition(
    tenantId: string,
    input: {
      rowId: string;
      expectedVersion: number;
      toStage: PipelineStage;
      toWorkflowStatus: OpportunityWorkflowStatus;
      fromStage: PipelineStage | null;
      actorUserId: string;
      reason: string | null;
      occurredAt: Date;
    },
  ): Promise<boolean>;
  listForBoard(tenantId: string, clientId: string, limit: number): Promise<PipelineRow[]>;
}

export interface TransitionResult {
  rowId: string;
  from: PipelineStage | null;
  to: PipelineStage;
  /** The legacy column moves WITH the stage, so old readers stay correct. */
  workflowStatus: OpportunityWorkflowStatus;
  version: number;
  occurredAt: string;
}

@Injectable()
export class FundingOpportunityPipelineService {
  private port: PipelinePort;

  constructor(private readonly prisma: PrismaService) {
    this.port = this.buildPort();
  }

  /** Replace the reader wholesale. Test seam only. */
  withPort(port: PipelinePort): this {
    (this as unknown as { port: PipelinePort }).port = port;
    return this;
  }

  /**
   * Move one opportunity to a stage.
   *
   * VALIDATE, THEN WRITE, and write BOTH columns in one statement. A transition
   * that moved the stage without the legacy status would be invisible to every
   * older reader — including the lifecycle processor, which decides what to alert
   * on from `workflow_status`.
   *
   * `expectedVersion` is required, not optional. A caller that could omit it
   * would be a caller whose last-write-wins drag silently discarded somebody
   * else's decision, which is precisely the conflict this phase must detect.
   */
  async transition(
    tenantId: string,
    actorUserId: string,
    clientId: string,
    rowId: string,
    input: { toStage: string; expectedVersion: number; reason?: string | null },
    asOf: Date = new Date(),
  ): Promise<TransitionResult> {
    const visible = await this.port.visibleClientIds(tenantId, actorUserId);
    // 404 rather than 403, for the same reason every other guard in this feature
    // does: a 403 confirms the client exists.
    if (!visible.includes(clientId)) throw new NotFoundException('Opportunity not found');

    const row = await this.port.readRow(tenantId, clientId, rowId);
    if (row == null) throw new NotFoundException('Opportunity not found');

    if (!isPipelineStage(input.toStage)) {
      throw new BadRequestException(`“${String(input.toStage)}” is not a pipeline stage.`);
    }

    // The move is validated against the EFFECTIVE stage, not the recorded one. A
    // row whose legacy status has moved past its stage must be moved from where
    // it actually is, or the graph would be enforced against a stale position.
    const current = effectiveStage(row);
    const reason = input.reason?.trim() ? input.reason.trim() : null;
    const refusal = refuseTransition({
      from: current.stage,
      to: input.toStage,
      source: row.source,
      reason,
    });
    if (refusal) throw new BadRequestException(refusal);

    const committed = await this.port.commitTransition(tenantId, {
      rowId,
      expectedVersion: input.expectedVersion,
      toStage: input.toStage,
      toWorkflowStatus: STAGE_TO_LEGACY_STATUS[input.toStage],
      fromStage: current.stage,
      actorUserId,
      reason,
      occurredAt: asOf,
    });

    if (!committed) {
      throw new ConflictException(
        'Somebody else moved this opportunity while you were looking at it. Reload to see where it is now, then move it again if you still want to.',
      );
    }

    return {
      rowId,
      from: current.stage,
      to: input.toStage,
      workflowStatus: STAGE_TO_LEGACY_STATUS[input.toStage],
      version: input.expectedVersion + 1,
      occurredAt: asOf.toISOString(),
    };
  }

  /** Board counts over EVERY workflow row for the client, plus a bounded card list. */
  async board(
    tenantId: string,
    actorUserId: string,
    clientId: string,
    limit = 200,
  ): Promise<{
    clientId: string;
    counts: BoardCounts;
    cards: Array<{
      rowId: string;
      source: string;
      sourceRecordId: string | null;
      title: string | null;
      stage: PipelineStage | null;
      stageBasis: StageBasis;
      stageExplanation: string;
      version: number;
      allowedTransitions: PipelineStage[];
      responseDeadline: string | null;
    }>;
    /** True when `cards` is a truncated view. The COUNTS are never truncated. */
    cardsTruncated: boolean;
  }> {
    const visible = await this.port.visibleClientIds(tenantId, actorUserId);
    if (!visible.includes(clientId)) {
      // An empty board rather than a 403, and identical in shape to a client with
      // no opportunities.
      return {
        clientId,
        counts: foldBoardCounts([]),
        cards: [],
        cardsTruncated: false,
      };
    }

    const [groups, rows] = await Promise.all([
      this.port.countByStage(tenantId, clientId),
      this.port.listForBoard(tenantId, clientId, limit + 1),
    ]);

    const visibleRows = rows.slice(0, limit);
    return {
      clientId,
      counts: foldBoardCounts(groups),
      cards: visibleRows.map((row) => {
        const resolved = effectiveStage(row);
        return {
          rowId: row.id,
          source: row.source,
          sourceRecordId: row.sourceRecordId,
          title: row.title,
          stage: resolved.stage,
          stageBasis: resolved.basis,
          stageExplanation: resolved.explanation,
          version: row.pipelineStageVersion,
          // Computed server-side so a client cannot offer a move the server would
          // refuse — the same reason a drag has to be validated rather than
          // trusted.
          allowedTransitions: (ALLOWED_TRANSITIONS[resolved.stage ?? UNSTAGED] ?? []).filter(
            (stage) =>
              !(row.source === FORECAST_INBOX_SOURCE && FORECAST_FORBIDDEN_STAGES.has(stage)),
          ),
          responseDeadline: row.responseDeadline?.toISOString() ?? null,
        };
      }),
      cardsTruncated: rows.length > limit,
    };
  }

  private buildPort(): PipelinePort {
    return {
      visibleClientIds: async (tenantId, actorUserId) => {
        const { readVisibleClientIds } = await import('./funding-opportunity-inbox.service.js');
        return this.prisma.withTenant(tenantId, (tx) =>
          readVisibleClientIds(tx, tenantId, actorUserId),
        );
      },

      readRow: (tenantId, clientId, rowId) =>
        this.prisma.withTenant(tenantId, async (tx) => {
          const row = await tx.clientFundingOpportunity.findFirst({
            where: { id: rowId, tenantId, clientId },
            select: {
              id: true,
              clientId: true,
              source: true,
              samOpportunityId: true,
              grantOpportunityId: true,
              sourceRecordKey: true,
              workflowStatus: true,
              pipelineStage: true,
              pipelineStageVersion: true,
              pipelineStageAt: true,
              pipelineStageByUserId: true,
              responseDeadlineSnapshot: true,
            },
          });
          if (row == null) return null;
          return {
            id: row.id,
            clientId: row.clientId,
            source: row.source,
            sourceRecordId:
              row.samOpportunityId ?? row.grantOpportunityId ?? row.sourceRecordKey ?? null,
            workflowStatus: row.workflowStatus,
            pipelineStage: row.pipelineStage,
            pipelineStageVersion: row.pipelineStageVersion,
            pipelineStageAt: row.pipelineStageAt,
            pipelineStageByUserId: row.pipelineStageByUserId,
            // The board card shows the source title, which lives on the catalog
            // row. Left null here rather than joined: the board is a stage view,
            // and the inbox already owns titling.
            title: null,
            responseDeadline: row.responseDeadlineSnapshot,
          };
        }),

      countByStage: async (tenantId, clientId) => {
        // ONE grouped aggregate over every workflow row. Not a page.
        const groups = await this.prisma.withTenant(tenantId, (tx) =>
          tx.clientFundingOpportunity.groupBy({
            by: ['pipelineStage', 'workflowStatus'],
            where: { tenantId, clientId },
            _count: { _all: true },
          }),
        );
        return groups.map((g) => ({
          pipelineStage: g.pipelineStage,
          workflowStatus: g.workflowStatus,
          count: g._count._all,
        }));
      },

      commitTransition: async (tenantId, input) => {
        return this.prisma.withTenant(tenantId, async (tx) => {
          // OPTIMISTIC CONCURRENCY. The version predicate is in the WHERE, so two
          // simultaneous moves cannot both succeed: the loser updates 0 rows.
          const updated = await tx.clientFundingOpportunity.updateMany({
            where: {
              id: input.rowId,
              tenantId,
              pipelineStageVersion: input.expectedVersion,
            },
            data: {
              pipelineStage: input.toStage,
              // The legacy column moves WITH the stage. See `transition`.
              workflowStatus: input.toWorkflowStatus,
              pipelineStageVersion: input.expectedVersion + 1,
              pipelineStageAt: input.occurredAt,
              pipelineStageByUserId: input.actorUserId,
              updatedBy: input.actorUserId,
              // A human moving a stage is a human action by definition, so the
              // producer may never overwrite the row afterwards.
              userCreated: true,
              staleAt: null,
            },
          });
          if (updated.count === 0) return false;

          // Same transaction as the update: an audited move that lost its audit
          // row, or an audit row for a move that did not happen, are both worse
          // than a failed request.
          await tx.fundingOpportunityStageTransition.create({
            data: {
              tenantId,
              clientFundingOpportunityId: input.rowId,
              fromStage: input.fromStage,
              toStage: input.toStage,
              actorUserId: input.actorUserId,
              reason: input.reason,
              occurredAt: input.occurredAt,
            },
          });
          return true;
        });
      },

      listForBoard: async (tenantId, clientId, limit) => {
        const rows = await this.prisma.withTenant(tenantId, (tx) =>
          tx.clientFundingOpportunity.findMany({
            where: { tenantId, clientId },
            orderBy: [{ responseDeadlineSnapshot: 'asc' }, { id: 'asc' }],
            take: limit,
            select: {
              id: true,
              clientId: true,
              source: true,
              samOpportunityId: true,
              grantOpportunityId: true,
              sourceRecordKey: true,
              workflowStatus: true,
              pipelineStage: true,
              pipelineStageVersion: true,
              pipelineStageAt: true,
              pipelineStageByUserId: true,
              responseDeadlineSnapshot: true,
            },
          }),
        );
        return rows.map((row) => ({
          id: row.id,
          clientId: row.clientId,
          source: row.source,
          sourceRecordId:
            row.samOpportunityId ?? row.grantOpportunityId ?? row.sourceRecordKey ?? null,
          workflowStatus: row.workflowStatus,
          pipelineStage: row.pipelineStage,
          pipelineStageVersion: row.pipelineStageVersion,
          pipelineStageAt: row.pipelineStageAt,
          pipelineStageByUserId: row.pipelineStageByUserId,
          title: null,
          responseDeadline: row.responseDeadlineSnapshot,
        }));
      },
    };
  }
}
