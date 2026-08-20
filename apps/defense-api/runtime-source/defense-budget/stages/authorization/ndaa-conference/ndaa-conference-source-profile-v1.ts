/** Phase 6 Workstream G — governed NDAA conference source profile. */
import {
  DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
  parseStageSourceProfileV1,
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../../stage-source-profile-v1.js';

export interface CreateNdaaConferenceSourceProfileV1Input {
  fiscalYear: number;
  billId: string;
  reportNumber: string;
  conferenceReportDocumentKey: string;
  jointExplanatoryStatementDocumentKey?: string;
  profileVersion?: number;
}

export function createNdaaConferenceSourceProfileV1(
  input: CreateNdaaConferenceSourceProfileV1Input,
): DefenseBudgetStageSourceProfileV1 {
  return parseStageSourceProfileV1({
    schemaVersion: DEFENSE_BUDGET_STAGE_SOURCE_PROFILE_SCHEMA_VERSION,
    profileId: `fy${input.fiscalYear}-ndaa-conference-authorization`,
    profileVersion: input.profileVersion ?? 1,
    track: 'authorization',
    stage: 'ndaa_conference',
    authority: 'ndaa_conference_authorization',
    fiscalYear: input.fiscalYear,
    vehicleClass: 'conference_report',
    chamber: 'joint',
    billId: input.billId,
    reportNumber: input.reportNumber,
    sourceDocumentKeys: [input.conferenceReportDocumentKey],
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
    ],
    tableSemanticsPolicy: 'header_required',
    declaredUnits: ['dollars', 'thousands', 'millions'],
    requiredComparisonStages: ['hasc', 'sasc'],
    enactmentProofRequirement: 'not_required',
    absenceAllowed: true,
  });
}

export function ndaaConferenceSourceProfileHashV1(
  input: CreateNdaaConferenceSourceProfileV1Input,
): string {
  return stageSourceProfileHashV1(createNdaaConferenceSourceProfileV1(input));
}
