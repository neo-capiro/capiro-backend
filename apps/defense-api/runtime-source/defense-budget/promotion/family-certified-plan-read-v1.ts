/**
 * Phase 10B-2C — Certification Bridge, shared row-interpretation module.
 *
 * RDT&E/procurement/O&M/MILCON self-certify INSIDE their own
 * `defense_budget_projection_plan` bundle document (a `certification`
 * literal embedded in `planDocument`) — there is no separate certification
 * row for these families, unlike Phase 6's `phase6_cycle_certification`.
 *
 * Two independent callers need to read this exact fact identically, and must
 * never be allowed to drift on what counts as "certified" for these
 * families:
 *
 *   - the Phase 10B-2 readiness/orchestration bridge
 *     (`readiness/prisma-family-reconciliation-certification-v1.ts`), which
 *     asks "is this family group's most recent reconciliation/certification
 *     output CERTIFIED?" — consumed by the readiness orchestrator's
 *     `reconcileAndCertify` step.
 *   - Phase 7 eligibility's trusted read repository
 *     (`promotion-eligibility-read-repository-prisma-v1.ts`), which asks
 *     "what certifications may this eligibility record cite as its
 *     `cycleCertificationIds`/`cycleCertificationHashes`?" — this is the
 *     PHASE10B2_EXISTING_ELIGIBILITY_CERTIFICATION_BOUNDARY_GAP fix: before
 *     this module existed, `loadCycleCertifications` understood only
 *     `phase6_cycle_certification`, so RDT&E/procurement/O&M/MILCON could
 *     never reach `awaiting_authorization` through the eligibility gate even
 *     when their own family certification was genuinely CERTIFIED.
 *
 * This module does not invoke, reimplement, or recompute reconciliation or
 * certification. It only interprets an already-persisted
 * `defense_budget_projection_plan` row — the same row
 * `readiness/prisma-family-reconciliation-certification-v1.ts` already reads
 * — through the shared envelope Phase 4/5 bundles embed
 * (`planDocument.certification`), exactly as
 * `projection-plan/projection-plan-record-v1.ts`'s own "read the shared
 * envelope, refuse what you cannot read" stance does.
 */

export interface FamilyCertifiedPlanRowV1 {
  readonly certificationSha256: string;
  readonly status: string;
  readonly planDocument: unknown;
}

export interface FamilyCertifiedPlanFactV1 {
  readonly certified: boolean;
  /** Phase 4/5's own embedded status literal, or a derived fallback. */
  readonly certificationStatus: string;
}

/**
 * Reads the certification literal a Phase 4/5 bundle embeds in its own
 * document (`planDocument.certification`), without importing the RDT&E or
 * non-RDT&E bundle schema — deliberately structural, so this module never
 * depends on either family's full contract.
 */
export function readEmbeddedCertificationLiteralV1(planDocument: unknown): string | null {
  if (planDocument == null || typeof planDocument !== 'object') return null;
  const value = (planDocument as Record<string, unknown>).certification;
  return typeof value === 'string' ? value : null;
}

/**
 * Derive the certified/not-certified fact for one `defense_budget_projection_plan`
 * row, exactly as Phase 4/5's own bundle status vocabulary defines it (any
 * literal starting with `CERTIFIED`), falling back to the row's own
 * `PROJECTABLE`/`BLOCKED` denormalized status only when the document itself
 * carries no embedded literal — a defensive fallback, not the primary path;
 * every real Phase 4/5 bundle always embeds one.
 */
export function deriveFamilyCertifiedPlanFactV1(
  row: FamilyCertifiedPlanRowV1,
): FamilyCertifiedPlanFactV1 {
  const embedded = readEmbeddedCertificationLiteralV1(row.planDocument);
  const certificationStatus =
    embedded ?? (row.status === 'PROJECTABLE' ? 'CERTIFIED_READY_FOR_PROJECTION' : 'INCOMPLETE');
  return {
    certified: certificationStatus.startsWith('CERTIFIED'),
    certificationStatus,
  };
}
