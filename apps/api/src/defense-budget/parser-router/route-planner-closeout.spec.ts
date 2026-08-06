import {
  buildEscalationPlan,
  buildInitialParsePlan,
  isParserCorrectable,
} from './route-planner.js';
import type { PageProfileV1 } from './page-profiler.js';

const sourceSha256 = 'a'.repeat(64);
function profile(overrides: Partial<PageProfileV1> = {}): PageProfileV1 {
  return {
    page: 1,
    width: '612',
    height: '792',
    rotation: 0,
    embeddedTextCharacters: 200,
    alphanumericCharacters: 100,
    wordCount: 30,
    imageCount: 0,
    imageAreaRatio: '0',
    vectorLineCount: 0,
    horizontalLineCount: 0,
    verticalLineCount: 0,
    tableLikeTextLineCount: 0,
    hasEmbeddedTextLayer: true,
    likelyImageOnly: false,
    likelyRotated: false,
    likelyTablePage: false,
    likelyMixedLayout: false,
    profileWarnings: [],
    ...overrides,
  };
}

const finding = {
  findingCode: 'missing_evidence',
  assertionIds: ['assertion-1'],
  sourceFactIds: ['fact-1'],
  evidenceIds: ['ev1_page_1_abc'],
  pages: [1],
  recommendedEngineClass: 'table' as const,
  blocking: false,
};

describe('Phase 3 route policy closeout', () => {
  it('never falls back to PDF parsing for native_structured policy', () => {
    expect(() =>
      buildInitialParsePlan({
        executionId: 'execution-1',
        cycleId: 'fy2027-pb',
        manifestDocumentKey: 'r1-native',
        sourceSha256,
        parserPolicy: 'native_structured',
        pageProfiles: [profile()],
      }),
    ).toThrow(/structured companion/);
  });

  it('prefers embedded text parsing over OCR on clean digital pages', () => {
    const plan = buildInitialParsePlan({
      executionId: 'execution-1',
      cycleId: 'fy2027-pb',
      manifestDocumentKey: 'ocr-policy-document',
      sourceSha256,
      parserPolicy: 'ocr',
      pageProfiles: [profile()],
    });
    expect(plan.steps[0]!.engine).toBe('deterministic_pdfplumber');
  });

  it('does not classify source corruption or unsupported family policy as parser-correctable', () => {
    expect(isParserCorrectable('source_sha_mismatch')).toBe(false);
    expect(isParserCorrectable('verification_policy_not_implemented')).toBe(false);
  });

  it('does not repeat an already attempted engine/page identity', () => {
    const result = buildEscalationPlan({
      executionId: 'execution-1',
      cycleId: 'fy2027-pb',
      manifestDocumentKey: 'r1-army',
      sourceSha256,
      parserPolicy: 'deterministic_table',
      pageProfiles: [profile({ likelyTablePage: true })],
      correctableFindings: [finding],
      attemptedEnginesByPage: new Map([[1, ['deterministic_pdfplumber', 'camelot']]]),
      allowPaidParse: false,
      maxPaidPages: 0,
      currentRound: 1,
    });
    expect(result.plan.steps[0]!.engine).toBe('docling');
  });

  it('distinguishes missing paid authorization from a paid page-cap violation', () => {
    const attempted = new Map([[1, ['deterministic_pdfplumber', 'camelot', 'docling'] as const]]);
    const unauthorized = buildEscalationPlan({
      executionId: 'execution-1',
      cycleId: 'fy2027-pb',
      manifestDocumentKey: 'r1-army',
      sourceSha256,
      parserPolicy: 'deterministic_table',
      pageProfiles: [profile()],
      correctableFindings: [finding],
      attemptedEnginesByPage: attempted,
      allowPaidParse: false,
      maxPaidPages: 0,
      currentRound: 1,
    });
    expect(unauthorized.terminalReason).toBe('paid_not_authorized');

    const capped = buildEscalationPlan({
      executionId: 'execution-1',
      cycleId: 'fy2027-pb',
      manifestDocumentKey: 'r1-army',
      sourceSha256,
      parserPolicy: 'deterministic_table',
      pageProfiles: [profile()],
      correctableFindings: [finding],
      attemptedEnginesByPage: attempted,
      allowPaidParse: true,
      maxPaidPages: 0,
      currentRound: 1,
    });
    expect(capped.terminalReason).toBe('paid_page_cap_exceeded');
  });
});
