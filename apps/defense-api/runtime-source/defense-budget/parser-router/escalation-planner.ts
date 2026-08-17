/** Phase 2 finding → exact page-level parser escalation adapter. */
import {
  type ParserCorrectableFindingV1,
  type DefenseBudgetParsePlanV1,
  buildEscalationPlan,
  isParserCorrectable,
} from './route-planner.js';
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';

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

function recommendEngineClass(code: string): 'table' | 'layout' | 'ocr' | 'complex' {
  if (code.includes('ocr') || code.includes('image')) return 'ocr';
  if (code.includes('layout') || code.includes('reading_order')) return 'layout';
  if (code.includes('complex') || code.includes('unimplemented')) return 'complex';
  return 'table';
}

function embeddedPage(evidenceId: string): number | null {
  const match = /^ev1_page_(\d+)_/.exec(evidenceId);
  if (!match) return null;
  const page = Number(match[1]);
  return Number.isInteger(page) && page > 0 ? page : null;
}

function pagesForEvidence(
  evidenceIds: readonly string[],
  evidenceToPages: ReadonlyMap<string, readonly number[]>,
): number[] {
  const pages = new Set<number>();
  for (const evidenceId of evidenceIds) {
    const mapped = evidenceToPages.get(evidenceId);
    if (mapped) {
      for (const page of mapped) {
        if (Number.isInteger(page) && page > 0) pages.add(page);
      }
      continue;
    }
    // Router-produced evidence IDs preserve their exact physical page as a
    // deterministic prefix. This is a fallback for minimal Phase 2 result
    // adapters; full callers should still supply the evidence map.
    const page = embeddedPage(evidenceId);
    if (page !== null) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

export function mapCorrectableFindings(
  result: VerificationResultMinimalV1,
  evidenceToPages: ReadonlyMap<string, readonly number[]> = new Map(),
): ParserCorrectableFindingV1[] {
  const output: ParserCorrectableFindingV1[] = [];

  for (const check of result.checks) {
    if (check.outcome !== 'FAIL' && check.outcome !== 'NOT_RUN') continue;
    if (!isParserCorrectable(check.code)) continue;
    const pages = pagesForEvidence(check.evidenceIds, evidenceToPages);
    if (pages.length === 0) continue;
    output.push({
      findingCode: check.code,
      assertionIds: [...check.assertionIds],
      sourceFactIds: [],
      evidenceIds: [...check.evidenceIds],
      pages,
      recommendedEngineClass: recommendEngineClass(check.code),
      blocking: check.blocking,
    });
  }

  for (const discrepancy of result.discrepancies) {
    if (!isParserCorrectable(discrepancy.code)) continue;
    const pages = pagesForEvidence(discrepancy.evidenceIds, evidenceToPages);
    if (pages.length === 0) continue;
    output.push({
      findingCode: discrepancy.code,
      assertionIds: [...discrepancy.assertionIds],
      sourceFactIds: [],
      evidenceIds: [...discrepancy.evidenceIds],
      pages,
      recommendedEngineClass: recommendEngineClass(discrepancy.code),
      blocking: discrepancy.severity === 'blocking',
    });
  }

  return output.sort(
    (left, right) =>
      left.pages[0]! - right.pages[0]! || left.findingCode.localeCompare(right.findingCode),
  );
}

export function resolveFindingPages(
  findings: ParserCorrectableFindingV1[],
  evidenceToPages: ReadonlyMap<string, readonly number[]>,
): ParserCorrectableFindingV1[] {
  return findings
    .map((finding) => ({
      ...finding,
      pages: pagesForEvidence(finding.evidenceIds, evidenceToPages),
    }))
    .filter((finding) => finding.pages.length > 0);
}

export function planEscalationFromVerification(input: {
  executionId: string;
  cycleId: string;
  manifestDocumentKey: string;
  sourceSha256: string;
  parserPolicy: import('../contracts/budget-cycle-manifest-v1.js').ParserPolicyV1;
  pageProfiles: import('./page-profiler.js').PageProfileV1[];
  verificationResult: VerificationResultMinimalV1;
  evidenceToPages: ReadonlyMap<string, readonly number[]>;
  attemptedEnginesByPage: ReadonlyMap<number, readonly ExtractionMethodV1[]>;
  allowPaidParse: boolean;
  maxPaidPages: number;
  currentRound: number;
  maxEscalationRounds?: number;
}): {
  plan: DefenseBudgetParsePlanV1;
  terminal: boolean;
  terminalReason?: string;
  correctableFindings: ParserCorrectableFindingV1[];
} {
  const correctableFindings = mapCorrectableFindings(
    input.verificationResult,
    input.evidenceToPages,
  );
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
    ...(input.maxEscalationRounds !== undefined
      ? { maxEscalationRounds: input.maxEscalationRounds }
      : {}),
  });
  return { ...result, correctableFindings };
}
