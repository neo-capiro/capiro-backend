/** Phase 6 Workstream N — inspect-only annual stage-cycle operator plan. */
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';
import {
  certifyPhase6CycleV1,
  phase6CycleCertificationInputV1Schema,
  type Phase6CycleCertificationInputV1,
  type Phase6CycleCertificationV1,
} from './phase6-cycle-certification-v1.js';

export const PHASE6_OPERATOR_COMMAND_VALUES = [
  'extract_stage_document',
  'compose_authorization_cycle',
  'compose_appropriations_cycle',
  'compose_post_enactment_evidence',
  'verify_full_stage_cycle',
  'report_cycle_certification',
] as const;
export type Phase6OperatorCommandV1 = (typeof PHASE6_OPERATOR_COMMAND_VALUES)[number];

export interface Phase6OperatorPlanV1 {
  schemaVersion: 'phase6_operator_plan_v1';
  command: Phase6OperatorCommandV1;
  mode: 'inspect';
  externalCalls: false;
  paidParserCalls: false;
  canonicalWrites: false;
  auditWrites: false;
  inputContentSha256: string;
  certification?: Phase6CycleCertificationV1;
}

export function buildPhase6OperatorPlanV1(
  command: Phase6OperatorCommandV1,
  inputValue: unknown,
): Phase6OperatorPlanV1 {
  const input: Phase6CycleCertificationInputV1 = phase6CycleCertificationInputV1Schema.parse(inputValue);
  const certification =
    command === 'verify_full_stage_cycle' || command === 'report_cycle_certification'
      ? certifyPhase6CycleV1(input)
      : undefined;
  return {
    schemaVersion: 'phase6_operator_plan_v1',
    command,
    mode: 'inspect',
    externalCalls: false,
    paidParserCalls: false,
    canonicalWrites: false,
    auditWrites: false,
    inputContentSha256: sha256CanonicalJson(input as unknown as JsonValue),
    ...(certification != null ? { certification } : {}),
  };
}
