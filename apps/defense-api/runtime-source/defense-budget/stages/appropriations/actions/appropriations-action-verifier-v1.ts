/** Phase 6 Workstream J — semantic verification for typed appropriations actions. */
import {
  absDifference,
  addDecimals,
} from '../../../verification/rules/arithmetic/exact-arithmetic.js';
import {
  appropriationsLanguageFactV1Schema,
  defenseBudgetStageActionV1Schema,
  type AppropriationsLanguageFactV1,
  type DefenseBudgetStageActionV1,
} from './defense-budget-stage-action-v1.js';

export type AppropriationsActionVerificationStatusV1 = 'PASS' | 'REVIEW' | 'BLOCKED';

export interface AppropriationsActionFindingV1 {
  code: string;
  severity: 'review' | 'blocking';
  actionIds: string[];
  message: string;
}

export interface AppropriationsActionVerificationV1 {
  schemaVersion: 'appropriations_action_verification_v1';
  status: AppropriationsActionVerificationStatusV1;
  actions: DefenseBudgetStageActionV1[];
  findings: AppropriationsActionFindingV1[];
  preservedActionCount: number;
  silentlyNettedActionCount: 0;
}

function absolute(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value;
}

export function verifyAppropriationsActionsV1(input: {
  actions: readonly unknown[];
  languageFacts?: readonly unknown[];
}): AppropriationsActionVerificationV1 {
  const findings: AppropriationsActionFindingV1[] = [];
  const actions: DefenseBudgetStageActionV1[] = [];
  for (const value of input.actions) {
    const parsed = defenseBudgetStageActionV1Schema.safeParse(value);
    if (!parsed.success) {
      findings.push({
        code: 'action_schema_invalid',
        severity: 'blocking',
        actionIds: [],
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      });
      continue;
    }
    actions.push(parsed.data);
  }

  const languageFacts: AppropriationsLanguageFactV1[] = [];
  for (const value of input.languageFacts ?? []) {
    const parsed = appropriationsLanguageFactV1Schema.safeParse(value);
    if (!parsed.success) {
      findings.push({
        code: 'language_fact_invalid',
        severity: 'blocking',
        actionIds: [],
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      });
      continue;
    }
    languageFacts.push(parsed.data);
  }

  for (const action of actions) {
    if (
      action.baseline != null &&
      action.after != null &&
      action.signedValueMillions != null
    ) {
      const printedUnits = new Set([
        action.baseline.originalUnit,
        action.after.originalUnit,
        ...(action.amount != null ? [action.amount.originalUnit] : []),
      ]);
      if (printedUnits.size !== 1) {
        findings.push({
          code: 'baseline_change_after_unit_mismatch',
          severity: 'blocking',
          actionIds: [action.actionId],
          message: 'baseline, change, and after values must use one explicit printed unit',
        });
      } else {
        const expected = addDecimals(action.baseline.valueMillions, action.signedValueMillions);
        if (expected !== action.after.valueMillions) {
          findings.push({
            code: 'baseline_change_after_mismatch',
            severity: 'blocking',
            actionIds: [action.actionId],
            message:
              `baseline(${action.baseline.valueMillions}) + change(${action.signedValueMillions}) ` +
              `= ${expected}, after=${action.after.valueMillions}, diff=${absDifference(
                expected,
                action.after.valueMillions,
              )}`,
          });
        }
      }
    }

    const linkedLanguage = languageFacts.filter((fact) => fact.actionIds.includes(action.actionId));
    if (action.languageEvidenceIds.length > 0 || linkedLanguage.length > 0) {
      const actionEvidence = new Set(action.evidenceIds);
      const linkedEvidence = new Set(linkedLanguage.flatMap((fact) => fact.evidenceIds));
      const sharedEvidence = [...actionEvidence].filter((evidenceId) => linkedEvidence.has(evidenceId));
      const declaredValid = action.languageEvidenceIds.every(
        (evidenceId) => actionEvidence.has(evidenceId) && linkedEvidence.has(evidenceId),
      );
      if (linkedLanguage.length === 0 || sharedEvidence.length === 0 || !declaredValid) {
        findings.push({
          code: 'language_action_evidence_not_shared',
          severity: 'blocking',
          actionIds: [action.actionId],
          message: 'report language and action row do not share the same source evidence',
        });
      }
    }
  }

  const transfers = actions.filter((action) =>
    ['transfer_in', 'transfer_out'].includes(action.actionType),
  );
  for (const action of transfers) {
    if (
      action.transferGroupId == null ||
      action.sourceIdentity == null ||
      action.destinationIdentity == null
    ) {
      findings.push({
        code: 'transfer_endpoint_missing',
        severity: 'blocking',
        actionIds: [action.actionId],
        message:
          'explicit transfer requires transferGroupId plus source and destination identities',
      });
    }
  }

  const groups = new Map<string, DefenseBudgetStageActionV1[]>();
  for (const action of transfers) {
    if (action.transferGroupId == null) continue;
    const values = groups.get(action.transferGroupId) ?? [];
    values.push(action);
    groups.set(action.transferGroupId, values);
  }
  for (const [groupId, group] of groups) {
    const incoming = group.filter((action) => action.actionType === 'transfer_in');
    const outgoing = group.filter((action) => action.actionType === 'transfer_out');
    if (incoming.length !== 1 || outgoing.length !== 1) {
      findings.push({
        code: 'transfer_pair_incomplete',
        severity: 'blocking',
        actionIds: group.map((action) => action.actionId),
        message: `transfer group ${groupId} must contain exactly one transfer_in and one transfer_out`,
      });
      continue;
    }
    const inValue = incoming[0]!.signedValueMillions;
    const outValue = outgoing[0]!.signedValueMillions;
    if (inValue == null || outValue == null || absolute(inValue) !== absolute(outValue)) {
      findings.push({
        code: 'transfer_pair_amount_mismatch',
        severity: 'blocking',
        actionIds: group.map((action) => action.actionId),
        message: `transfer group ${groupId} does not preserve the same explicit amount in both directions`,
      });
    }
  }

  const status: AppropriationsActionVerificationStatusV1 = findings.some(
    (finding) => finding.severity === 'blocking',
  )
    ? 'BLOCKED'
    : findings.length > 0
      ? 'REVIEW'
      : 'PASS';
  return {
    schemaVersion: 'appropriations_action_verification_v1',
    status,
    actions: [...actions].sort((left, right) => left.actionId.localeCompare(right.actionId)),
    findings,
    preservedActionCount: actions.length,
    silentlyNettedActionCount: 0,
  };
}
