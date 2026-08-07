/** Phase 6 Workstream L — governed full-year public-law source profile. */
import {
  DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
  parseStageSourceProfileV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../stage-source-profile-v1.js';

export function createEnactedPublicLawSourceProfileV1(input: {
  fiscalYear: number;
  publicLawNumber: string;
  billId: string;
  publicLawDocumentKey: string;
  lineDetailDocumentKey?: string;
  profileVersion?: number;
}): DefenseBudgetStageSourceProfileV1 {
  const lineDetailKey = input.lineDetailDocumentKey ?? input.publicLawDocumentKey;
  return parseStageSourceProfileV1({
    schemaVersion: DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
    profileId: `fy${input.fiscalYear}-defense-appropriations-enacted`,
    profileVersion: input.profileVersion ?? 1,
    track: 'appropriations',
    stage: 'public_law',
    authority: 'enacted_public_law',
    fiscalYear: input.fiscalYear,
    vehicleClass: 'public_law',
    chamber: 'none',
    billId: input.billId,
    publicLawNumber: input.publicLawNumber,
    // Both independently hashed documents are governed by the profile. The
    // extraction artifact itself uses the exact line-detail source so every
    // evidence item retains the Phase 1 single-source-SHA invariant.
    sourceDocumentKeys: [...new Set([input.publicLawDocumentKey, lineDetailKey])],
    companionDocuments:
      lineDetailKey === input.publicLawDocumentKey
        ? []
        : [
            {
              companionKind: 'joint_explanatory_statement',
              manifestDocumentKey: lineDetailKey,
              required: true,
            },
          ],
    requiredLineFamilies: ['rdte_pe', 'procurement_blin', 'om_sag', 'milcon_project'],
    tableSemanticsPolicy: 'totals_only',
    declaredUnits: ['dollars', 'thousands', 'millions'],
    requiredComparisonStages: ['appropriations_conference'],
    enactmentProofRequirement: 'statutory_or_incorporated',
    absenceAllowed: true,
  });
}
