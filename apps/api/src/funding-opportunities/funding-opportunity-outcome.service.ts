import { Injectable, Logger } from '@nestjs/common';
import { hasAtLeast, isTenantAdmin, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryCandidateService } from '../memory/memory-candidate.service.js';
import { readVisibleClientIds } from './funding-opportunity-inbox.service.js';
import { isFundingOpportunitiesFeatureEnabled } from './funding-opportunities-flag.guard.js';
import { FUNDING_OPPORTUNITIES_PIPELINE_V2_FEATURE } from './funding-opportunities-flag.guard.js';

/**
 * Outcome capture and governed learning candidate (P36).
 *
 * ── Reuses `outcome_event`, does not duplicate it ────────────────────────────
 *
 * `OutcomeEvent` (G3) already exists, is tenant-scoped, RLS-forced, and its own
 * `evidence_jsonb` comment says its shape "evolves without migration". P36's
 * migration widens the `kind` and `source_type` CHECKs to admit
 * `pursuit_won`/`pursuit_lost`/`pursuit_passed` and `funding_opportunity`,
 * namespaced with a `pursuit_` prefix so a procurement outcome can never
 * collide with the table's existing advocacy-outcome vocabulary — a different
 * domain entirely.
 *
 * ── Reopening is an insert, never an update ──────────────────────────────────
 *
 * There is no update path anywhere in this file. A second outcome recorded for
 * the same (tenant, client, source, sourceRecordId) is a NEW row; the first is
 * never touched, and `getOutcomeHistory` returns every row with the latest
 * marked current. That is the entire mechanism behind "reopening a lost/passed
 * pursuit preserves prior outcome version, not an overwrite" — there is nothing
 * else to build for it.
 *
 * ── The memory candidate is an audit surface, not the outcome ───────────────
 *
 * `MemoryCandidateService.proposeSaveMemory` is called AFTER the outcome event
 * is durably written, and its failure is caught and logged, never re-thrown —
 * the same fail-open posture P38's audit collaborators use. A learning
 * candidate that could not be proposed must never cost the operational record;
 * losing the lesson is a smaller failure than losing the fact that a pursuit
 * was won or lost.
 *
 * `scope: 'client'` is the only scope this file ever proposes. Two reasons:
 * plan §P36 requires the candidate be "wall-scoped (never crosses clients)",
 * and `MemoryCandidateService`'s own docblock states that client scope ALWAYS
 * lands `pending` regardless of `isAdmin` — so "never auto-promoted to active
 * memory" is enforced by the service this file calls, not merely by convention
 * here.
 *
 * ── Rejecting the candidate does not touch the outcome ───────────────────────
 *
 * The two records have independent lifecycles from the moment they are
 * written: the candidate's own review flow (`memory-candidate-review.service`)
 * owns approve/reject, and nothing in that flow references `outcome_event` at
 * all. There is structurally no path from rejecting a candidate to deleting or
 * mutating the outcome row that proposed it.
 */

/** The three terminal-ish outcomes a pursuit can be recorded against. */
export const PURSUIT_OUTCOME_KINDS = ['won', 'lost', 'passed'] as const;
export type PursuitOutcomeKind = (typeof PURSUIT_OUTCOME_KINDS)[number];

/** `PursuitOutcomeKind` → the `outcome_event.kind` row value. */
const OUTCOME_EVENT_KIND: Readonly<Record<PursuitOutcomeKind, string>> = Object.freeze({
  won: 'pursuit_won',
  lost: 'pursuit_lost',
  passed: 'pursuit_passed',
});

/**
 * Closed reason-code vocabularies, one per outcome kind.
 *
 * Bounded rather than free text, matching every other taxonomy in this
 * program. `other` exists in each and relies on the REQUIRED `note` field for
 * its explanation — there is no separate free-text-reason field, because two
 * places to explain "other" would drift.
 */
export const WON_REASON_CODES = [
  'best_value',
  'lowest_price',
  'past_performance',
  'teaming_strength',
  'incumbent_advantage',
  'technical_superiority',
  'other',
] as const;
export const LOST_REASON_CODES = [
  'price',
  'technical_score',
  'past_performance_gap',
  'no_bid_competitive',
  'set_aside_ineligible',
  'protest_related',
  'agency_cancelled',
  'other',
] as const;
export const PASSED_REASON_CODES = [
  'capacity_constraint',
  'strategic_fit',
  'bonding_capacity',
  'teaming_fell_through',
  'deadline_missed',
  'client_declined',
  'other',
] as const;

const REASON_CODES_BY_KIND: Readonly<Record<PursuitOutcomeKind, readonly string[]>> = Object.freeze({
  won: WON_REASON_CODES,
  lost: LOST_REASON_CODES,
  passed: PASSED_REASON_CODES,
});

export function reasonCodesFor(kind: PursuitOutcomeKind): readonly string[] {
  return REASON_CODES_BY_KIND[kind];
}

const MAX_REASON_CODES = 5;
const MAX_NOTE_CHARS = 4_000;

export const OUTCOME_STATES = ['recorded', 'disabled', 'denied', 'invalid_request'] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];

export interface RecordOutcomeInput {
  clientId: string;
  source: string;
  sourceRecordId: string;
  kind: PursuitOutcomeKind;
  /** Required. When the outcome actually happened, not when it was recorded. */
  outcomeDate: Date;
  /** Required, 1..5, drawn from the closed vocabulary for `kind`. */
  reasonCodes: string[];
  /** Required. The `other` code's explanation lives here, not a second field. */
  note: string;
  /** Optional — "where relevant". Free text: vehicle names are not a closed set. */
  vehicleOutcome?: string | null;
  /** Optional — "when known". A URL or an award/contract identifier. */
  sourceAwardLink?: string | null;
}

export interface OutcomeRecordView {
  id: string;
  kind: PursuitOutcomeKind;
  outcomeDate: string;
  reasonCodes: string[];
  note: string | null;
  vehicleOutcome: string | null;
  sourceAwardLink: string | null;
  recordedByUserId: string | null;
  recordedAt: string;
  /** True on exactly the most recent row for this source key. */
  current: boolean;
}

export type RecordOutcomeResult =
  | { state: 'recorded'; outcome: OutcomeRecordView; memoryCandidateProposed: boolean }
  | { state: 'disabled' | 'denied' | 'invalid_request'; explanation: string };

export interface OutcomeHistoryResult {
  state: 'available' | 'disabled' | 'denied';
  explanation: string;
  outcomes: OutcomeRecordView[];
}

interface OutcomeActor {
  tenantId: string;
  userId: string;
  role: TenantContext['role'];
}

interface OutcomeEventRow {
  id: string;
  kind: string;
  notes: string | null;
  evidenceJsonb: unknown;
  recordedBy: string | null;
  observedAt: Date;
  createdAt: Date;
}

/** The raw `outcome_event` column shape as `$queryRaw` returns it (snake_case). */
interface OutcomeEventRawRow {
  id: string;
  kind: string;
  notes: string | null;
  evidence_jsonb: unknown;
  recorded_by: string | null;
  observed_at: Date;
  created_at: Date;
}

@Injectable()
export class FundingOpportunityOutcomeService {
  private readonly logger = new Logger(FundingOpportunityOutcomeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memoryCandidates: MemoryCandidateService,
  ) {}

  async recordOutcome(actor: OutcomeActor, input: RecordOutcomeInput): Promise<RecordOutcomeResult> {
    if (!(await this.enabled(actor.tenantId))) {
      return { state: 'disabled', explanation: DISABLED_EXPLANATION };
    }
    if (!hasAtLeast(actor.role, 'standard_user')) {
      return { state: 'denied', explanation: DENIED_EXPLANATION };
    }
    const visible = await this.prisma.withTenant(actor.tenantId, (tx) =>
      readVisibleClientIds(tx, actor.tenantId, actor.userId),
    );
    if (!visible.includes(input.clientId)) {
      return { state: 'denied', explanation: DENIED_EXPLANATION };
    }

    const invalid = validateRecordOutcomeInput(input);
    if (invalid) return { state: 'invalid_request', explanation: invalid };

    const sourceId = `${input.source}:${input.sourceRecordId}`;
    const evidence = {
      reasonCodes: input.reasonCodes,
      vehicleOutcome: input.vehicleOutcome?.trim() || null,
      sourceAwardLink: input.sourceAwardLink?.trim() || null,
    };

    // ONE INSERT. There is no update anywhere in this method — a repeat call
    // for the same source key is a new row, which is the whole mechanism
    // behind "reopening preserves the prior version".
    const row = await this.prisma.withTenantUser<OutcomeEventRawRow[]>(actor.tenantId, actor.userId, (tx) =>
      tx.$queryRaw<OutcomeEventRawRow[]>`
        INSERT INTO outcome_event (
          tenant_id, client_id, kind, source_type, source_id,
          evidence_jsonb, notes, recorded_by, observed_at
        ) VALUES (
          ${actor.tenantId}::uuid, ${input.clientId}::uuid,
          ${OUTCOME_EVENT_KIND[input.kind]}, 'funding_opportunity', ${sourceId},
          ${JSON.stringify(evidence)}::jsonb, ${input.note.trim()},
          ${actor.userId}::uuid, ${input.outcomeDate.toISOString()}::timestamptz
        )
        RETURNING id::text AS id, kind, notes, evidence_jsonb, recorded_by::text AS recorded_by,
                  observed_at, created_at
      `,
    );
    const outcome = toView(
      {
        id: row[0]!.id,
        kind: row[0]!.kind,
        notes: row[0]!.notes,
        evidenceJsonb: row[0]!.evidence_jsonb,
        recordedBy: row[0]!.recorded_by,
        observedAt: row[0]!.observed_at,
        createdAt: row[0]!.created_at,
      },
      true,
    );

    const memoryCandidateProposed = await this.proposeLearningCandidate(actor, input, outcome);

    return { state: 'recorded', outcome, memoryCandidateProposed };
  }

  async getOutcomeHistory(
    actor: OutcomeActor,
    clientId: string,
    source: string,
    sourceRecordId: string,
  ): Promise<OutcomeHistoryResult> {
    if (!(await this.enabled(actor.tenantId))) {
      return { state: 'disabled', explanation: DISABLED_EXPLANATION, outcomes: [] };
    }
    if (!hasAtLeast(actor.role, 'standard_user')) {
      return { state: 'denied', explanation: DENIED_EXPLANATION, outcomes: [] };
    }
    const visible = await this.prisma.withTenant(actor.tenantId, (tx) =>
      readVisibleClientIds(tx, actor.tenantId, actor.userId),
    );
    if (!visible.includes(clientId)) {
      return { state: 'denied', explanation: DENIED_EXPLANATION, outcomes: [] };
    }

    const sourceId = `${source}:${sourceRecordId}`;
    const rows = await this.prisma.withTenantUser<OutcomeEventRawRow[]>(actor.tenantId, actor.userId, (tx) =>
      tx.$queryRaw<OutcomeEventRawRow[]>`
        SELECT id::text AS id, kind, notes, evidence_jsonb, recorded_by::text AS recorded_by,
               observed_at, created_at
        FROM outcome_event
        WHERE tenant_id = ${actor.tenantId}::uuid
          AND client_id = ${clientId}::uuid
          AND source_type = 'funding_opportunity'
          AND source_id = ${sourceId}
        ORDER BY observed_at DESC, created_at DESC
      `,
    );

    const outcomes = rows.map((r, i) =>
      toView(
        {
          id: r.id,
          kind: r.kind,
          notes: r.notes,
          evidenceJsonb: r.evidence_jsonb,
          recordedBy: r.recorded_by,
          observedAt: r.observed_at,
          createdAt: r.created_at,
        },
        i === 0,
      ),
    );

    return {
      state: 'available',
      explanation:
        outcomes.length === 0
          ? 'No outcome has been recorded for this opportunity yet.'
          : `${outcomes.length} outcome record${outcomes.length === 1 ? '' : 's'}, most recent first.`,
      outcomes,
    };
  }

  /**
   * Fail-open by design. A memory-candidate write failing must never lose the
   * outcome record that was already committed above — see the file doc.
   */
  private async proposeLearningCandidate(
    actor: OutcomeActor,
    input: RecordOutcomeInput,
    outcome: OutcomeRecordView,
  ): Promise<boolean> {
    try {
      await this.memoryCandidates.proposeSaveMemory(
        actor.tenantId,
        actor.userId,
        {
          scope: 'client',
          ownerUserId: actor.userId,
          clientId: input.clientId,
          key: `funding-opportunity-outcome:${input.source}:${input.sourceRecordId}:${outcome.id}`,
          value: learningCandidateSummary(input, outcome),
          source: 'funding_opportunity_outcome',
        },
        isTenantAdmin(actor.role),
        'funding_opportunity_outcome',
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `memory candidate proposal failed for outcome ${outcome.id} (non-blocking): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async enabled(tenantId: string): Promise<boolean> {
    try {
      return await isFundingOpportunitiesFeatureEnabled(
        this.prisma,
        tenantId,
        FUNDING_OPPORTUNITIES_PIPELINE_V2_FEATURE,
      );
    } catch (error) {
      this.logger.error(
        `${FUNDING_OPPORTUNITIES_PIPELINE_V2_FEATURE} flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }
}

const DISABLED_EXPLANATION = 'Outcome capture is not enabled for this workspace.';
const DENIED_EXPLANATION = 'Not available for this client.';

/**
 * Validate a record-outcome request.
 *
 * Exported for the spec so every refusal reason is testable without a
 * database. Returns the refusal sentence, or null when the request is valid.
 */
export function validateRecordOutcomeInput(input: RecordOutcomeInput): string | null {
  if (!PURSUIT_OUTCOME_KINDS.includes(input.kind)) {
    return `"${input.kind}" is not a recordable outcome. Capiro records won, lost or passed.`;
  }
  if (!(input.outcomeDate instanceof Date) || Number.isNaN(input.outcomeDate.getTime())) {
    return 'An outcome date is required.';
  }
  if (input.outcomeDate.getTime() > Date.now() + 86_400_000) {
    // One day of slack for timezone rounding on a same-day entry; anything
    // further out is a fabricated future outcome, not a recorded one.
    return 'The outcome date cannot be in the future.';
  }
  const allowed = new Set(reasonCodesFor(input.kind));
  const codes = Array.isArray(input.reasonCodes) ? input.reasonCodes : [];
  if (codes.length === 0) {
    return `At least one reason code is required for a "${input.kind}" outcome.`;
  }
  if (codes.length > MAX_REASON_CODES) {
    return `No more than ${MAX_REASON_CODES} reason codes may be recorded.`;
  }
  const unknown = codes.filter((c) => !allowed.has(c));
  if (unknown.length > 0) {
    return `"${unknown[0]}" is not a reason code for a "${input.kind}" outcome. Valid codes: ${[...allowed].join(', ')}.`;
  }
  if (new Set(codes).size !== codes.length) {
    return 'The same reason code was listed twice.';
  }
  if (typeof input.note !== 'string' || !input.note.trim()) {
    return 'A note explaining the outcome is required.';
  }
  if (input.note.length > MAX_NOTE_CHARS) {
    return `The note may not exceed ${MAX_NOTE_CHARS} characters.`;
  }
  return null;
}

function toView(row: OutcomeEventRow, current: boolean): OutcomeRecordView {
  const evidence = isRecord(row.evidenceJsonb) ? row.evidenceJsonb : {};
  const kind = pursuitKindOf(row.kind);
  return {
    id: row.id,
    kind,
    outcomeDate: row.observedAt.toISOString(),
    reasonCodes: Array.isArray(evidence.reasonCodes) ? (evidence.reasonCodes as string[]) : [],
    note: row.notes,
    vehicleOutcome: typeof evidence.vehicleOutcome === 'string' ? evidence.vehicleOutcome : null,
    sourceAwardLink: typeof evidence.sourceAwardLink === 'string' ? evidence.sourceAwardLink : null,
    recordedByUserId: row.recordedBy,
    recordedAt: row.createdAt.toISOString(),
    current,
  };
}

/** The inverse of {@link OUTCOME_EVENT_KIND}. Throws on a row this file never wrote. */
function pursuitKindOf(eventKind: string): PursuitOutcomeKind {
  const found = (Object.entries(OUTCOME_EVENT_KIND) as Array<[PursuitOutcomeKind, string]>).find(
    ([, v]) => v === eventKind,
  );
  if (!found) throw new Error(`outcome_event row with unexpected kind: ${eventKind}`);
  return found[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The lesson, in one paragraph a future reader can act on without opening the
 * operational row. Deliberately does not restate the raw reason codes as a
 * comma list — the note is what a human actually wrote, and it leads.
 */
function learningCandidateSummary(input: RecordOutcomeInput, outcome: OutcomeRecordView): string {
  const parts = [
    `Opportunity ${input.source}:${input.sourceRecordId} was recorded as ${input.kind.toUpperCase()} on ${outcome.outcomeDate.slice(0, 10)}.`,
    `Reasons: ${outcome.reasonCodes.join(', ')}.`,
    outcome.vehicleOutcome ? `Vehicle/partner outcome: ${outcome.vehicleOutcome}.` : null,
    `Note: ${input.note.trim()}`,
  ].filter((p): p is string => p != null);
  return parts.join(' ');
}
