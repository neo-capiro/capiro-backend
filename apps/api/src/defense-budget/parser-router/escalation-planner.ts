/**
 * defense_budget_escalation_planner_v1 — verification-finding-to-page escalation planner.
 *
 * Maps Phase 2 verification findings to parser-correctable page-level
 * escalation steps. Only parser-correctable findings may trigger
 * parser escalation.
 */

import {
  type ParserCorrectableFindingV1,
  type DefenseBudgetParsePlanV1,
  type ParserPlanStepV1,
  buildEscalationPlan,
  isParserCorrectable,
} from './route-planner.js';
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* Phase 2 result finding shape (minimal adapter)                     */
/* ------------------------------------------------------------------ */

export interface VerificationFindingV1 {
  code: string;
  assertionIds: string[];
  evidenceIds: string[];
  sourceFactIds: string[];
  pages: number[];
  blocking: boolean;
}

export interface VerificationResultMinimalV1 {
  decision: 'PASS' | 'REVIEW' | 'REJECT';
  checks: Array<{
    code: string;
    outcome: 'PASS' | 'FAIL' | 'NOT_RUN' | 'SKIPPED';
    assertionIds: string[];
    evidenceIds: string[];
    blocking: boolean;
  }>;
  discrepancies: Array<{
    code: string;
    assertionIds: string[];
    evidenceIds: string[];
    severity: 'blocking' | 'review' | 'informational';
  }>;
}

/* ------------------------------------------------------------------ */
/* E1. Map Phase 2 findings to parser-correctable findings           */
/* ------------------------------------------------------------------ */

/**
 * Determine the recommended engine class from a finding code.
 */
function recommendEngineClass(
  code: string,
): 'table' | 'layout' | 'ocr' | 'complex' | null {
  if (code.includes('arithmetic') || code.includes('comparison')) {
    return 'table';
  }
  if (code.includes('evidence') || code.includes('proof')) {
    return 'table';
  }
  if (code.includes('missing') && code.includes('fact')) {
    return 'table';
  }
  if (code.includes('omission')) {
    return 'table';
  }
  if (code.includes('layout') || code.includes('reading_order')) {
    return 'layout';
  }
  if (code.includes('ocr') || code.includes('image')) {
    return 'ocr';
  }
  if (code.includes('complex') || code.includes('unimplemented')) {
    return 'complex';
  }
  // Default to table for parser-correctable findings
  return 'table';
}

/**
 * Filter Phase 2 findings to only parser-correctable ones and map them
 * to the parser-correctable finding contract.
 */
export function mapCorrectableFindings(
  result: VerificationResultMinimalV1,
): ParserCorrectableFindingV1[] {
  const correctable: ParserCorrectableFindingV1[] = [];

  // From failed checks
  for (const check of result.checks) {
    if (check.outcome !== 'FAIL') continue;
    if (!isParserCorrectable(check.code)) continue;

    const engineClass = recommendEngineClass(check.code);
    if (!engineClass) continue;

    // Extract pages from assertion IDs (convention: pages encoded in evidence)
    // For now, use the check's assertion/evidence IDs; pages must come from
    // the artifact's evidence records. The escalation planner will use the
    // page mapping from the artifact.
    const pages = extractPagesFromCheck(check);
    if (pages.length === 0) continue; // No page guess

    correctable.push({
      findingCode: check.code,
      assertionIds: check.assertionIds,
      sourceFactIds: [],
      evidenceIds: check.evidenceIds,
      pages,
      recommendedEngineClass: engineClass,
      blocking: check.blocking,
    });
  }

  // From discrepancies
  for (const disc of result.discrepancies) {
    if (!isParserCorrectable(disc.code)) continue;

    const engineClass = recommendEngineClass(disc.code);
    if (!engineClass) continue;

    // Discrepancies don't directly carry pages; they reference evidence
    // which references pages. For now, skip if no pages can be determined.
    // The full implementation will resolve pages via evidence IDs.
    const pages: number[] = []; // Would be resolved from evidence
    if (pages.length === 0) continue;

    correctable.push({
      findingCode: disc.code,
      assertionIds: disc.assertionIds,
      sourceFactIds: [],
      evidenceIds: disc.evidenceIds,
      pages,
      recommendedEngineClass: engineClass,
      blocking: disc.severity === 'blocking',
    });
  }

  return correctable;
}

/**
 * Extract page numbers from a check's evidence references.
 * In the full implementation, this resolves through the artifact's
 * evidence records. For now, returns empty if no pages can be determined.
 */
function extractPagesFromCheck(
  check: VerificationResultMinimalV1['checks'][number],
): number[] {
  // Page resolution would go through the artifact's evidence records
  // to find the page numbers. This is a placeholder that will be
  // connected to the actual evidence resolver in the full implementation.
  // The escalation planner requires explicit page mappings from findings.
  return [];
}

/**
 * Set page numbers on correctable findings from an evidence-to-page map.
 */
export function resolveFindingPages(
  findings: ParserCorrectableFindingV1[],
  evidenceToPages: ReadonlyMap<string, number[]>,
): ParserCorrectableFindingV1[] {
  return findings.map((finding) => {
    const pages = new Set<number>();
    for (const evidenceId of finding.evidenceIds) {
      const evPages = evidenceToPages.get(evidenceId);
      if (evPages) {
        for (const p of evPages) pages.add(p);
      }
    }
    return {
      ...finding,
      pages: [...pages].sort((a, b) => a - b),
    };
  }).filter((f) => f.pages.length > 0);
}

/* ------------------------------------------------------------------ */
/* E2. Build escalation from verification result                     */
/* ------------------------------------------------------------------ */

export function planEscalationFromVerification(input: {
  executionId: string;
  cycleId: string;
  manifestDocumentKey: string;
  sourceSha256: string;
  parserPolicy: import('../contracts/budget-cycle-manifest-v1.js').ParserPolicyV1;
  pageProfiles: import('./page-profiler.js').PageProfileV1[];
  verificationResult: VerificationResultMinimalV1;
  evidenceToPages: ReadonlyMap<string, number[]>;
  attemptedEnginesByPage: ReadonlyMap<number, readonly ExtractionMethodV1[]>;
  allowPaidParse: boolean;
  maxPaidPages: number;
  currentRound: number;
}): {
  plan: DefenseBudgetParsePlanV1;
  terminal: boolean;
  terminalReason?: string;
  correctableFindings: ParserCorrectableFindingV1[];
} {
  // Map findings
  let correctableFindings = mapCorrectableFindings(input.verificationResult);

  // Resolve pages from evidence
  correctableFindings = resolveFindingPages(correctableFindings, input.evidenceToPages);

  // Build escalation plan
  const result = buildEscalationPlan({
    executionId: input.executionId,
    cycleId: input.cycleId,
    manifestDocumentKey: input.manifestDocumentKey,
    sourceSha256: input.sourceSha256,
    parserPolicy: input.parserPolicy,
    pageProfiles: input.pageProfiles,
    correctableFindings,
    attemptedEnginesByPage: input.attemptedEnginesByPage,
    allowPaidParse: input.allowPaidParse,
    maxPaidPages: input.maxPaidPages,
    currentRound: input.currentRound,
  });

  return {
    plan: result.plan,
    terminal: result.terminal,
    terminalReason: result.terminalReason,
    correctableFindings,
  };
}