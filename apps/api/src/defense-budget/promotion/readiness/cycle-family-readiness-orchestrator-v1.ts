/**
 * Phase 10B-2 — Cycle/Family Readiness & Promotion Planning orchestrator.
 *
 * Owns exactly:
 *
 *   successfully ingested observations
 *     -> determine cycle/family corpus completeness   (cycle-family-readiness-v1.ts)
 *     -> assemble the exact required SourceDocument/evidence set
 *     -> run EXISTING Phase 4/5/6 reconciliation/certification (via port; never reimplemented)
 *     -> call the EXISTING promotion planner (buildPromotionPlanV1) and EXISTING
 *        eligibility service (DefenseBudgetPromotionEligibilityServiceV1)
 *     -> persist plan + plan hash (same row shape as file-defense-budget-promotion-plan-v1)
 *     -> report awaiting_authorization
 *
 * ABSOLUTE INVARIANT: this module never authorizes or executes canonical
 * promotion. It does not import, reference, or call
 * `DefenseBudgetPromotionAuthorizationServiceV1.issue`,
 * `DefenseBudgetCanonicalPromotionServiceV1.execute`, and it never reads
 * `PROMOTER_DATABASE_URL`. It stops at `awaiting_authorization` — see
 * `evaluateAndAdvanceCycleFamilyReadinessV1`'s return type, which has no
 * "authorized" or "executed" member.
 *
 * Triggering: designed to be called idempotently, synchronously, right after
 * one observation's Phase 10B-1 bridge run resolves — see the bridge's own
 * header ("wait for required family/cycle corpus" in the traced diagram). NOT
 * a new always-on service: no listener, no poller, no EventBridge rule is
 * added by this module. A caller (a one-shot CLI, or the bridge's own
 * post-success hook in a LATER phase) invokes `run()` once per affected
 * (fiscalYear, authorityTrack, familyGroup) scope and gets back either
 * "waiting"/"blocked" (no-op) or a freshly-built-or-replayed plan.
 */
import { createHash } from 'node:crypto';
import {
  evaluateCycleFamilyReadinessV1,
  type CycleFamilyCorpusInputV1,
  type CycleFamilyReadinessDecisionV1,
  type CycleFamilyReadinessIdentityV1,
} from './cycle-family-readiness-v1.js';
import {
  buildPromotionPlanV1,
  promotionPlanHashV1,
  type DefenseBudgetPromotionPlanV1,
  type ManualOverlayV1,
  type PriorCanonicalRowV1,
  type PromotionModeV1,
  type PromotionProjectionInputV1,
} from '../promotion-planner-v1.js';
import {
  canonicalMappingRegistryHashV1,
  DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
} from '../canonical-mapping-registry-v1.js';
import {
  DefenseBudgetPromotionEligibilityServiceV1,
  type PromotionEligibilityRepositoryV1,
  type PromotionAuditSinkV1,
  type PromotionEligibilityRequestV1,
} from '../promotion-eligibility-service-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../../contracts/canonical-json.js';
import type { BudgetFamilyV1 } from '../../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* O1. Ports — everything this orchestrator depends on is EXISTING       */
/* ------------------------------------------------------------------ */

/**
 * Loads the exact corpus input for one readiness identity from persistence
 * (`DefenseBudgetExpectedSource` rows joined to their latest Phase 10B-1
 * bridge outcome). Implemented against the real database in a later wiring
 * pass; the orchestration logic here is provable against a fake today.
 */
export interface ReadinessCorpusLoaderPortV1 {
  loadCorpus(identity: CycleFamilyReadinessIdentityV1): Promise<CycleFamilyCorpusInputV1>;
}

/**
 * One certified reconciliation outcome for a family group, in the shape the
 * EXISTING promotion eligibility/planning layer already consumes. This port
 * exists so the orchestrator never re-implements `certifyRdteCycle` /
 * `certifyNonRdteCycle` / Phase 6's committee certifier — a real
 * implementation of this port is a thin adapter over exactly one of those
 * three, selected by `identity.familyGroup`.
 */
export interface FamilyReconciliationCertificationResultV1 {
  readonly certified: boolean;
  /** Phase 4/5/6's own status literal (CERTIFIED_..., NEEDS_REVIEW, REJECTED, INCOMPLETE). */
  readonly certificationStatus: string;
  readonly blockingFindingCount: number;
  /** Present only when `certified`. The exact content hash of the cycle bundle Phase 4/5/6 produced. */
  readonly certificationContentSha256: string | null;
  /** Present only when `certified`. Null for RDT&E/non-RDT&E (self-certifying, no row); set for Phase 6. */
  readonly certificationRowId: string | null;
  readonly reason: string;
}

export interface FamilyReconciliationCertificationPortV1 {
  reconcileAndCertify(
    identity: CycleFamilyReadinessIdentityV1,
    corpus: CycleFamilyCorpusInputV1,
  ): Promise<FamilyReconciliationCertificationResultV1>;
}

/**
 * Everything needed to call the EXISTING `buildPromotionPlanV1` for a
 * certified family group: the eligibility repository port it already
 * requires (`PromotionEligibilityRepositoryV1`, unchanged) plus the raw
 * inputs `buildPromotionPlanV1` itself takes (never re-specified — imported
 * from `promotion-planner-v1.ts` directly).
 */
export interface PromotionPlanInputLoaderPortV1 {
  loadProjections(
    identity: CycleFamilyReadinessIdentityV1,
    certificationContentSha256: string,
  ): Promise<readonly PromotionProjectionInputV1[]>;
  loadPriorRows(
    identity: CycleFamilyReadinessIdentityV1,
  ): Promise<readonly PriorCanonicalRowV1[]>;
  loadOverlays(
    identity: CycleFamilyReadinessIdentityV1,
  ): Promise<readonly ManualOverlayV1[]>;
  loadExpectedActiveSnapshot(
    identity: CycleFamilyReadinessIdentityV1,
  ): Promise<{ snapshotId: string; snapshotHash: string } | null>;
}

/**
 * Persists a promotion plan row in EXACTLY the shape
 * `file-defense-budget-promotion-plan-v1.ts` already inserts (same table,
 * same columns, same idempotent-replay-by-plan_id-and-hash semantics). This
 * orchestrator never talks to Prisma directly — a real implementation is a
 * thin wrapper over that exact INSERT statement.
 */
export interface PromotionPlanPersistencePortV1 {
  /**
   * Returns `{ filed: true, replay: false }` on first file, `{ filed: true,
   * replay: true }` when the identical (planId, planHash) already exists,
   * and MUST throw (never silently succeed) when `planId` already exists
   * with a DIFFERENT `planHash` — the exact `plan_id_conflict` refusal
   * `file-defense-budget-promotion-plan-v1.ts` already implements.
   */
  persistPlan(plan: DefenseBudgetPromotionPlanV1): Promise<{ filed: boolean; replay: boolean }>;
}

export interface CycleFamilyReadinessOrchestratorPortsV1 {
  readonly corpusLoader: ReadinessCorpusLoaderPortV1;
  readonly reconciliationCertification: FamilyReconciliationCertificationPortV1;
  readonly eligibilityRepository: PromotionEligibilityRepositoryV1;
  readonly eligibilityAudit: PromotionAuditSinkV1;
  readonly planInputs: PromotionPlanInputLoaderPortV1;
  readonly planPersistence: PromotionPlanPersistencePortV1;
  readonly now: () => Date;
}

/* ------------------------------------------------------------------ */
/* O2. Result contract                                                  */
/* ------------------------------------------------------------------ */

/**
 * Mirrors `CycleFamilyReadinessStateV1` exactly, plus the two Phase 4/5/6
 * outcomes this orchestrator is the first caller to actually reach:
 * `reconciliation_failed` / `certification_failed`. There is deliberately no
 * "authorized" or "executed" member — see the file header invariant.
 */
export const ORCHESTRATOR_OUTCOME_V1_VALUES = [
  'waiting_for_sources',
  'review_required',
  'reconciliation_failed',
  'certification_failed',
  'ready_for_plan',
  'awaiting_authorization',
] as const;
export type OrchestratorOutcomeV1 = (typeof ORCHESTRATOR_OUTCOME_V1_VALUES)[number];

export interface CycleFamilyReadinessRunResultV1 {
  readonly identity: CycleFamilyReadinessIdentityV1;
  readonly outcome: OrchestratorOutcomeV1;
  readonly readiness: CycleFamilyReadinessDecisionV1;
  readonly reconciliation: FamilyReconciliationCertificationResultV1 | null;
  readonly planId: string | null;
  readonly planHash: string | null;
  readonly planReplay: boolean | null;
  readonly eligibilityHash: string | null;
  readonly detail: string;
}

/* ------------------------------------------------------------------ */
/* O3. Deterministic identifiers                                        */
/* ------------------------------------------------------------------ */

/**
 * Content-addressed, exactly like every other identifier in this schema
 * (`projectionPlanIdV1`, `budgetCycleDedupKey`, ...). Re-running readiness
 * for the same identity against the same certified certification content
 * hash always derives the same `eligibilityId`/`planId` seed — this is what
 * makes "replay creates no duplicate plan" and "changed inputs create a new
 * plan identity" both true by construction, without a lookup table.
 */
function deterministicSeedHexV1(input: JsonValue): string {
  return createHash('sha256').update(sha256CanonicalJson(input)).digest('hex').slice(0, 24);
}

function budgetFamilyForGroupV1(familyGroup: CycleFamilyReadinessIdentityV1['familyGroup']): BudgetFamilyV1 {
  // 'committee' family group carries Phase 6 congressional-action projections,
  // whose canonical mapping-registry family is 'committee' — same literal,
  // asserted here rather than assumed so a future rename fails loudly.
  return familyGroup;
}

function deterministicUuidV1(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = (((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8) >>> 0).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

/* ------------------------------------------------------------------ */
/* O4. The orchestrator                                                 */
/* ------------------------------------------------------------------ */

/**
 * Run readiness evaluation and, when the corpus is complete and certifies
 * clean, build and persist exactly one deterministic promotion plan —
 * stopping at `awaiting_authorization`. Idempotent: calling this twice in a
 * row with no change to the underlying corpus/certification produces the
 * identical plan identity and a `replay: true` persistence result rather
 * than a second pending plan.
 *
 * This function NEVER calls anything that authorizes or executes canonical
 * promotion. It has no code path that constructs
 * `DefenseBudgetPromotionAuthorizationServiceV1`,
 * `DefenseBudgetCanonicalPromotionServiceV1`, or reads
 * `PROMOTER_DATABASE_URL` / `process.env.DATABASE_URL` for a promoting
 * purpose — grep for those identifiers in this file to verify: there are
 * none.
 */
export async function evaluateAndAdvanceCycleFamilyReadinessV1(
  identity: CycleFamilyReadinessIdentityV1,
  ports: CycleFamilyReadinessOrchestratorPortsV1,
  options: {
    /** Threaded straight into `buildPromotionPlanV1`; callers decide the run's declared intent. */
    mode: PromotionModeV1;
    domain?: string;
    environment: string;
    requestedByActorId?: string;
  },
): Promise<CycleFamilyReadinessRunResultV1> {
  const domain = options.domain ?? 'defense_budget';

  /* ---- Step 1: readiness (pure, from the exact governed corpus) ---- */

  const corpus = await ports.corpusLoader.loadCorpus(identity);
  const readiness = evaluateCycleFamilyReadinessV1(corpus);

  if (readiness.state === 'waiting_for_sources' || readiness.state === 'review_required') {
    return {
      identity,
      outcome: readiness.state,
      readiness,
      reconciliation: null,
      planId: null,
      planHash: null,
      planReplay: null,
      eligibilityHash: null,
      detail:
        readiness.state === 'waiting_for_sources'
          ? 'corpus is not yet complete; no reconciliation was invoked'
          : 'a required source needs human review or was rejected; no reconciliation was invoked',
    };
  }

  /* ---- Step 2: reconciliation/certification (EXISTING Phase 4/5/6 pipeline, via port) ---- */

  const reconciliation = await ports.reconciliationCertification.reconcileAndCertify(
    identity,
    corpus,
  );

  if (!reconciliation.certified || reconciliation.certificationContentSha256 == null) {
    // Distinguish the two failure shapes the spec requires distinguished,
    // using Phase 4/5/6's OWN status literal rather than guessing from the
    // blocking-finding count alone.
    const isReconciliationShapeFailure =
      reconciliation.certificationStatus === 'INCOMPLETE' ||
      reconciliation.certificationStatus === 'NEEDS_REVIEW';
    return {
      identity,
      outcome: isReconciliationShapeFailure ? 'reconciliation_failed' : 'certification_failed',
      readiness,
      reconciliation,
      planId: null,
      planHash: null,
      planReplay: null,
      eligibilityHash: null,
      detail: reconciliation.reason,
    };
  }

  /* ---- Step 3: eligibility (EXISTING DefenseBudgetPromotionEligibilityServiceV1) ---- */

  const eligibilityService = new DefenseBudgetPromotionEligibilityServiceV1(
    ports.eligibilityRepository,
    ports.eligibilityAudit,
    {
      now: ports.now,
      eligibilityId: (request: PromotionEligibilityRequestV1) =>
        `elig-${deterministicSeedHexV1({
          cycleId: request.cycleId,
          fiscalYear: request.fiscalYear,
          families: request.families,
          certificationContentSha256: reconciliation.certificationContentSha256,
        } as unknown as JsonValue)}`,
    },
  );

  const eligibilityRequest: PromotionEligibilityRequestV1 = {
    cycleId: corpus.cycleId,
    fiscalYear: identity.fiscalYear,
    families: [budgetFamilyForGroupV1(identity.familyGroup)],
    domain,
    environment: options.environment,
    ...(options.requestedByActorId != null
      ? { requestedByActorId: options.requestedByActorId }
      : {}),
  };

  const eligibilityResult = await eligibilityService.evaluate(eligibilityRequest);

  if (!eligibilityResult.eligible || eligibilityResult.eligibility == null || eligibilityResult.eligibilityHash == null) {
    return {
      identity,
      outcome: 'certification_failed',
      readiness,
      reconciliation,
      planId: null,
      planHash: null,
      planReplay: null,
      eligibilityHash: null,
      detail:
        `certified corpus did not pass the existing eligibility gate: ` +
        eligibilityResult.blocks.map((block) => `${block.reason}: ${block.detail}`).join('; '),
    };
  }

  /* ---- Step 4: build the EXISTING promotion plan (buildPromotionPlanV1) ---- */

  const activeSnapshot = await ports.planInputs.loadExpectedActiveSnapshot(identity);
  const [projections, priorRows, overlays] = await Promise.all([
    ports.planInputs.loadProjections(identity, reconciliation.certificationContentSha256),
    ports.planInputs.loadPriorRows(identity),
    ports.planInputs.loadOverlays(identity),
  ]);

  const scopeSeed = {
    domain,
    environment: options.environment,
    scope: eligibilityResult.eligibility.scope,
    mode: options.mode,
    // Bound into the plan-identity seed so a changed certified corpus (a
    // different certification content hash) always derives a DIFFERENT
    // planId — required by "changed certified inputs create a new plan/hash"
    // — while an unchanged corpus replayed twice derives the SAME planId —
    // required by "replay creates no duplicate plan".
    certificationContentSha256: reconciliation.certificationContentSha256,
    eligibilityHash: eligibilityResult.eligibilityHash,
  } as unknown as JsonValue;
  const planId = `plan-${deterministicSeedHexV1(scopeSeed)}`;
  const proposedSnapshotId = deterministicUuidV1(`snapshot:${JSON.stringify(scopeSeed)}`);

  const plan = buildPromotionPlanV1({
    planId,
    eligibilityHash: eligibilityResult.eligibilityHash,
    scope: eligibilityResult.eligibility.scope,
    mode: options.mode,
    proposedSnapshotId,
    expectedActiveSnapshotId: eligibilityResult.eligibility.expectedActiveSnapshotId,
    actualActiveSnapshotId: activeSnapshot?.snapshotId ?? null,
    mappingRegistryHash: canonicalMappingRegistryHashV1(),
    projections: [...projections],
    priorRows: [...priorRows],
    overlays: [...overlays],
  });

  if (
    eligibilityResult.eligibility.mappingRegistryVersion !==
      DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION ||
    eligibilityResult.eligibility.mappingRegistryHash !== canonicalMappingRegistryHashV1()
  ) {
    return {
      identity,
      outcome: 'certification_failed',
      readiness,
      reconciliation,
      planId: null,
      planHash: null,
      planReplay: null,
      eligibilityHash: eligibilityResult.eligibilityHash,
      detail: `eligibility was evaluated under a different mapping registry version/hash than is current; refusing to plan against a stale mapping`,
    };
  }

  /* ---- Step 5: persist plan + hash, stop at awaiting_authorization ---- */

  const persistResult = await ports.planPersistence.persistPlan(plan);

  return {
    identity,
    outcome: 'awaiting_authorization',
    readiness,
    reconciliation,
    planId: plan.planId,
    planHash: plan.planHash,
    planReplay: persistResult.replay,
    eligibilityHash: eligibilityResult.eligibilityHash,
    detail: plan.blocked
      ? `plan persisted with ${plan.counts.blocked} blocked item(s); awaiting human authorization decision (which will itself refuse a blocked plan)`
      : `plan persisted (${plan.counts.insert} insert, ${plan.counts.supersede} supersede, ${plan.counts.correction} correction, ${plan.counts.unchanged} unchanged); awaiting_authorization`,
  };
}

/**
 * Guarantee the plan hash returned to a caller is always the freshly
 * recomputed one, never a stored value trusted verbatim — mirrors
 * `file-defense-budget-promotion-plan-v1.ts`'s own tamper check.
 */
export function verifyPersistedPlanHashV1(plan: DefenseBudgetPromotionPlanV1): boolean {
  const { planHash, ...withoutHash } = plan;
  return promotionPlanHashV1(withoutHash) === planHash;
}
