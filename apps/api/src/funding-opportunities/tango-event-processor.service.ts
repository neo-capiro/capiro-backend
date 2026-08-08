import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  type ChangeSeverity,
  type MaterialChange,
  type NoticeObservation,
  buildNoticeTimeline,
} from './opportunity-change-classifier.js';
import { effectiveStage } from './funding-opportunity-pipeline.js';

/**
 * Turn verified provider events into client-relevant, MATERIAL alerts —
 * Funding Opportunities P48.
 *
 * ── The chain, and why each link is separate ─────────────────────────────────
 *
 *   P46  bytes arrived, and they were really from MakeGov
 *   P48  …so refresh the resource, work out WHAT changed (P28's classifier),
 *        work out WHO it matters to, and tell them once
 *
 * Nothing here re-derives materiality from prose. P28 already banded every
 * change dimension into critical/significant/informational, and its own doc
 * says that band exists "so P48 has a deterministic input rather than having to
 * re-derive materiality from prose". This phase applies POLICY to that band. It
 * does not invent a second severity scale.
 *
 * ── Quiet by construction, in four independent ways ──────────────────────────
 *
 *   1. A first observation is BASELINED SILENTLY. There is nothing before it to
 *      compare against, so the "change" is an artifact of starting to look.
 *   2. An unchanged source produces nothing. No changes, no alerts — not an
 *      "opportunity refreshed" notification, which is the noise this phase
 *      exists to avoid.
 *   3. Informational severity never alerts. It is visible on the timeline (P28)
 *      where somebody can go and look; it does not interrupt anyone.
 *   4. Only rows a human actually engaged with alert at all — see
 *      {@link isAlertableStage}.
 *
 * ── No model can create an alert ─────────────────────────────────────────────
 *
 * Every field of an alert comes from the classifier's own before/after values.
 * An LLM summary may be attached downstream for readability, but the row
 * already exists by then. The plan is explicit: "model summaries are optional
 * downstream; they cannot create the alert."
 */

// ── Policy vocabulary ────────────────────────────────────────────────────────

/**
 * Stages whose rows may receive an alert.
 *
 * These are the rows a human has actually engaged with. The plan's wording is
 * "saved/pursuing/qualified/submitted"; `reviewing` IS the pipeline-v2 spelling
 * of legacy `saved` (that migration's own mapping table says so), which is why
 * it appears here and `saved` does not.
 */
export const ALERTABLE_STAGES = ['reviewing', 'qualified', 'pursuing', 'submitted'] as const;

/**
 * Stages whose rows never receive an active-pursuit alert.
 *
 * A won, lost, or passed row is DECIDED. Telling a team that the deadline moved
 * on something they already lost is precisely the noise that trains people to
 * ignore alerts — and P48's acceptance names this case directly.
 *
 * WIDER than the pipeline module's own `TERMINAL_STAGES`, deliberately, and the
 * difference is not an oversight. That set is `{won, lost}` because those are
 * the stages the pipeline forbids transitioning OUT of. `passed` is not
 * terminal for the pipeline — a team may reconsider and re-stage it — but for
 * ALERTING it is decided: somebody looked and said no, and telling them the
 * deadline moved is exactly the interruption they declined.
 */
export const TERMINAL_STAGES = ['won', 'lost', 'passed'] as const;

/** Severity bands that are allowed to interrupt someone. */
export const ALERTABLE_SEVERITIES: readonly ChangeSeverity[] = ['critical', 'significant'];

/** Why an alert was or was not raised. Every suppression is explainable. */
export type AlertDecisionReason =
  | 'alerted'
  | 'baselined_first_observation'
  | 'no_change'
  | 'below_materiality'
  | 'human_declined'
  | 'terminal_stage'
  | 'stage_not_engaged';

export interface AlertDecision {
  alert: boolean;
  reason: AlertDecisionReason;
}

/**
 * The stage to judge a row by.
 *
 * DELEGATES to `funding-opportunity-pipeline.ts`'s own `effectiveStage`, which
 * is already "the one place the two columns are reconciled" (its words). This
 * phase must not become a second place: a row's stage means one thing, and two
 * reconciliations that drift would mean the board and the alerts disagreeing
 * about which rows are live.
 *
 * That function returns a null stage for a row nobody staged, which this phase
 * treats as NOT engaged — an alert needs positive evidence that a human took an
 * interest, not merely the absence of evidence that they did not.
 */
export function stageForAlerting(
  pipelineStage: string | null | undefined,
  workflowStatus: string | null | undefined,
): string | null {
  return effectiveStage({
    workflowStatus: workflowStatus ?? '',
    pipelineStage: pipelineStage ?? null,
  }).stage;
}

/** Is this a stage whose rows may be alerted? */
export function isAlertableStage(stage: string | null): boolean {
  return stage !== null && (ALERTABLE_STAGES as readonly string[]).includes(stage);
}

/**
 * Fingerprint of a CHANGE, not of a delivery.
 *
 * This is what makes replay and out-of-order delivery collapse to one alert:
 * the same deadline slip re-sent under a new delivery id hashes identically, so
 * the unique index on (tenant, client, source record, fingerprint) rejects the
 * second insert.
 *
 * Deliberately EXCLUDES the delivery id, the notice id, and any timestamp. It
 * includes the source record so the same-looking change on two different
 * opportunities stays two alerts.
 */
export function changeFingerprint(sourceRecordKey: string, change: MaterialChange): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        sourceRecordKey,
        change.dimension,
        // STATE, NOT TRANSITION — `after` only, deliberately.
        //
        // The first version hashed `before` too, which made the fingerprint
        // UNSTABLE. `buildNoticeTimeline` computes `before` from the
        // immediately preceding notice, so a notice back-filled BETWEEN two
        // syncs rewrites `before` for the very same current state — and the
        // same deadline then hashed differently and alerted twice. The unique
        // index cannot collapse what does not collide.
        //
        // The trade-off, stated rather than hidden: a value that changes away
        // and back (B → C → B) does not re-alert on the return, because "this
        // deadline is now B" has already been sent. That is the correct side to
        // err on for a phase whose entire promise is quietness, and the full
        // history remains visible on the P28 timeline either way.
        //
        // The ESCAPE SEQUENCE, not a raw NUL byte: written as a literal 0x00
        // this file became binary to git and could not be read in review.
        change.after ?? '\0null',
      ]),
    )
    .digest('hex');
}

export interface AlertPolicyInput {
  change: MaterialChange;
  isFirstObservation: boolean;
  pipelineStage: string | null | undefined;
  workflowStatus: string | null | undefined;
  humanDecision: string | null | undefined;
}

/**
 * The whole alerting policy, in one pure function.
 *
 * Order matters and is deliberate: the cheapest and most universal
 * suppressions come first, so a first observation on a passed row reports
 * `baselined_first_observation` rather than `terminal_stage`. The reason is
 * surfaced for operator diagnostics, so it should name the most fundamental
 * cause, not the last one checked.
 */
export function decideAlert(input: AlertPolicyInput): AlertDecision {
  if (input.isFirstObservation) {
    return { alert: false, reason: 'baselined_first_observation' };
  }
  if (!ALERTABLE_SEVERITIES.includes(input.change.severity)) {
    return { alert: false, reason: 'below_materiality' };
  }
  // A human who said "pass" has decided. Their decision outranks the stage,
  // which a producer may still be moving underneath them.
  if (input.humanDecision === 'pass') {
    return { alert: false, reason: 'human_declined' };
  }

  const stage = stageForAlerting(input.pipelineStage, input.workflowStatus);
  if (stage !== null && (TERMINAL_STAGES as readonly string[]).includes(stage)) {
    return { alert: false, reason: 'terminal_stage' };
  }
  if (!isAlertableStage(stage)) {
    return { alert: false, reason: 'stage_not_engaged' };
  }
  return { alert: true, reason: 'alerted' };
}

// ── Ports ────────────────────────────────────────────────────────────────────

/** One tenant row that might care about a change. */
export interface AffectedClientRow {
  tenantId: string;
  clientId: string;
  sourceType: string;
  sourceRecordKey: string;
  pipelineStage: string | null;
  workflowStatus: string | null;
  humanDecision: string | null;
}

export interface AlertToWrite {
  tenantId: string;
  clientId: string;
  sourceType: string;
  sourceRecordKey: string;
  changeDimension: string;
  severity: ChangeSeverity;
  changeFingerprint: string;
  evidenceJsonb: unknown;
  beforeValue: string | null;
  afterValue: string | null;
  pipelineStageAtAlert: string | null;
  sourceObservedAt: Date | null;
  deliveryId: string | null;
}

export interface OutboxRow {
  id: string;
  deliveryId: string;
  eventType: string;
  resourceType: string;
  externalId: string | null;
  attempts: number;
}

/**
 * Everything this processor needs from the outside world.
 *
 * Injected as one port so the spec drives the entire drain against in-memory
 * doubles — no database, no provider, no clock — while the production wiring
 * supplies the Prisma-backed implementation.
 */
export interface EventProcessorPort {
  claimBatch(limit: number, leaseSeconds: number): Promise<OutboxRow[]>;
  /** Re-fetch the resource through the provider adapter, then read back what we hold. */
  refreshAndReadNotices(resourceType: string, externalId: string): Promise<NoticeObservation[]>;
  /** Tenant rows referencing this source record, across every tenant. */
  findAffectedClients(sourceRecordKey: string): Promise<AffectedClientRow[]>;
  /** Insert, or silently no-op on the dedupe unique index. Returns true if written. */
  insertAlertIfNew(alert: AlertToWrite): Promise<boolean>;
  markDone(outboxId: string): Promise<void>;
  markFailed(outboxId: string, attempts: number, error: string): Promise<void>;
  markQuarantined(outboxId: string, error: string): Promise<void>;
}

export interface ProcessSummary {
  claimed: number;
  processed: number;
  quarantined: number;
  alertsWritten: number;
  alertsDeduped: number;
  suppressions: Record<string, number>;
}

/** Attempts before a row is quarantined. Terminal, and deliberately small. */
export const MAX_ATTEMPTS = 5;

@Injectable()
export class TangoEventProcessorService {
  private readonly logger = new Logger(TangoEventProcessorService.name);

  constructor(private readonly port: EventProcessorPort) {}

  /**
   * Drain one batch.
   *
   * A failure on one event NEVER stops the batch. That is what "a poison event
   * is quarantined and does not block queue" means in practice: the failure is
   * recorded against its own row, and the loop continues to the next event.
   */
  async processBatch(limit = 50, leaseSeconds = 300): Promise<ProcessSummary> {
    const summary: ProcessSummary = {
      claimed: 0,
      processed: 0,
      quarantined: 0,
      alertsWritten: 0,
      alertsDeduped: 0,
      suppressions: {},
    };

    const rows = await this.port.claimBatch(limit, leaseSeconds);
    summary.claimed = rows.length;

    for (const row of rows) {
      try {
        await this.processOne(row, summary);
        await this.port.markDone(row.id);
        summary.processed += 1;
      } catch (err) {
        const message = describeError(err);
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await this.port.markQuarantined(row.id, message);
          summary.quarantined += 1;
          this.logger.error(
            `Quarantined Tango event ${row.deliveryId} after ${attempts} attempts: ${message}`,
          );
        } else {
          await this.port.markFailed(row.id, attempts, message);
          this.logger.warn(
            `Tango event ${row.deliveryId} failed (attempt ${attempts}): ${message}`,
          );
        }
      }
    }

    return summary;
  }

  private async processOne(row: OutboxRow, summary: ProcessSummary): Promise<void> {
    // An event naming no addressable resource is a legitimate no-op, not a
    // failure to retry forever.
    if (!row.externalId) return;

    const notices = await this.port.refreshAndReadNotices(row.resourceType, row.externalId);
    const timeline = buildNoticeTimeline(notices);

    // No entries, or no changes anywhere, means nothing to say. An unchanged
    // source creates no alert.
    const entries = timeline.entries;
    if (entries.length === 0) return;

    const affected = await this.port.findAffectedClients(row.externalId);

    // EVERY entry, not just the last one.
    //
    // The first version read `entries[entries.length - 1]` only. Because the
    // notice sync and this drain are separately scheduled, any cycle that lands
    // TWO notices dropped the earlier one's changes permanently — the event was
    // marked done and nothing ever revisited it. A deadline that moved and then
    // moved again between drains simply never alerted for the first move.
    //
    // Safe to widen precisely because the fingerprint is stable and the dedupe
    // is a unique index: re-processing the same history writes nothing new. The
    // cost is that the FIRST drain over an existing history alerts once per
    // distinct value per dimension — which is why P50 requires two quiet manual
    // passes before any cadence is enabled, and why the runbook says so.
    for (const entry of entries) {
      for (const change of entry.changes) {
        for (const client of affected) {
          const decision = decideAlert({
            change,
            isFirstObservation: entry.isFirstObservation,
            pipelineStage: client.pipelineStage,
            workflowStatus: client.workflowStatus,
            humanDecision: client.humanDecision,
          });

          if (!decision.alert) {
            summary.suppressions[decision.reason] =
              (summary.suppressions[decision.reason] ?? 0) + 1;
            continue;
          }

          const written = await this.port.insertAlertIfNew({
            tenantId: client.tenantId,
            clientId: client.clientId,
            sourceType: client.sourceType,
            sourceRecordKey: client.sourceRecordKey,
            changeDimension: change.dimension,
            severity: change.severity,
            changeFingerprint: changeFingerprint(client.sourceRecordKey, change),
            evidenceJsonb: {
              dimension: change.dimension,
              severity: change.severity,
              before: change.before,
              after: change.after,
              summary: change.summary,
              noticeId: entry.tangoNoticeId,
              sourceUrl: entry.sourceUrl,
            },
            beforeValue: change.before,
            afterValue: change.after,
            pipelineStageAtAlert: stageForAlerting(client.pipelineStage, client.workflowStatus),
            sourceObservedAt: entry.providerUpdatedAt ? new Date(entry.providerUpdatedAt) : null,
            deliveryId: row.deliveryId,
          });

          if (written) summary.alertsWritten += 1;
          else summary.alertsDeduped += 1;
        }
      }
    }
  }
}

/** Error text for logs and the outbox row. Never a payload, never a secret. */
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return 'unknown error';
}
