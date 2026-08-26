/**
 * Phase 10B-2D — materializing decorator over `FamilyReconciliationCertificationPortV1`.
 *
 * Composes, never replaces, the existing #1298 read-only adapter
 * (`PrismaFamilyReconciliationCertificationV1`):
 *
 *   1. Ask the existing read adapter first (fast path: already certified).
 *   2. Only when it reports "no projection plan filed yet" (INCOMPLETE, no
 *      row) AND the family group is one this PR proved reconstructable
 *      (procurement / om / milcon -- see
 *      `family-certification-materialization-v1.ts`'s header), invoke the
 *      materialization boundary to build+persist the EXISTING non-RDT&E
 *      pipeline's normal output through the EXISTING projection-plan
 *      substrate.
 *   3. Re-read through the SAME unchanged #1298 adapter afterward -- the
 *      decorator never returns its own interpretation of "is this
 *      certified", it always defers to the shared
 *      `family-certified-plan-read-v1.ts` interpretation that Phase 7
 *      eligibility also reads. This is what keeps readiness and eligibility
 *      agreeing on certification status/SHA/selected row (the brief's "do
 *      not reintroduce two independent interpretations" requirement).
 *
 * `rdte` uses the durable materializer. `committee` continues through the
 * existing read-only adapter.
 *
 * Idempotent: `materializeNonRdteFamilyCertificationV1` inserts via
 * `ProjectionPlanRepositoryV1.insert`, which is `ON CONFLICT (projection_plan_id)
 * DO NOTHING` on a content-addressed ID -- a second call for an unchanged
 * corpus is a no-op insert followed by the same reload, never a duplicate
 * artifact. Crash-safety: if the process dies after `insert` succeeds but
 * before this decorator returns, the NEXT call's read-only fast path (step 1)
 * finds the already-persisted row and never re-invokes materialization at
 * all -- no special crash-recovery code path is needed because the
 * persisted row IS the recovery state.
 */
import type {
  FamilyReconciliationCertificationPortV1,
  FamilyReconciliationCertificationResultV1,
} from './cycle-family-readiness-orchestrator-v1.js';
import type { CycleFamilyReadinessIdentityV1, CycleFamilyCorpusInputV1 } from './cycle-family-readiness-v1.js';
import {
  isMaterializableNonRdteFamily,
  materializeNonRdteFamilyCertificationV1,
  MISSING_DURABLE_INPUT_NOTES,
  type MaterializationArtifactSourcePortV1,
  type MaterializationManifestInputV1,
} from './family-certification-materialization-v1.js';
import type { ProjectionPlanRepositoryV1 } from '../../projection-plan/projection-plan-repository-prisma-v1.js';
import { materializeRdteFamilyCertificationV1 } from './family-certification-materialization-rdte-v1.js';

export interface ManifestForMaterializationPortV1 {
  /**
   * Loads the exact governed manifest input for one readiness identity's
   * corpus -- never fabricated, always the same manifest the readiness
   * layer already evaluated this corpus against. Returns null when no
   * manifest is durably resolvable, which the decorator treats as
   * `missing_durable_input` rather than guessing an empty manifest.
   */
  loadManifestForIdentity(
    identity: CycleFamilyReadinessIdentityV1,
    cycleId: string,
  ): Promise<MaterializationManifestInputV1 | null>;
}

export class MaterializingFamilyReconciliationCertificationV1
  implements FamilyReconciliationCertificationPortV1
{
  constructor(
    private readonly readOnlyAdapter: FamilyReconciliationCertificationPortV1,
    private readonly manifestSource: ManifestForMaterializationPortV1,
    private readonly artifactSource: MaterializationArtifactSourcePortV1,
    private readonly projectionPlans: ProjectionPlanRepositoryV1,
    private readonly producerVersion: string,
  ) {}

  async reconcileAndCertify(
    identity: CycleFamilyReadinessIdentityV1,
    corpus: CycleFamilyCorpusInputV1,
  ): Promise<FamilyReconciliationCertificationResultV1> {
    const existing = await this.readOnlyAdapter.reconcileAndCertify(identity, corpus);
    if (existing.certified) return existing;

    // Only attempt materialization on the specific "nothing filed yet" shape
    // -- a REJECTED/NEEDS_REVIEW certification is a real Phase 4/5 outcome
    // that must not be silently retried by filing a second competing row.
    if (existing.certificationStatus !== 'INCOMPLETE') return existing;

    if (!isMaterializableNonRdteFamily(identity.familyGroup) && identity.familyGroup !== 'rdte') {
      return {
        ...existing,
        reason: MISSING_DURABLE_INPUT_NOTES[identity.familyGroup] ?? existing.reason,
      };
    }

    const manifest = await this.manifestSource.loadManifestForIdentity(identity, corpus.cycleId);
    if (manifest == null) {
      return {
        ...existing,
        reason:
          `${existing.reason}; additionally, no durable governed manifest could be resolved for ` +
          `this readiness identity, so materialization cannot be attempted`,
      };
    }

    const materialization = identity.familyGroup === 'rdte'
      ? await materializeRdteFamilyCertificationV1(
          { identity, cycleId: corpus.cycleId, manifest },
          { artifactSource: this.artifactSource, projectionPlans: this.projectionPlans, producerVersion: this.producerVersion },
        )
      : await materializeNonRdteFamilyCertificationV1(
      { identity, cycleId: corpus.cycleId, manifest },
      {
        artifactSource: this.artifactSource,
        projectionPlans: this.projectionPlans,
        producerVersion: this.producerVersion,
      },
        );

    if (materialization.outcome !== 'materialized') {
      return {
        ...existing,
        reason: `${existing.reason}; materialization attempt: ${materialization.detail}`,
      };
    }

    // Never trust the materialization's own in-memory verdict as the final
    // answer -- re-read through the EXACT SAME unchanged read-only adapter
    // that Phase 7 eligibility's shared interpretation
    // (`family-certified-plan-read-v1.ts`) also uses, so a single source of
    // truth decides "is this certified" no matter which path filed the row.
    return this.readOnlyAdapter.reconcileAndCertify(identity, corpus);
  }
}
