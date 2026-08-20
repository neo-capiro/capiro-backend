/** Phase 6 Workstream K — governed appropriations conference source profile. */
import { z } from 'zod';
import {
  DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
  parseStageSourceProfileV1,
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../../stage-source-profile-v1.js';

export const APPROPRIATIONS_CONFERENCE_STRUCTURE_VALUES = ['standalone', 'minibus', 'omnibus'] as const;
export const appropriationsConferenceStructureV1Schema = z.enum(APPROPRIATIONS_CONFERENCE_STRUCTURE_VALUES);
export type AppropriationsConferenceStructureV1 = z.infer<typeof appropriationsConferenceStructureV1Schema>;

export interface CreateAppropriationsConferenceSourceProfileV1Input {
  fiscalYear: number;
  billId: string;
  reportNumber?: string;
  primaryDocumentKey: string;
  jointExplanatoryStatementDocumentKey?: string;
  vehicleStructure: AppropriationsConferenceStructureV1;
  division?: string;
  title?: string;
  profileVersion?: number;
}

export interface AppropriationsConferenceSourceProfileV1 {
  stageProfile: DefenseBudgetStageSourceProfileV1;
  vehicleStructure: AppropriationsConferenceStructureV1;
  division?: string;
  title?: string;
}

export function createAppropriationsConferenceSourceProfileV1(
  input: CreateAppropriationsConferenceSourceProfileV1Input,
): AppropriationsConferenceSourceProfileV1 {
  const stageProfile = parseStageSourceProfileV1({
    schemaVersion: DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
    profileId: `fy${input.fiscalYear}-defense-appropriations-conference`,
    profileVersion: input.profileVersion ?? 1,
    track: 'appropriations',
    stage: 'appropriations_conference',
    authority: 'appropriations_conference',
    fiscalYear: input.fiscalYear,
    vehicleClass: 'conference_report',
    chamber: 'joint',
    billId: input.billId,
    ...(input.reportNumber != null ? { reportNumber: input.reportNumber } : {}),
    sourceDocumentKeys: [input.primaryDocumentKey],
    companionDocuments:
      input.jointExplanatoryStatementDocumentKey == null
        ? []
        : [
            {
              companionKind: 'joint_explanatory_statement',
              manifestDocumentKey: input.jointExplanatoryStatementDocumentKey,
              required: true,
            },
          ],
    requiredLineFamilies: [
      'rdte_pe',
      'procurement_blin',
      'om_sag',
      'milcon_project',
      'general_provisions',
      'classified',
    ],
    tableSemanticsPolicy: 'totals_only',
    declaredUnits: ['dollars', 'thousands', 'millions'],
    requiredComparisonStages: ['hac_d', 'sac_d'],
    enactmentProofRequirement: 'not_required',
    absenceAllowed: true,
  });
  return {
    stageProfile,
    vehicleStructure: input.vehicleStructure,
    ...(input.division != null ? { division: input.division } : {}),
    ...(input.title != null ? { title: input.title } : {}),
  };
}

export function appropriationsConferenceProfileHashV1(
  profile: AppropriationsConferenceSourceProfileV1,
): string {
  return stageSourceProfileHashV1(profile.stageProfile);
}
