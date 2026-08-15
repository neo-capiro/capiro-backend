/**
 * Neo's decision, 2026-08-08 — settled architecture, do not reopen.
 *
 * **`native identity ≠ crosswalk`.** A PE→BLIN relationship exists only when a
 * reviewed relationship record supports it.
 *
 * ---------------------------------------------------------------------------
 * What this forbids, and why it is not merely a style preference
 * ---------------------------------------------------------------------------
 *
 * RDT&E and procurement have structurally different native identities:
 *
 * ```text
 *   RDT&E        peCode
 *   Procurement  component + account + lineCode + advanceProcurement
 * ```
 *
 * They are different canonical entities. The legacy
 * `program_element_procurement_line` table makes a `peCode`→BLIN lookup *look*
 * available, and that table is precisely the identity conflation Workstreams G
 * and H exist to remove — the registry says so in its own header. So the fact
 * that legacy tables make the traversal possible is not authorization to
 * preserve it: reproducing it in cleaner, snapshot-backed code would re-create
 * the defect with better formatting, and the failure mode is attributing
 * procurement money to the wrong program.
 *
 * A relationship must never be inferred from matching titles, legacy foreign
 * keys, `program_element_procurement_line`, shared program names, proximity in
 * a budget book, performer overlap, or award overlap.
 *
 * ---------------------------------------------------------------------------
 * The substrate that exists, and the one field group it is missing
 * ---------------------------------------------------------------------------
 *
 * `canonical_budget_line_relationship` is the right substrate and should be
 * reused rather than replaced. It already carries both native identities
 * (`fromFamily`/`fromNaturalKey` → `toFamily`/`toNaturalKey`), a
 * `relationshipType`, `evidenceIds`, an `explicitInSource` flag, and full
 * verification lineage; its registry entry sets `moneyRule: 'none'` and
 * `alertEligible: false`, and states that a relationship "is a link, never a
 * funding position, so it can never contribute to a total."
 *
 * What its physical model (`NonRdteBudgetLineRelationship`) does **not** carry
 * is the review triple: `status` (`candidate` | `accepted` | `rejected`),
 * `reviewedBy`, and `reviewedAt`. Verified 2026-08-08 — zero such columns.
 *
 * That gap is the whole reason the affected read methods stay on the legacy
 * path. An unreviewed link is a *candidate*, and serving a candidate as though
 * it were an accepted relationship is the same misattribution in a different
 * costume. `GOVERNED_CROSSWALK_REQUIRED_FIELDS_V1` below is the contract a
 * future migration has to satisfy before any snapshot-backed procurement
 * traversal may ship, and `crosswalkSubstrateReadinessV1` reports honestly on
 * whether it does yet.
 */

/** The shape a governed PE↔BLIN crosswalk record must have to be usable. */
export interface GovernedCrosswalkRecordV1 {
  /** Native RDT&E identity — never a BLIN, never a title. */
  rdtePeIdentity: string;
  /** Native procurement identity — component + account + lineCode + AP. */
  procurementBlinIdentity: string;
  relationshipType: string;
  /** An unreviewed link is a candidate, and a candidate is not a relationship. */
  status: 'candidate' | 'accepted' | 'rejected';
  evidenceIds: readonly string[];
  source: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

/**
 * Field-level contract, as data rather than prose, so a readiness check can
 * assert against it instead of a human re-reading this file.
 */
export const GOVERNED_CROSSWALK_REQUIRED_FIELDS_V1 = [
  'rdtePeIdentity',
  'procurementBlinIdentity',
  'relationshipType',
  'status',
  'evidenceIds',
  'source',
  'reviewedBy',
  'reviewedAt',
] as const satisfies readonly (keyof GovernedCrosswalkRecordV1)[];

/**
 * Fields `canonical_budget_line_relationship` / `NonRdteBudgetLineRelationship`
 * actually provides today, expressed in this contract's vocabulary.
 *
 * `fromNaturalKey`/`toNaturalKey` cover the two identities and `sourceDocumentId`
 * plus the artifact/PDF SHAs cover `source`; the review triple has no column.
 */
export const CROSSWALK_SUBSTRATE_PRESENT_FIELDS_V1 = [
  'rdtePeIdentity',
  'procurementBlinIdentity',
  'relationshipType',
  'evidenceIds',
  'source',
] as const satisfies readonly (keyof GovernedCrosswalkRecordV1)[];

export interface CrosswalkReadinessV1 {
  ready: boolean;
  missingFields: readonly (keyof GovernedCrosswalkRecordV1)[];
  /** Why a caller may not fall back to legacy-style traversal meanwhile. */
  detail: string;
}

/**
 * Whether a governed PE↔BLIN crosswalk is available for snapshot-backed reads.
 *
 * Returns `ready: false` today. That is the correct, load-bearing answer, not a
 * stub: while it is false, procurement traversal from a `peCode` stays on the
 * legacy path and is labelled as such, rather than being migrated onto an
 * ungoverned link.
 */
export function crosswalkSubstrateReadinessV1(): CrosswalkReadinessV1 {
  const present = new Set<string>(CROSSWALK_SUBSTRATE_PRESENT_FIELDS_V1);
  const missingFields = GOVERNED_CROSSWALK_REQUIRED_FIELDS_V1.filter(
    (field) => !present.has(field),
  );
  return {
    ready: missingFields.length === 0,
    missingFields,
    detail:
      missingFields.length === 0
        ? 'governed PE↔BLIN crosswalk is available; snapshot-backed procurement traversal may proceed'
        : 'canonical_budget_line_relationship carries both native identities and evidence but no ' +
          'review state, so every link in it is a candidate. Snapshot-backed procurement traversal ' +
          'from a peCode must not ship until the review triple exists and links are reviewed; the ' +
          'affected read methods stay on the legacy path and are labelled as candidates.',
  };
}

/**
 * How a cross-family link may be described to a user.
 *
 * "Related procurement line" is reserved for an accepted relationship.
 * A candidate is always hedged, and a BLIN is never rendered as a child PE
 * record — it is a peer identity in a different family, and presenting it as a
 * child is the visual form of the same conflation.
 */
export function crossFamilyLinkLabelV1(status: GovernedCrosswalkRecordV1['status']): string {
  switch (status) {
    case 'accepted':
      return 'Related procurement line';
    case 'candidate':
      return 'Possible related procurement line';
    case 'rejected':
      return 'Rejected procurement line association';
  }
}
