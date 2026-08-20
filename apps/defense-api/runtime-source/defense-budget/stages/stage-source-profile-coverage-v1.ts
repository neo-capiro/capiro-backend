/**
 * Phase 7 Gap 5, decision 2 — which budget families are governed by a
 * `DefenseBudgetStageSourceProfileV1`, and which legitimately have none.
 *
 * The promotion eligibility contract requires a candidate's source-profile hash
 * when — and only when — the candidate's source family actually has a governed
 * profile artifact. Phase 6 congressional and enacted sources do. RDT&E,
 * procurement, O&M, MILCON and MILPERS do not, and never did: a "source
 * profile" in this codebase is a Phase 6 concept that fixes track, stage,
 * authority, vehicle class, chamber, required line families, and enactment-proof
 * policy for one congressional document. Nothing analogous exists for a
 * J-book exhibit, and manufacturing one — hashing the verification policy, or
 * the parser profile job, or the authority-resolution inputs — would produce a
 * value that looks like evidence and proves nothing.
 *
 * So absence is valid, and fabrication is not. That asymmetry is the whole
 * decision, and it is enforced structurally in
 * `promotion-eligibility-v1.ts`: a candidate in a governed family must carry a
 * profile hash, and a candidate in an ungoverned family must carry `null`
 * rather than something plausible.
 *
 * This lives in `stages/` rather than in the promotion module on purpose. The
 * promotion module asking "does this family need a profile?" is a question
 * about Phase 6's source-profile policy, and Phase 6 owns the answer. A
 * `family === 'committee'` check in the promotion module would have been wrong
 * the moment a public-law source appeared — which it already has.
 */
import type { BudgetFamilyV1 } from '../contracts/extraction-artifact-v1.js';
import { STAGE_VEHICLE_CLASS_V1_VALUES, type StageVehicleClassV1 } from './stage-vocabulary-v1.js';

/**
 * The document family that carries each stage vehicle class.
 *
 * `null` means "this vehicle class has a governed profile, but no
 * `BudgetFamilyV1` value corresponds to its documents yet". That is the honest
 * state for reprogramming actions and execution reports: `stage-source-profile-
 * v1.ts` governs both, but `BUDGET_FAMILY_V1_VALUES` has no member for either,
 * and they are also precisely the stages Gap 1 still lists as open. Mapping
 * them to `public_law` or `unknown` to make the table look complete would put
 * a wrong family on a real document.
 *
 * Every vehicle class must appear here — asserted by a test — so adding one
 * forces this decision rather than silently defaulting to "ungoverned".
 */
export const STAGE_VEHICLE_CLASS_BUDGET_FAMILY_V1: Record<
  StageVehicleClassV1,
  BudgetFamilyV1 | null
> = {
  committee_report: 'committee',
  conference_report: 'committee',
  joint_explanatory_statement: 'committee',
  public_law: 'public_law',
  continuing_resolution: 'public_law',
  reprogramming_action: null,
  execution_report: null,
};

/**
 * Families whose documents are governed by a stage source profile, derived from
 * the table above rather than restated — the two cannot drift.
 */
export const STAGE_SOURCE_PROFILE_GOVERNED_FAMILIES_V1: readonly BudgetFamilyV1[] = [
  ...new Set(
    STAGE_VEHICLE_CLASS_V1_VALUES.map(
      (vehicleClass) => STAGE_VEHICLE_CLASS_BUDGET_FAMILY_V1[vehicleClass],
    ).filter((family): family is BudgetFamilyV1 => family != null),
  ),
].sort((a, b) => a.localeCompare(b));

/**
 * True when a candidate in this family must carry the hash of the governed
 * source profile it was extracted under.
 */
export function familyRequiresStageSourceProfileV1(family: BudgetFamilyV1): boolean {
  return STAGE_SOURCE_PROFILE_GOVERNED_FAMILIES_V1.includes(family);
}
