/** Phase 6 Workstream I — governed SAC-D Defense Appropriations source profile. */
import {
  DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
  parseStageSourceProfileV1,
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../../stage-source-profile-v1.js';

export interface CreateSacdSourceProfileV1Input {
  fiscalYear: number;
  reportNumber: string;
  sourceDocumentKeys: string[];
  profileVersion?: number;
}

export function createSacdSourceProfileV1(
  input: CreateSacdSourceProfileV1Input,
): DefenseBudgetStageSourceProfileV1 {
  return parseStageSourceProfileV1({
    schemaVersion: DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
    profileId: `fy${input.fiscalYear}-sacd-defense-appropriations-report`,
    profileVersion: input.profileVersion ?? 1,
    track: 'appropriations',
    stage: 'sac_d',
    authority: 'sacd_appropriations',
    fiscalYear: input.fiscalYear,
    vehicleClass: 'committee_report',
    chamber: 'senate',
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

export function sacdSourceProfileHashV1(input: CreateSacdSourceProfileV1Input): string {
  return stageSourceProfileHashV1(createSacdSourceProfileV1(input));
}

export const SACD_TABLE_COMPOSITION_POLICY_V1 = {
  allowBaselinePlusChange: true,
} as const;
