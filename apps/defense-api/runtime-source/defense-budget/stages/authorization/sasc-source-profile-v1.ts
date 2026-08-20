/** Phase 6 Workstream E — governed SASC source-profile instance. */
import {
  DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
  parseStageSourceProfileV1,
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../stage-source-profile-v1.js';

export interface CreateSascSourceProfileV1Input {
  fiscalYear: number;
  reportNumber: string;
  sourceDocumentKeys: string[];
  profileVersion?: number;
}

export function createSascSourceProfileV1(
  input: CreateSascSourceProfileV1Input,
): DefenseBudgetStageSourceProfileV1 {
  return parseStageSourceProfileV1({
    schemaVersion: DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
    profileId: `fy${input.fiscalYear}-sasc-authorization-report`,
    profileVersion: input.profileVersion ?? 1,
    track: 'authorization',
    stage: 'sasc',
    authority: 'sasc_authorization',
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
    ],
    tableSemanticsPolicy: 'header_required',
    declaredUnits: ['dollars', 'thousands', 'millions'],
    requiredComparisonStages: [],
    enactmentProofRequirement: 'not_required',
    absenceAllowed: true,
  });
}

export function sascSourceProfileHashV1(input: CreateSascSourceProfileV1Input): string {
  return stageSourceProfileHashV1(createSascSourceProfileV1(input));
}

/** SASC permits derivation only from an exact printed request baseline + change. */
export const SASC_TABLE_COMPOSITION_POLICY_V1 = {
  allowBaselinePlusChange: true,
} as const;
