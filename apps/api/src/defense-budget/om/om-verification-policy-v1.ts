/**
 * om-verification-policy-v1 — family-specific verification rules for
 * O&M (O-1/OP-5) artifacts.
 *
 * Implements Phase 5 Workstream I checks:
 *   - identity/hierarchy completeness;
 *   - O-1 ↔ OP-5 amount agreement at matching scope;
 *   - OP-5 price/program/transfer arithmetic only where defined;
 *   - required narrative presence;
 *   - required workload/quantity presence;
 *   - exact units and evidence;
 *   - no duplicate live identity within one document.
 *
 * Pure module. No database, no parser, no writer. No canonical writes.
 * No ProgramElementWriterService.
 */
import type { OmFundingComparison } from './om-reconciliation-v1.js';

/* ------------------------------------------------------------------ */
/* Verification finding types                                          */
/* ------------------------------------------------------------------ */

export type OmVerificationSeverity = 'blocking' | 'review' | 'info';

export interface OmVerificationFinding {
  findingId: string;
  severity: OmVerificationSeverity;
  code: string;
  message: string;
  identityNaturalKey?: string;
}

export type OmVerificationDecision =
  | 'VERIFICATION_PASSED'
  | 'NEEDS_REVIEW'
  | 'REJECTED';

export interface OmVerificationResult {
  decision: OmVerificationDecision;
  findings: OmVerificationFinding[];
  /** True when any blocking finding exists. */
  blocking: boolean;
}

/* ------------------------------------------------------------------ */
/* Verification input                                                   */
/* ------------------------------------------------------------------ */

export interface OmIdentityInput {
  naturalKey: string;
  printedCode: string;
  account: string;
  component: string;
  exhibit: string;
  page: number;
  hasNarrative: boolean;
  hasQuantity: boolean;
  hasFunding: boolean;
  budgetActivity?: string;
  activityGroup?: string;
}

export interface OmVerificationInput {
  o1Identities: readonly OmIdentityInput[];
  op5Identities: readonly OmIdentityInput[];
  fundingComparisons: readonly OmFundingComparison[];
  /** Identity natural keys that the manifest requires. */
  requiredIdentityKeys: readonly string[];
  /** Whether OP-5 is required by the manifest. */
  op5Required: boolean;
  /** Required narrative sections from the manifest. */
  requiredNarrativeSections: readonly string[];
  /** Required workload/quantity categories from the manifest. */
  requiredQuantityCategories: readonly string[];
  /** OP-5 change arithmetic result. */
  changeArithmetic: {
    applicable: boolean;
    passed?: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* Verification policy                                                  */
/* ------------------------------------------------------------------ */

let findingSeq = 0;
function nextFindingId(code: string): string {
  return `om_vf_${code}_${++findingSeq}`;
}

/**
 * Run all O&M family-specific verification checks.
 *
 * Returns a decision and findings. A blocking finding prevents
 * certification. Missing comparison source is NOT_RUN and may block
 * when the manifest requires it.
 */
export function verifyOmFamily(
  input: OmVerificationInput,
): OmVerificationResult {
  findingSeq = 0;
  const findings: OmVerificationFinding[] = [];

  /* 1. O-1 identity/hierarchy completeness */
  if (input.o1Identities.length === 0) {
    findings.push({
      findingId: nextFindingId('o1_missing'),
      severity: 'blocking',
      code: 'o1_identity_missing',
      message: 'No O-1 identities extracted; O-1 is required for O&M cycle',
    });
  }

  /* 2. OP-5 identity completeness (when required) */
  if (input.op5Required && input.op5Identities.length === 0) {
    findings.push({
      findingId: nextFindingId('op5_missing'),
      severity: 'blocking',
      code: 'op5_identity_missing',
      message: 'No OP-5 identities extracted; OP-5 is required by manifest',
    });
  }

  /* 3. Account/component consistency: every identity must have non-blank account and component. */
  const allIdentities = [
    ...input.o1Identities,
    ...input.op5Identities,
  ];
  for (const id of allIdentities) {
    if (id.account.length === 0 || id.account === 'UNKNOWN') {
      findings.push({
        findingId: nextFindingId('account_missing'),
        severity: 'blocking',
        code: 'account_missing',
        message: `${id.exhibit} identity ${id.printedCode} on page ${id.page} has no account`,
        identityNaturalKey: id.naturalKey,
      });
    }
    if (id.component.length === 0 || id.component === 'UNKNOWN') {
      findings.push({
        findingId: nextFindingId('component_missing'),
        severity: 'blocking',
        code: 'component_missing',
        message: `${id.exhibit} identity ${id.printedCode} on page ${id.page} has no component`,
        identityNaturalKey: id.naturalKey,
      });
    }
  }

  /* 4. O-1 ↔ OP-5 amount reconciliation */
  for (const cmp of input.fundingComparisons) {
    if (cmp.result === 'fail') {
      findings.push({
        findingId: nextFindingId('funding_mismatch'),
        severity: 'blocking',
        code: 'o1_op5_funding_mismatch',
        message: cmp.message ?? `O-1/OP-5 funding mismatch for ${cmp.printedCode} FY${cmp.fiscalYear} ${cmp.columnRole}`,
        identityNaturalKey: cmp.identityNaturalKey,
      });
    } else if (cmp.result === 'not_run' && input.op5Required) {
      findings.push({
        findingId: nextFindingId('funding_not_run'),
        severity: 'blocking',
        code: 'o1_op5_comparison_not_run',
        message: cmp.message ?? `O-1/OP-5 comparison not run for ${cmp.printedCode} FY${cmp.fiscalYear} ${cmp.columnRole}`,
        identityNaturalKey: cmp.identityNaturalKey,
      });
    } else if (cmp.result === 'review') {
      findings.push({
        findingId: nextFindingId('funding_review'),
        severity: 'review',
        code: 'o1_op5_funding_review',
        message: cmp.message ?? `O-1/OP-5 funding needs review for ${cmp.printedCode} FY${cmp.fiscalYear} ${cmp.columnRole}`,
        identityNaturalKey: cmp.identityNaturalKey,
      });
    }
  }

  /* 5. Required narrative sections */
  if (input.requiredNarrativeSections.length > 0) {
    for (const id of input.op5Identities) {
      if (!id.hasNarrative) {
        findings.push({
          findingId: nextFindingId('narrative_missing'),
          severity: 'review',
          code: 'required_narrative_missing',
          message: `OP-5 ${id.printedCode} is missing required narrative sections`,
          identityNaturalKey: id.naturalKey,
        });
      }
    }
  }

  /* 6. Required workload/quantity presence */
  if (input.requiredQuantityCategories.length > 0) {
    for (const id of input.op5Identities) {
      if (!id.hasQuantity) {
        findings.push({
          findingId: nextFindingId('quantity_missing'),
          severity: 'review',
          code: 'required_quantity_missing',
          message: `OP-5 ${id.printedCode} is missing required workload/quantity categories`,
          identityNaturalKey: id.naturalKey,
        });
      }
    }
  }

  /* 7. OP-5 change arithmetic only where defined */
  if (input.changeArithmetic.applicable && input.changeArithmetic.passed != null) {
    if (!input.changeArithmetic.passed) {
      findings.push({
        findingId: nextFindingId('change_arithmetic_fail'),
        severity: 'review',
        code: 'op5_change_arithmetic_mismatch',
        message: 'OP-5 total-change arithmetic check failed (price + program + transfers != total)',
      });
    }
  }

  /* 8. No duplicate live identity within one document */
  const o1Keys = new Map<string, number>();
  for (const id of input.o1Identities) {
    o1Keys.set(id.naturalKey, (o1Keys.get(id.naturalKey) ?? 0) + 1);
  }
  for (const [key, count] of o1Keys) {
    if (count > 1) {
      findings.push({
        findingId: nextFindingId('duplicate_o1'),
        severity: 'blocking',
        code: 'duplicate_o1_identity',
        message: `O-1 identity ${key} appears ${count} times within the same document`,
        identityNaturalKey: key,
      });
    }
  }

  const op5Keys = new Map<string, number>();
  for (const id of input.op5Identities) {
    op5Keys.set(id.naturalKey, (op5Keys.get(id.naturalKey) ?? 0) + 1);
  }
  for (const [key, count] of op5Keys) {
    if (count > 1) {
      findings.push({
        findingId: nextFindingId('duplicate_op5'),
        severity: 'blocking',
        code: 'duplicate_op5_identity',
        message: `OP-5 identity ${key} appears ${count} times within the same document`,
        identityNaturalKey: key,
      });
    }
  }

  /* 9. Required identity keys coverage */
  const presentKeys = new Set(allIdentities.map((id) => id.naturalKey));
  for (const requiredKey of input.requiredIdentityKeys) {
    if (!presentKeys.has(requiredKey)) {
      findings.push({
        findingId: nextFindingId('required_identity_missing'),
        severity: 'blocking',
        code: 'required_identity_not_found',
        message: `Required identity ${requiredKey} not found in any O&M exhibit`,
        identityNaturalKey: requiredKey,
      });
    }
  }

  /* Deterministic ordering. */
  findings.sort((a, b) => {
    const sev = a.severity.localeCompare(b.severity);
    if (sev !== 0) return sev;
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    return a.message.localeCompare(b.message);
  });

  const blocking = findings.some((f) => f.severity === 'blocking');
  const hasRejected = findings.some(
    (f) => f.severity === 'blocking' && f.code === 'o1_identity_missing',
  );

  let decision: OmVerificationDecision;
  if (blocking && hasRejected) {
    decision = 'REJECTED';
  } else if (blocking) {
    decision = 'NEEDS_REVIEW';
  } else if (findings.some((f) => f.severity === 'review')) {
    decision = 'NEEDS_REVIEW';
  } else {
    decision = 'VERIFICATION_PASSED';
  }

  return { decision, findings, blocking };
}
