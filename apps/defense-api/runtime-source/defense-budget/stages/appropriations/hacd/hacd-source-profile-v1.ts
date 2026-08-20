/** Phase 6 Workstream H — governed HAC-D Defense Appropriations source profile. */
import {
  DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
  parseStageSourceProfileV1,
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../../stage-source-profile-v1.js';

export interface CreateHacdSourceProfileV1Input {
  fiscalYear: number;
  reportNumber: string;
  sourceDocumentKeys: string[];
  profileVersion?: number;
}

export function createHacdSourceProfileV1(
  input: CreateHacdSourceProfileV1Input,
): DefenseBudgetStageSourceProfileV1 {
  return parseStageSourceProfileV1({
    schemaVersion: DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
    profileId: `fy${input.fiscalYear}-hacd-defense-appropriations-report`,
    profileVersion: input.profileVersion ?? 1,
    track: 'appropriations',
    stage: 'hac_d',
    authority: 'hacd_appropriations',
    fiscalYear: input.fiscalYear,
    vehicleClass: 'committee_report',
    chamber: 'house',
    reportNumber: input.reportNumber,
    sourceDocumentKeys: input.sourceDocumentKeys,
    companionDocuments: [],
    requiredLineFamilies: [
      'rdte_pe',
      'procurement_blin',
      'om_sag',
      'milcon_project',
      'general_provisions',
      'classified',
    ],
    tableSemanticsPolicy: 'header_required',
    declaredUnits: ['dollars', 'thousands', 'millions'],
    requiredComparisonStages: [],
    enactmentProofRequirement: 'not_required',
    absenceAllowed: true,
  });
}

export function hacdSourceProfileHashV1(input: CreateHacdSourceProfileV1Input): string {
  return stageSourceProfileHashV1(createHacdSourceProfileV1(input));
}

export const HACD_TABLE_COMPOSITION_POLICY_V1 = {
  allowBaselinePlusChange: true,
} as const;
