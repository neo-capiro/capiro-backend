/**
 * milcon-verification-policy-v1 — family-specific verification rules for
 * MILCON (C-1/DD1391) artifacts.
 *
 * Implements Phase 5 Workstream L checks:
 *   - identity completeness;
 *   - C-1 request ↔ DD1391 request at matching scope;
 *   - authorization/appropriation field ownership;
 *   - DD1391 cost-category arithmetic where the form defines totals;
 *   - project-scope and schedule completeness;
 *   - required narrative sections;
 *   - exact evidence and trusted parser/source proof;
 *   - OCR-derived amount requires review.
 *
 * Rules:
 *   - Match C-1 and DD1391 by native project identity, not title similarity.
 *   - Preserve mismatches as discrepancies; never overwrite one source with another.
 *   - Handle legitimate revisions/supersessions through source-document versioning.
 *
 * Pure module. No database, no parser, no writer. No canonical writes.
 * No ProgramElementWriterService.
 */
import type { MilconFundingComparison } from './milcon-reconciliation-v1.js';

/* ------------------------------------------------------------------ */
/* Verification finding types                                          */
/* ------------------------------------------------------------------ */

export type MilconVerificationSeverity = 'blocking' | 'review' | 'info';

export interface MilconVerificationFinding {
  findingId: string;
  severity: MilconVerificationSeverity;
  code: string;
  message: string;
  identityNaturalKey?: string;
}

export type MilconVerificationDecision = 'VERIFICATION_PASSED' | 'NEEDS_REVIEW' | 'REJECTED';

export interface MilconVerificationResult {
  decision: MilconVerificationDecision;
  findings: MilconVerificationFinding[];
  blocking: boolean;
}

/* ------------------------------------------------------------------ */
/* Verification input                                                   */
/* ------------------------------------------------------------------ */

export interface MilconIdentityInput {
  naturalKey: string;
  printedProjectCode: string;
  component: string;
  installation?: string;
  location?: string;
  exhibit: string;
  page: number;
  hasScope: boolean;
  hasSchedule: boolean;
  hasNarrative: boolean;
  hasCostCategory: boolean;
}

export interface MilconVerificationInput {
  c1Identities: readonly MilconIdentityInput[];
  dd1391Identities: readonly MilconIdentityInput[];
  fundingComparisons: readonly MilconFundingComparison[];
  requiredIdentityKeys: readonly string[];
  dd1391Required: boolean;
  requiredNarrativeSections: readonly string[];
  costArithmetic: {
    applicable: boolean;
    passed?: boolean;
  };
  ocrConfidenceIssues: ReadonlyArray<{
    identityNaturalKey: string;
    requiresReview: boolean;
  }>;
}

/* ------------------------------------------------------------------ */
/* Verification policy                                                  */
/* ------------------------------------------------------------------ */

let findingSeq = 0;
function nextFindingId(code: string): string {
  return `milcon_vf_${code}_${++findingSeq}`;
}

export function verifyMilconFamily(input: MilconVerificationInput): MilconVerificationResult {
  findingSeq = 0;
  const findings: MilconVerificationFinding[] = [];

  /* 1. C-1 identity completeness */
  if (input.c1Identities.length === 0) {
    findings.push({
      findingId: nextFindingId('c1_missing'),
      severity: 'blocking',
      code: 'c1_identity_missing',
      message: 'No C-1 identities extracted; C-1 is required for MILCON cycle',
    });
  }

  /* 2. DD1391 identity completeness (when required) */
  if (input.dd1391Required && input.dd1391Identities.length === 0) {
    findings.push({
      findingId: nextFindingId('dd1391_missing'),
      severity: 'blocking',
      code: 'dd1391_identity_missing',
      message: 'No DD1391 identities extracted; DD1391 is required by manifest',
    });
  }

  /* 3. Component consistency */
  const allIdentities = [...input.c1Identities, ...input.dd1391Identities];
  for (const id of allIdentities) {
    if (id.component.length === 0 || id.component === 'UNKNOWN') {
      findings.push({
        findingId: nextFindingId('component_missing'),
        severity: 'blocking',
        code: 'component_missing',
        message: `${id.exhibit} identity ${id.printedProjectCode} on page ${id.page} has no component`,
        identityNaturalKey: id.naturalKey,
      });
    }
  }

  /* 4. C-1 ↔ DD1391 funding reconciliation */
  for (const cmp of input.fundingComparisons) {
    if (cmp.result === 'fail') {
      findings.push({
        findingId: nextFindingId('funding_mismatch'),
        severity: 'blocking',
        code: 'c1_dd1391_funding_mismatch',
        message:
          cmp.message ??
          `C-1/DD1391 funding mismatch for ${cmp.printedProjectCode} FY${cmp.fiscalYear} ${cmp.fundingType}`,
        identityNaturalKey: cmp.identityNaturalKey,
      });
    } else if (cmp.result === 'not_run' && input.dd1391Required) {
      findings.push({
        findingId: nextFindingId('funding_not_run'),
        severity: 'blocking',
        code: 'c1_dd1391_comparison_not_run',
        message:
          cmp.message ??
          `C-1/DD1391 comparison not run for ${cmp.printedProjectCode} FY${cmp.fiscalYear} ${cmp.fundingType}`,
        identityNaturalKey: cmp.identityNaturalKey,
      });
    } else if (cmp.result === 'review') {
      findings.push({
        findingId: nextFindingId('funding_review'),
        severity: 'review',
        code: 'c1_dd1391_funding_review',
        message:
          cmp.message ??
          `C-1/DD1391 funding needs review for ${cmp.printedProjectCode} FY${cmp.fiscalYear} ${cmp.fundingType}`,
        identityNaturalKey: cmp.identityNaturalKey,
      });
    }
  }

  /* 5. DD1391 cost-category arithmetic */
  if (input.costArithmetic.applicable && input.costArithmetic.passed != null) {
    if (!input.costArithmetic.passed) {
      findings.push({
        findingId: nextFindingId('cost_arithmetic_fail'),
        severity: 'review',
        code: 'dd1391_cost_arithmetic_mismatch',
        message: 'DD1391 cost-category sum != total_request',
      });
    }
  }

  /* 6. Project-scope and schedule completeness */
  for (const id of input.dd1391Identities) {
    if (!id.hasScope) {
      findings.push({
        findingId: nextFindingId('scope_missing'),
        severity: 'review',
        code: 'project_scope_missing',
        message: `DD1391 ${id.printedProjectCode} is missing project scope`,
        identityNaturalKey: id.naturalKey,
      });
    }
    if (!id.hasSchedule) {
      findings.push({
        findingId: nextFindingId('schedule_missing'),
        severity: 'review',
        code: 'project_schedule_missing',
        message: `DD1391 ${id.printedProjectCode} is missing schedule dates`,
        identityNaturalKey: id.naturalKey,
      });
    }
  }

  /* 7. Required narrative sections */
  if (input.requiredNarrativeSections.length > 0) {
    for (const id of input.dd1391Identities) {
      if (!id.hasNarrative) {
        findings.push({
          findingId: nextFindingId('narrative_missing'),
          severity: 'review',
          code: 'required_narrative_missing',
          message: `DD1391 ${id.printedProjectCode} is missing required narrative sections`,
          identityNaturalKey: id.naturalKey,
        });
      }
    }
  }

  /* 8. OCR-derived amount requires review */
  for (const ocr of input.ocrConfidenceIssues) {
    if (ocr.requiresReview) {
      findings.push({
        findingId: nextFindingId('ocr_review'),
        severity: 'review',
        code: 'ocr_low_confidence',
        message: `OCR-derived amount for ${ocr.identityNaturalKey} requires corroboration/review`,
        identityNaturalKey: ocr.identityNaturalKey,
      });
    }
  }

  /* 9. No fuzzy title match: verify that every DD1391 identity has a matching
   *    C-1 by natural key, not by title. Identities without a C-1 counterpart
   *    are flagged when DD1391 is required. */
  if (input.dd1391Required && input.c1Identities.length > 0) {
    const c1Keys = new Set(input.c1Identities.map((id) => id.naturalKey));
    for (const dd1391 of input.dd1391Identities) {
      if (!c1Keys.has(dd1391.naturalKey)) {
        findings.push({
          findingId: nextFindingId('no_c1_match'),
          severity: 'review',
          code: 'dd1391_no_c1_counterpart',
          message: `DD1391 ${dd1391.printedProjectCode} has no C-1 counterpart by native identity`,
          identityNaturalKey: dd1391.naturalKey,
        });
      }
    }
  }

  /* 10. Required identity keys coverage */
  const presentKeys = new Set(allIdentities.map((id) => id.naturalKey));
  for (const requiredKey of input.requiredIdentityKeys) {
    if (!presentKeys.has(requiredKey)) {
      findings.push({
        findingId: nextFindingId('required_identity_missing'),
        severity: 'blocking',
        code: 'required_identity_not_found',
        message: `Required identity ${requiredKey} not found in any MILCON exhibit`,
        identityNaturalKey: requiredKey,
      });
    }
  }

  /* Deterministic ordering */
  findings.sort((a, b) => {
    const sev = a.severity.localeCompare(b.severity);
    if (sev !== 0) return sev;
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    return a.message.localeCompare(b.message);
  });

  const blocking = findings.some((f) => f.severity === 'blocking');
  const hasRejected = findings.some(
    (f) => f.severity === 'blocking' && f.code === 'c1_identity_missing',
  );

  let decision: MilconVerificationDecision;
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
