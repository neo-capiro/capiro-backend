/**
 * Phase 10B-18 Part C/D — source-bundle completeness.
 *
 * Answers the question Phase 10B-18 Part B traced through the whole
 * observation/readiness pipeline: `DefenseBudgetExpectedSource` is a single
 * identity slot per (fiscalYear, authorityTrack, sourceFamily, stage,
 * chamber, committee, component) — its own template label ("RDT&E R-2
 * exhibits", plural) already says the real-world thing it stands for a
 * *family* of documents for some components, but every consumer up to this
 * phase (`lifecycle-watcher.service.ts`'s unconditional `published` write
 * after the FIRST successful observation, and
 * `prisma-readiness-corpus-loader-v1.ts` picking only the single newest
 * observation) behaved as though ONE arriving document always satisfies the
 * WHOLE expected source. That is correct for the ~55 other FY24 request-track
 * expected sources, which really are one document each — it is wrong for
 * Army's FY24 R-2 exhibit, which the real asafm.army.mil corpus publishes as
 * (at least) 10 separate BA volumes under ONE identity slot.
 *
 * This module is the shared, pure decision point both the live watcher and
 * the governed-import path call so that gap cannot silently reopen in one
 * path while being fixed in the other. It never talks to Prisma or S3; it is
 * pure functions over already-loaded facts, exactly like every other
 * decision module in this package.
 */

export const BUNDLE_MEMBER_STATUS_VALUES = ['missing', 'observed', 'verified'] as const;
export type BundleMemberStatus = (typeof BUNDLE_MEMBER_STATUS_VALUES)[number];

export interface BundleMemberFactsV1 {
  readonly required: boolean;
  readonly memberStatus: BundleMemberStatus;
}

export const BUNDLE_COMPLETENESS_VALUES = ['no_bundle', 'partial', 'complete'] as const;
export type BundleCompletenessV1 = (typeof BUNDLE_COMPLETENESS_VALUES)[number];

/**
 * `no_bundle` — this expected source has no registered member manifest at
 * all (the ~55 ordinary single-document families; also a bundled family
 * before its member manifest has been seeded). Treated identically to
 * `complete` by the caller below: a single document has always been the
 * whole story for these, and that must not change.
 *
 * `partial` — a manifest exists and at least one REQUIRED member is not yet
 * `verified`.
 *
 * `complete` — a manifest exists and every REQUIRED member is `verified`.
 * Optional members (e.g. a classified annex whose existence could not be
 * confirmed in the Part E research) never block completeness.
 */
export function evaluateBundleCompletenessV1(
  members: readonly BundleMemberFactsV1[],
): BundleCompletenessV1 {
  if (members.length === 0) return 'no_bundle';
  const required = members.filter((m) => m.required);
  if (required.length === 0) return 'complete';
  return required.every((m) => m.memberStatus === 'verified') ? 'complete' : 'partial';
}

/**
 * Decide the `expected_state` to write when a new document has just been
 * classified and recorded for an expected source. `no_bundle`/`complete`
 * both resolve to the existing `published` semantics unchanged — this is the
 * exact byte-for-byte behavior every existing single-document family already
 * relies on. Only `partial` diverges, to the new `partially_published`
 * state: a document exists and was accepted, but the corpus this expected
 * source represents is not yet whole, and nothing downstream may treat it as
 * though it were.
 */
export function decideExpectedSourceStateOnDocumentArrivalV1(
  bundleCompleteness: BundleCompletenessV1,
): 'published' | 'partially_published' {
  return bundleCompleteness === 'partial' ? 'partially_published' : 'published';
}

/** Deterministic member identity: never a physical filename (those are unstable). */
export function armyRdteMemberKey(input: { volume: string; budgetActivity: string }): string {
  return `volume_${input.volume}_ba_${input.budgetActivity}`;
}
