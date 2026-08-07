/** Phase 6 Workstream J — verified candidate-only downstream action projections. */
import { sha256CanonicalJson, type JsonValue } from '../../../contracts/canonical-json.js';
import type { DefenseBudgetStageActionV1 } from './defense-budget-stage-action-v1.js';
import type { AppropriationsActionVerificationV1 } from './appropriations-action-verifier-v1.js';

export interface StageActionProjectionCandidateV1 {
  projectionId: string;
  projectionStatus: 'candidate';
  action: DefenseBudgetStageActionV1;
  canonicalWriteAllowed: false;
  budgetActionWriteAllowed: false;
}

export interface StageActionProjectionPlanV1 {
  schemaVersion: 'stage_action_projection_plan_v1';
  writeMode: 'projection_only';
  canonicalWriteAllowed: false;
  budgetActionWriteAllowed: false;
  verificationStatus: 'PASS';
  candidates: StageActionProjectionCandidateV1[];
}

export function buildVerifiedStageActionProjectionPlanV1(
  verification: AppropriationsActionVerificationV1,
): StageActionProjectionPlanV1 {
  if (verification.status !== 'PASS') {
    throw new Error(`stage actions are not projection-eligible: ${verification.status}`);
  }
  return {
    schemaVersion: 'stage_action_projection_plan_v1',
    writeMode: 'projection_only',
    canonicalWriteAllowed: false,
    budgetActionWriteAllowed: false,
    verificationStatus: 'PASS',
    candidates: verification.actions.map((action) => ({
      projectionId: `stage_action_proj_${sha256CanonicalJson(action as unknown as JsonValue)}`,
      projectionStatus: 'candidate',
      action,
      canonicalWriteAllowed: false,
      budgetActionWriteAllowed: false,
    })),
  };
}
