/**
 * Phase 10B-2 — Cycle/Family Readiness.
 *
 * The missing predicate between "observations exist" and "reconciliation may
 * run": for one governed scope (fiscal year x authority track x budget
 * family/source family grouping), decide whether the corpus is complete
 * enough to hand to the EXISTING Phase 4/5/6 reconciliation/certification
 * pipeline.
 *
 * This module does not reconcile, certify, plan, or promote anything. It only
 * answers: "is every required expected source in this scope either published
 * and durably ingested, or in a governed terminal state that does not require
 * a document?" Everything downstream (reconciliation, certification, planning)
 * is reused unchanged from Phase 4/5/6/7 — see `cycle-family-readiness-orchestrator-v1.ts`.
 *
 * ---------------------------------------------------------------------------
 * Why readiness is scoped by (fiscalYear, authorityTrack, sourceFamilyGroup)
 * ---------------------------------------------------------------------------
 *
 * `DefenseBudgetCycle` itself is already keyed by (fiscalYear, authorityTrack)
 * — see `defense_budget_cycle_fy_track_key` in schema.prisma — so authorization
 * and appropriations are already separate cycle rows and cannot satisfy each
 * other's corpus by construction upstream of this module. This module adds the
 * finer axis Phase 4/5/6/7 actually certify against: a *family group* within a
 * track/cycle (RDT&E vs procurement vs O&M vs MILCON vs committee), because
 * "the FY2027 authorization cycle is ready" is not one fact — RDT&E's R-1/R-2
 * exhibits can be complete while MILCON's C-1/DD-1391 exhibits are not, and
 * certifying the whole cycle as one unit would either block RDT&E on MILCON's
 * gap or certify MILCON on RDT&E's evidence. Neither existing certifier
 * (`certifyRdteCycle`, `certifyNonRdteCycle`, Phase 6's committee certifier)
 * operates on "the cycle"; each operates on one family's exhibit set. Readiness
 * follows that shape rather than inventing a coarser one.
 *
 * `alternative_funding` is its own `authorityTrack` value (see
 * `AuthorityTrack` in `@capiro/defense-domain`) and therefore already a
 * separate `DefenseBudgetCycle` row from `appropriations`/`authorization` — it
 * cannot satisfy or be satisfied by the annual corpus because it is never in
 * the same scope to begin with. This module additionally refuses to define a
 * readiness rule for `alternative_funding` or `execution` tracks at all (see
 * `UNSUPPORTED_READINESS_TRACKS` below): no Phase 4/5/6 certifier exists for
 * either track today, so a family group in one of those tracks reports
 * `certification_not_supported` rather than being fabricated a fake "ready"
 * path. Never use a global "current FY" — every readiness evaluation names its
 * own fiscal year explicitly.
 */
import type {
  AuthorityTrack,
  ExpectedSourceState,
} from '@capiro/defense-domain';

/* ------------------------------------------------------------------ */
/* R1. Scope identity                                                   */
/* ------------------------------------------------------------------ */

/**
 * Family groups used as the governed routing/readiness axis. Annual groups
 * (rdte/procurement/om/milcon/committee) have existing certifiers; the two
 * post-enactment groups below are first-class scopes but remain explicitly
 * unsupported by annual certification. Deliberately NOT
 * `BudgetFamilyV1` (which also has `milpers`, `public_law`, `overview`,
 * `unknown` — categories with no certifier) and NOT `SourceFamily` (which is
 * document-granular, e.g. `pb_r1` vs `pb_r2` are the same certifiable group).
 * `committee` covers Phase 6's authorization/appropriations committee-action
 * families (marks, reports, chamber actions, conference, public law) — Phase 6
 * certifies the whole committee-action set for a track as one unit, not per
 * exhibit.
 */
export const READINESS_FAMILY_GROUP_V1_VALUES = [
  'rdte',
  'procurement',
  'om',
  'milcon',
  'committee',
  'alternative_funding',
  'execution',
] as const;
export const readinessFamilyGroupV1Schema_VALUES = READINESS_FAMILY_GROUP_V1_VALUES;
export type ReadinessFamilyGroupV1 = (typeof READINESS_FAMILY_GROUP_V1_VALUES)[number];

/**
 * Tracks with no existing Phase 4/5/6 certifier. A family group scoped to one
 * of these tracks always reports `certification_not_supported` (see
 * `evaluateCycleFamilyReadinessV1`) — this module does not invent a
 * certification rule for them. Kept as an explicit, testable list rather than
 * an implicit fallthrough so a future certifier's arrival is a one-line change
 * here, not a silent behavior shift.
 */
export const UNSUPPORTED_READINESS_TRACKS: readonly AuthorityTrack[] = Object.freeze([
  'alternative_funding',
  'execution',
]);

/**
 * Readiness identity. `fiscalYear` + `authorityTrack` matches
 * `DefenseBudgetCycle`'s own unique key exactly (never a global "current FY");
 * `familyGroup` is the finer axis this module adds. Two identities with
 * different `familyGroup` are always independent scopes — the "request and
 * appropriations cannot satisfy each other's corpus" requirement is structural
 * (they are different `authorityTrack` values, hence different cycles), and
 * the finer "MILCON cannot satisfy RDT&E" requirement is structural here too
 * (different `familyGroup`, hence a different readiness identity and a
 * different reconciliation/certification call).
 */
export interface CycleFamilyReadinessIdentityV1 {
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly familyGroup: ReadinessFamilyGroupV1;
}

export function cycleFamilyReadinessKeyV1(identity: CycleFamilyReadinessIdentityV1): string {
  return `${identity.fiscalYear}\u0000${identity.authorityTrack}\u0000${identity.familyGroup}`;
}

/* ------------------------------------------------------------------ */
/* R2. Readiness states                                                 */
/* ------------------------------------------------------------------ */

/**
 * The readiness state machine. Every state here is either a governed
 * `ExpectedSourceState`-derived fact or an existing Phase 6 certification
 * status (`INCOMPLETE` / `NEEDS_REVIEW` / `REJECTED` / `CERTIFIED*`) folded
 * into the equivalent readiness vocabulary — this module does not invent new
 * terminal semantics, it composes the existing ones into one ladder.
 */
export const CYCLE_FAMILY_READINESS_STATE_V1_VALUES = [
  /** The corpus may be complete, but no Phase 4/5/6 certifier exists for this authority track — never reconcile, plan, or fabricate certification. */
  'certification_not_supported',
  /** Not every required expected source has reached a resolved state yet. */
  'waiting_for_sources',
  /** A required expected source (or its ingested observation) needs human review. */
  'review_required',
  /** Corpus is structurally complete; reconciliation has not been invoked yet. */
  'ready_for_reconciliation',
  /** Phase 4/5/6 reconciliation ran and found blocking findings. */
  'reconciliation_failed',
  /** Phase 4/5/6 certification ran and returned REJECTED or INCOMPLETE. */
  'certification_failed',
  /** Certification passed; a promotion plan has not been built/persisted yet. */
  'ready_for_plan',
  /** A plan was built and persisted; canonical promotion requires a human. */
  'awaiting_authorization',
] as const;
export type CycleFamilyReadinessStateV1 =
  (typeof CYCLE_FAMILY_READINESS_STATE_V1_VALUES)[number];

/* ------------------------------------------------------------------ */
/* R3. Corpus input                                                     */
/* ------------------------------------------------------------------ */

/**
 * One expected source's readiness-relevant facts, exactly as governed
 * lifecycle semantics already define them.
 *
 * `latestIngestion` is reconstructed by
 * `reconstructReadinessIngestionOutcomeV1` (below) purely from durable
 * observation/SourceDocument/parse-job/candidate/verification-run rows — a
 * fresh process with no bridge result in memory produces the identical
 * outcome, which is the point of the restart-safety proof in
 * `durable-ingestion-reconstruction-v1.spec.ts`. The ONLY place this module
 * still reads Phase 10B-1's transient `ObservationIngestionBridgeResult`
 * directly is `readinessIngestionOutcomeFromBridgeResultV1` further below —
 * a narrow convenience mapper for a caller that happens to already hold a
 * fresh bridge result in the SAME process that just ran ingestion (e.g. a
 * post-success hook firing readiness immediately after a bridge run
 * resolves), never a persisted or replayable outcome. The durable Prisma
 * loader (`PrismaReadinessCorpusLoaderV1`) never calls that mapper.
 */
export interface ReadinessExpectedSourceInputV1 {
  readonly expectedSourceId: string;
  readonly sourceFamily: string;
  readonly optional: boolean;
  /** The exact governed state — never inferred, never defaulted to zero/fake. */
  readonly expectedState: ExpectedSourceState;
  /**
   * Present only when at least one observation for this expected source has
   * a durably reconstructable governed ingestion outcome (SourceDocument
   * SHA-bound + durable parser proof + durable verification decision — see
   * `reconstructReadinessIngestionOutcomeV1`). `null` when no such
   * observation exists yet, which is a DIFFERENT fact from
   * `expectedState: 'not_filed'` — a source can be `published` (observed,
   * classified) while its durable ingestion proof is still incomplete or has
   * not been attempted.
   */
  readonly latestIngestion: ReadinessIngestionOutcomeV1 | null;
}

/**
 * The exact three outcomes a Phase 10B-1 bridge run can report for the
 * observation bound to one expected source, widened with the network/
 * transient-failure case the bridge itself distinguishes from a terminal
 * verifier decision (`ParserHandoffResult.decision` can be `PASS` | `REVIEW`
 * | `REJECT`; anything that threw before reaching a decision is neither
 * ingested nor a governed disposition and must not be reported as either).
 */
export const READINESS_INGESTION_OUTCOME_V1_VALUES = [
  'ingested_pass',
  'ingested_review',
  'ingested_reject',
  'ingestion_incomplete',
] as const;
export type ReadinessIngestionOutcomeV1 =
  (typeof READINESS_INGESTION_OUTCOME_V1_VALUES)[number];

export interface DurableReadinessIngestionFactsV1 {
  readonly observation: {
    readonly observationState: string;
    readonly sourceDocumentId: string | null;
    readonly contentSha256: string;
  } | null;
  readonly sourceDocument: { readonly id: string; readonly sha256: string | null } | null;
  readonly parseJobs: ReadonlyArray<{ readonly inputSha256: string; readonly status: string }>;
  readonly candidates: ReadonlyArray<{
    readonly id: string;
    readonly sourceDocumentId: string;
    readonly sourceSha256: string;
    readonly currentRunId: string | null;
  }>;
  readonly verificationRuns: ReadonlyArray<{
    readonly id: string;
    readonly candidateId: string;
    readonly decision: string;
    readonly completedAt: Date | string;
  }>;
}

/** Reconstruct restart-safe ingestion solely from persisted parser/candidate/run facts. */
export function reconstructReadinessIngestionOutcomeV1(
  input: DurableReadinessIngestionFactsV1,
): ReadinessIngestionOutcomeV1 {
  const observation = input.observation;
  if (observation?.sourceDocumentId == null) return 'ingestion_incomplete';
  const document = input.sourceDocument;
  if (
    document == null ||
    document.id !== observation.sourceDocumentId ||
    document.sha256 == null ||
    document.sha256 !== observation.contentSha256
  ) return 'ingestion_incomplete';
  if (!input.parseJobs.some((job) => job.status === 'succeeded' && job.inputSha256 === document.sha256)) {
    return 'ingestion_incomplete';
  }
  const candidate = input.candidates.find(
    (row) => row.sourceDocumentId === document.id && row.sourceSha256 === document.sha256,
  );
  if (candidate == null) return 'ingestion_incomplete';
  const candidateRuns = input.verificationRuns.filter((run) => run.candidateId === candidate.id);
  // Fail-closed on a named current run: when the candidate names an exact
  // currentRunId, that EXACT run must exist and be resolvable — never fall
  // back to the latest-by-time run among the others. A candidate whose named
  // current run is missing/unresolved (e.g. deleted, not yet replicated, or
  // referencing a run that belongs to a different candidate) must report
  // ingestion_incomplete, not silently promote an older, possibly-superseded
  // PASS. Latest-by-completedAt is only a legitimate fallback when
  // currentRunId is itself null (no run has been designated current yet).
  if (candidate.currentRunId != null) {
    const current = candidateRuns.find((run) => run.id === candidate.currentRunId);
    if (current == null) return 'ingestion_incomplete';
    if (current.decision === 'PASS') return 'ingested_pass';
    if (current.decision === 'REVIEW') return 'ingested_review';
    if (current.decision === 'REJECT') return 'ingested_reject';
    return 'ingestion_incomplete';
  }
  const run = [...candidateRuns].sort(
    (a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime(),
  )[0];
  if (run?.decision === 'PASS') return 'ingested_pass';
  if (run?.decision === 'REVIEW') return 'ingested_review';
  if (run?.decision === 'REJECT') return 'ingested_reject';
  return 'ingestion_incomplete';
}

/**
 * Map a Phase 10B-1 bridge result directly to a readiness ingestion outcome.
 * The ONLY inputs are `ingestionSucceeded` and `verificationDisposition` —
 * exactly the fields `observation-ingestion-bridge.service.ts` already
 * reports, so this function cannot be satisfied by anything except a real
 * completed bridge run. A bridge run that never resolved (threw, or resolved
 * with `ingestionSucceeded: false` for a reason other than a governed
 * disposition — e.g. a transient parser/network failure) maps to
 * `ingestion_incomplete`, which readiness treats identically to "no
 * observation yet": it must never be interpreted as `not_filed`.
 */
export function readinessIngestionOutcomeFromBridgeResultV1(input: {
  readonly ingestionSucceeded: boolean;
  readonly verificationDisposition: 'passed' | 'review' | 'rejected' | null;
}): ReadinessIngestionOutcomeV1 {
  if (input.verificationDisposition === 'review') return 'ingested_review';
  if (input.verificationDisposition === 'rejected') return 'ingested_reject';
  if (input.ingestionSucceeded && input.verificationDisposition === 'passed') {
    return 'ingested_pass';
  }
  return 'ingestion_incomplete';
}

export interface CycleFamilyCorpusInputV1 {
  readonly identity: CycleFamilyReadinessIdentityV1;
  readonly cycleId: string;
  readonly expectedSources: readonly ReadinessExpectedSourceInputV1[];
}

/* ------------------------------------------------------------------ */
/* R4. Corpus completeness decision                                     */
/* ------------------------------------------------------------------ */

export const READINESS_BLOCK_REASON_V1_VALUES = [
  'unsupported_track',
  'no_expected_sources',
  'required_source_not_yet_resolved',
  'required_source_ingestion_incomplete',
  'required_source_review_required',
  'required_source_rejected',
  'required_source_bundle_incomplete',
] as const;
export type ReadinessBlockReasonV1 = (typeof READINESS_BLOCK_REASON_V1_VALUES)[number];

export interface CycleFamilyReadinessDecisionV1 {
  readonly identity: CycleFamilyReadinessIdentityV1;
  readonly cycleId: string;
  readonly state: CycleFamilyReadinessStateV1;
  readonly blocks: ReadonlyArray<{ reason: ReadinessBlockReasonV1; detail: string }>;
  /**
   * Expected sources that ARE required for corpus completeness and count
   * toward the decision. `not_filed`/`withdrawn`/`unavailable` on an
   * `optional` source are excluded here (governed terminal, no document
   * required) but reported for visibility, never silently dropped.
   */
  readonly requiredCount: number;
  readonly resolvedCount: number;
  readonly excludedOptionalTerminalCount: number;
}

/**
 * Decide corpus completeness for one readiness identity from the expected
 * sources already governed by `resolveCycleTemplate()` /
 * `DefenseBudgetExpectedSource` rows — never from "all observations currently
 * present". An expected source with no observation is either legitimately
 * `not_filed`/`withdrawn`/`unavailable` (governed terminal, correctly
 * excluded) or still outstanding (`expected`, blocking) — this function reads
 * that state as already resolved by the existing lifecycle watcher/classifier
 * (`resolveUnobservedExpectedState` et al. in `@capiro/defense-domain`), it
 * does not re-derive it and does not treat a fetch failure as `not_filed`
 * (the watcher itself never produces that mapping for a transient error —
 * see `detectSourceRevision`/`ObservationByteFetchFailure` upstream — so this
 * function's only obligation is to not invent a different one).
 */
export function evaluateCycleFamilyReadinessV1(
  input: CycleFamilyCorpusInputV1,
): CycleFamilyReadinessDecisionV1 {
  const blocks: Array<{ reason: ReadinessBlockReasonV1; detail: string }> = [];

  if (UNSUPPORTED_READINESS_TRACKS.includes(input.identity.authorityTrack)) {
    return {
      identity: input.identity,
      cycleId: input.cycleId,
      state: 'certification_not_supported',
      blocks: [
        {
          reason: 'unsupported_track',
          detail: `authorityTrack "${input.identity.authorityTrack}" has no Phase 4/5/6 certifier; certification is structurally unsupported for this track`,
        },
      ],
      requiredCount: 0,
      resolvedCount: 0,
      excludedOptionalTerminalCount: 0,
    };
  }

  if (input.expectedSources.length === 0) {
    return {
      identity: input.identity,
      cycleId: input.cycleId,
      state: 'waiting_for_sources',
      blocks: [
        {
          reason: 'no_expected_sources',
          detail: 'no expected sources are registered for this cycle/family scope yet',
        },
      ],
      requiredCount: 0,
      resolvedCount: 0,
      excludedOptionalTerminalCount: 0,
    };
  }

  let requiredCount = 0;
  let resolvedCount = 0;
  let excludedOptionalTerminalCount = 0;
  let hasReview = false;
  let hasReject = false;

  for (const source of input.expectedSources) {
    // A source legitimately marked not_filed/withdrawn/unavailable that is
    // ALSO optional needs no document at all — governed lifecycle semantics
    // already decided this, and readiness must not re-litigate it as missing.
    const isGovernedTerminalWithoutDocument =
      source.expectedState === 'not_filed' ||
      source.expectedState === 'withdrawn' ||
      source.expectedState === 'unavailable';
    if (isGovernedTerminalWithoutDocument && source.optional) {
      excludedOptionalTerminalCount += 1;
      continue;
    }

    requiredCount += 1;

    // A required source in a governed terminal state without a document
    // (review_required from the watcher, or a REQUIRED source that is
    // not_filed/withdrawn/unavailable past its window) blocks readiness but
    // is a DIFFERENT, correctly-labeled block from "still expected".
    if (source.expectedState === 'review_required') {
      hasReview = true;
      blocks.push({
        reason: 'required_source_review_required',
        detail: `expected source ${source.expectedSourceId} (${source.sourceFamily}) is review_required`,
      });
      continue;
    }
    if (
      source.expectedState === 'not_filed' ||
      source.expectedState === 'withdrawn' ||
      source.expectedState === 'unavailable'
    ) {
      // Required and terminal-without-document: this is a gap the corpus
      // cannot resolve on its own. Never zero, never silently skipped — it
      // blocks with its own reason rather than pretending the source will
      // still arrive.
      blocks.push({
        reason: 'required_source_review_required',
        detail: `required expected source ${source.expectedSourceId} (${source.sourceFamily}) is "${source.expectedState}", which needs a human decision (waive, extend window, or escalate) before this scope can proceed`,
      });
      hasReview = true;
      continue;
    }
    if (source.expectedState === 'expected') {
      blocks.push({
        reason: 'required_source_not_yet_resolved',
        detail: `required expected source ${source.expectedSourceId} (${source.sourceFamily}) has not been observed yet`,
      });
      continue;
    }
    // Phase 10B-18 Part D: at least one bundle member has been verified, but
    // `evaluateBundleCompletenessV1` (@capiro/defense-domain) still reports
    // `partial` for this expected source's registered member manifest — a
    // real, distinct fact from both `expected` (nothing observed) and
    // `published` (whole family complete). This must block on its own
    // reason, never fall through to the ingestion-outcome check below: doing
    // so would certify the family the moment the FIRST required member's
    // ingestion passes, exactly the false-completeness Part D forbids.
    if (source.expectedState === 'partially_published') {
      blocks.push({
        reason: 'required_source_bundle_incomplete',
        detail: `expected source ${source.expectedSourceId} (${source.sourceFamily}) has a multi-document bundle with required members still missing or unverified`,
      });
      continue;
    }
    // expectedState === 'published' or 'superseded' from here: a document
    // exists or existed. Corpus completeness now depends on Phase 10B-1
    // governed ingestion having actually completed for it.
    if (source.latestIngestion == null || source.latestIngestion === 'ingestion_incomplete') {
      blocks.push({
        reason: 'required_source_ingestion_incomplete',
        detail: `expected source ${source.expectedSourceId} (${source.sourceFamily}) is published but governed ingestion has not yet completed (ingestionSucceeded=true) for it`,
      });
      continue;
    }
    if (source.latestIngestion === 'ingested_review') {
      hasReview = true;
      blocks.push({
        reason: 'required_source_review_required',
        detail: `expected source ${source.expectedSourceId} (${source.sourceFamily}) ingested with verifier disposition REVIEW`,
      });
      continue;
    }
    if (source.latestIngestion === 'ingested_reject') {
      hasReject = true;
      blocks.push({
        reason: 'required_source_rejected',
        detail: `expected source ${source.expectedSourceId} (${source.sourceFamily}) ingested with verifier disposition REJECT`,
      });
      continue;
    }
    // 'ingested_pass' — resolved, no block.
    resolvedCount += 1;
  }

  if (blocks.length === 0) {
    return {
      identity: input.identity,
      cycleId: input.cycleId,
      state: 'ready_for_reconciliation',
      blocks: [],
      requiredCount,
      resolvedCount,
      excludedOptionalTerminalCount,
    };
  }

  // REJECT is reported alongside whatever else blocked, but the STATE
  // reported here is only ever waiting_for_sources or review_required — this
  // function never claims reconciliation_failed/certification_failed
  // (those are Phase 4/5/6 outcomes, reported only after those pipelines
  // actually run) and it never lets a REJECT silently promote by continuing
  // past this point as if ready.
  const state: CycleFamilyReadinessStateV1 = hasReview || hasReject
    ? 'review_required'
    : 'waiting_for_sources';

  return {
    identity: input.identity,
    cycleId: input.cycleId,
    state,
    blocks,
    requiredCount,
    resolvedCount,
    excludedOptionalTerminalCount,
  };
}
