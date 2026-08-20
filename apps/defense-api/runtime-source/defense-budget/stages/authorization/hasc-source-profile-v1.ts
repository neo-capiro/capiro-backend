/** Phase 6 Workstream D — governed HASC source-profile instance. */
import {
  DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
  parseStageSourceProfileV1,
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../stage-source-profile-v1.js';

export interface CreateHascSourceProfileV1Input {
  fiscalYear: number;
  reportNumber: string;
  sourceDocumentKeys: string[];
  profileVersion?: number;
}

export function createHascSourceProfileV1(
  input: CreateHascSourceProfileV1Input,
): DefenseBudgetStageSourceProfileV1 {
  return parseStageSourceProfileV1({
    schemaVersion: DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
    profileId: `fy${input.fiscalYear}-hasc-authorization-report`,
    profileVersion: input.profileVersion ?? 1,
    track: 'authorization',
    stage: 'hasc',
    authority: 'hasc_authorization',
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
    ],
    tableSemanticsPolicy: 'header_required',
    declaredUnits: ['dollars', 'thousands', 'millions'],
    requiredComparisonStages: [],
    enactmentProofRequirement: 'not_required',
    absenceAllowed: true,
  });
}

export function hascSourceProfileHashV1(input: CreateHascSourceProfileV1Input): string {
  return stageSourceProfileHashV1(createHascSourceProfileV1(input));
}

/** HASC permits derivation only from an exact printed request baseline + change. */
export const HASC_TABLE_COMPOSITION_POLICY_V1 = {
  allowBaselinePlusChange: true,
} as const;
