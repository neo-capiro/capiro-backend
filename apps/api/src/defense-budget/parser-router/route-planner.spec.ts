import { describe, it, expect } from '@jest/globals';
import {
  defenseBudgetParsePlanV1Schema,
  parserPlanStepV1Schema,
  parserCorrectableFindingV1Schema,
  buildInitialParsePlan,
  buildEscalationPlan,
  isParserCorrectable,
  PARSER_CORRECTABLE_FINDING_CODES,
  NON_PARSER_CORRECTABLE_FINDING_CODES,
  DEFAULT_MAX_ESCALATION_ROUNDS,
  parseDefenseBudgetParsePlanV1,
} from './route-planner.js';
import type { PageProfileV1 } from './page-profiler.js';
import type { ParserCorrectableFindingV1 } from './route-planner.js';
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';

function makeProfile(overrides: Partial<PageProfileV1>): PageProfileV1 {
  return {
    page: 1,
    width: '612',
    height: '792',
    rotation: 0,
    embeddedTextCharacters: 500,
    alphanumericCharacters: 300,
    wordCount: 80,
    imageCount: 0,
    imageAreaRatio: '0',
    vectorLineCount: 10,
    horizontalLineCount: 5,
    verticalLineCount: 5,
    tableLikeTextLineCount: 4,
    hasEmbeddedTextLayer: true,
    likelyImageOnly: false,
    likelyRotated: false,
    likelyTablePage: true,
    likelyMixedLayout: false,
    profileWarnings: [],
    ...overrides,
  };
}

describe('route-planner', () => {
  /* C1: Parse plan contract */
  describe('parse plan contract', () => {
    it('accepts a valid step', () => {
      const step = {
        stepId: 'step-0',
        ordinal: 0,
        engine: 'deterministic_pdfplumber',
        pages: [1, 2, 3],
        reasonCodes: ['initial_plan'],
        dependsOnStepIds: [],
        paid: false,
        terminalIfSuccessful: false,
      };
      expect(parserPlanStepV1Schema.parse(step).engine).toBe('deterministic_pdfplumber');
    });

    it('rejects unknown fields in step', () => {
      const bad = {
        stepId: 'step-0',
        ordinal: 0,
        engine: 'deterministic_pdfplumber',
        pages: [1],
        reasonCodes: ['initial_plan'],
        dependsOnStepIds: [],
        paid: false,
        terminalIfSuccessful: false,
        extra: 'bad',
      };
      expect(() => parserPlanStepV1Schema.parse(bad)).toThrow();
    });
  });

  /* C2: Initial plan builder */
  describe('initial plan builder', () => {
    it('builds a plan with deterministic steps for deterministic_table policy', () => {
      const plan = buildInitialParsePlan({
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r1-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'deterministic_table',
        pageProfiles: [
          makeProfile({ page: 1, likelyTablePage: true }),
          makeProfile({ page: 2, likelyTablePage: true }),
          makeProfile({ page: 3, likelyImageOnly: true, hasEmbeddedTextLayer: false }),
        ],
      });

      expect(plan.schemaVersion).toBe('defense_budget_parse_plan_v1');
      expect(plan.steps.length).toBe(2); // pdfplumber + paddleocr
      expect(plan.paidAuthorizationRequired).toBe(false);
      expect(plan.plannedPaidPages).toEqual([]);
      expect(plan.planSha256).toHaveLength(64);
    });

    it('produces deterministic plan for same inputs', () => {
      const input = {
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r1-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'deterministic_table' as const,
        pageProfiles: [makeProfile({ page: 1 })],
      };
      const plan1 = buildInitialParsePlan(input);
      const plan2 = buildInitialParsePlan(input);
      expect(plan1.planSha256).toBe(plan2.planSha256);
    });

    it('different policy produces different plan', () => {
      const baseInput = {
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r1-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        pageProfiles: [makeProfile({ page: 1, likelyMixedLayout: true })],
      };
      const plan1 = buildInitialParsePlan({ ...baseInput, parserPolicy: 'deterministic_table' });
      const plan2 = buildInitialParsePlan({ ...baseInput, parserPolicy: 'mixed_layout' });
      expect(plan1.planSha256).not.toBe(plan2.planSha256);
    });

    it('mixed_layout policy starts with docling', () => {
      const plan = buildInitialParsePlan({
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r2-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'mixed_layout',
        pageProfiles: [makeProfile({ page: 1, likelyMixedLayout: true })],
      });
      expect(plan.steps[0]!.engine).toBe('docling');
    });

    it('ocr policy starts with paddleocr for image-only pages', () => {
      const plan = buildInitialParsePlan({
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'scan-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'ocr',
        pageProfiles: [
          makeProfile({ page: 1, likelyImageOnly: true, hasEmbeddedTextLayer: false }),
        ],
      });
      expect(plan.steps[0]!.engine).toBe('paddleocr');
    });
  });

  /* C3: Escalation plan builder */
  describe('escalation plan builder', () => {
    it('returns terminal when no correctable findings', () => {
      const result = buildEscalationPlan({
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r1-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'deterministic_table',
        pageProfiles: [makeProfile({ page: 1 })],
        correctableFindings: [],
        attemptedEnginesByPage: new Map([[1, ['deterministic_pdfplumber']]]),
        allowPaidParse: false,
        maxPaidPages: 0,
        currentRound: 0,
      });
      expect(result.terminal).toBe(true);
      expect(result.terminalReason).toBe('no_correctable_findings');
    });

    it('returns terminal when max rounds reached', () => {
      const finding: ParserCorrectableFindingV1 = {
        findingCode: 'missing_evidence',
        assertionIds: ['a1'],
        sourceFactIds: ['f1'],
        evidenceIds: ['e1'],
        pages: [1],
        recommendedEngineClass: 'table',
        blocking: true,
      };
      const result = buildEscalationPlan({
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r1-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'deterministic_table',
        pageProfiles: [makeProfile({ page: 1 })],
        correctableFindings: [finding],
        attemptedEnginesByPage: new Map([[1, ['deterministic_pdfplumber', 'camelot', 'docling']]]),
        allowPaidParse: true,
        maxPaidPages: 5,
        currentRound: DEFAULT_MAX_ESCALATION_ROUNDS,
      });
      expect(result.terminal).toBe(true);
      expect(result.terminalReason).toBe('max_escalation_rounds_reached');
    });

    it('escalates from pdfplumber to camelot for table finding', () => {
      const finding: ParserCorrectableFindingV1 = {
        findingCode: 'missing_evidence',
        assertionIds: ['a1'],
        sourceFactIds: ['f1'],
        evidenceIds: ['e1'],
        pages: [1],
        recommendedEngineClass: 'table',
        blocking: true,
      };
      const result = buildEscalationPlan({
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r1-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'deterministic_table',
        pageProfiles: [makeProfile({ page: 1 })],
        correctableFindings: [finding],
        attemptedEnginesByPage: new Map([[1, ['deterministic_pdfplumber']]]),
        allowPaidParse: false,
        maxPaidPages: 0,
        currentRound: 0,
      });
      expect(result.terminal).toBe(false);
      expect(result.plan.steps).toHaveLength(1);
      expect(result.plan.steps[0]!.engine).toBe('camelot');
      expect(result.plan.steps[0]!.paid).toBe(false);
    });

    it('escalates to paid llamaparse when authorized', () => {
      const finding: ParserCorrectableFindingV1 = {
        findingCode: 'missing_evidence',
        assertionIds: ['a1'],
        sourceFactIds: ['f1'],
        evidenceIds: ['e1'],
        pages: [2],
        recommendedEngineClass: 'table',
        blocking: true,
      };
      const result = buildEscalationPlan({
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r1-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'deterministic_table',
        pageProfiles: [makeProfile({ page: 2 })],
        correctableFindings: [finding],
        attemptedEnginesByPage: new Map([[2, ['deterministic_pdfplumber', 'camelot', 'docling']]]),
        allowPaidParse: true,
        maxPaidPages: 5,
        currentRound: 0,
      });
      expect(result.terminal).toBe(false);
      expect(result.plan.paidAuthorizationRequired).toBe(true);
      expect(result.plan.plannedPaidPages).toEqual([2]);
    });

    it('returns terminal when paid needed but not authorized', () => {
      const finding: ParserCorrectableFindingV1 = {
        findingCode: 'missing_evidence',
        assertionIds: ['a1'],
        sourceFactIds: ['f1'],
        evidenceIds: ['e1'],
        pages: [2],
        recommendedEngineClass: 'table',
        blocking: true,
      };
      const result = buildEscalationPlan({
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r1-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'deterministic_table',
        pageProfiles: [makeProfile({ page: 2 })],
        correctableFindings: [finding],
        attemptedEnginesByPage: new Map([[2, ['deterministic_pdfplumber', 'camelot', 'docling']]]),
        allowPaidParse: false,
        maxPaidPages: 0,
        currentRound: 0,
      });
      expect(result.terminal).toBe(true);
      expect(result.terminalReason).toBe('paid_not_authorized');
    });

    it('returns terminal when paid exceeds cap', () => {
      const finding: ParserCorrectableFindingV1 = {
        findingCode: 'missing_evidence',
        assertionIds: ['a1'],
        sourceFactIds: ['f1'],
        evidenceIds: ['e1'],
        pages: [2, 3, 4],
        recommendedEngineClass: 'table',
        blocking: true,
      };
      const result = buildEscalationPlan({
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r1-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'deterministic_table',
        pageProfiles: [
          makeProfile({ page: 2 }),
          makeProfile({ page: 3 }),
          makeProfile({ page: 4 }),
        ],
        correctableFindings: [finding],
        attemptedEnginesByPage: new Map([
          [2, ['deterministic_pdfplumber', 'camelot', 'docling']],
          [3, ['deterministic_pdfplumber', 'camelot', 'docling']],
          [4, ['deterministic_pdfplumber', 'camelot', 'docling']],
        ]),
        allowPaidParse: true,
        maxPaidPages: 2, // Only 2 pages authorized but 3 needed
        currentRound: 0,
      });
      expect(result.terminal).toBe(true);
      expect(result.terminalReason).toBe('paid_not_authorized');
    });

    it('never repeats the same engine for a page', () => {
      const finding: ParserCorrectableFindingV1 = {
        findingCode: 'missing_evidence',
        assertionIds: ['a1'],
        sourceFactIds: ['f1'],
        evidenceIds: ['e1'],
        pages: [1],
        recommendedEngineClass: 'table',
        blocking: true,
      };
      const result = buildEscalationPlan({
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r1-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'deterministic_table',
        pageProfiles: [makeProfile({ page: 1 })],
        correctableFindings: [finding],
        attemptedEnginesByPage: new Map([[1, ['deterministic_pdfplumber', 'camelot', 'docling']]]),
        allowPaidParse: true,
        maxPaidPages: 5,
        currentRound: 0,
      });
      // All local engines tried, next is llamaparse
      expect(result.plan.plannedPaidPages).toEqual([1]);
    });
  });

  /* C4: Finding code classification */
  describe('finding code classification', () => {
    it('classifies parser-correctable codes', () => {
      expect(isParserCorrectable('missing_evidence')).toBe(true);
      expect(isParserCorrectable('blocking_omission')).toBe(true);
      expect(isParserCorrectable('arithmetic_reconciliation_failed')).toBe(true);
    });

    it('rejects non-parser-correctable codes', () => {
      expect(isParserCorrectable('source_sha_mismatch')).toBe(false);
      expect(isParserCorrectable('field_ownership_violation')).toBe(false);
      expect(isParserCorrectable('review_only_policy')).toBe(false);
    });

    it('PARSER_CORRECTABLE_FINDING_CODES has expected entries', () => {
      expect(PARSER_CORRECTABLE_FINDING_CODES.has('missing_required_source_fact')).toBe(true);
      expect(PARSER_CORRECTABLE_FINDING_CODES.has('parser_run_proof_missing')).toBe(true);
    });

    it('NON_PARSER_CORRECTABLE_FINDING_CODES has expected entries', () => {
      expect(NON_PARSER_CORRECTABLE_FINDING_CODES.has('source_sha_mismatch')).toBe(true);
      expect(NON_PARSER_CORRECTABLE_FINDING_CODES.has('duplicate_conflicting_assertion')).toBe(
        true,
      );
    });
  });

  /* C5: Determinism */
  describe('determinism', () => {
    it('same escalation inputs produce same plan', () => {
      const finding: ParserCorrectableFindingV1 = {
        findingCode: 'missing_evidence',
        assertionIds: ['a1'],
        sourceFactIds: ['f1'],
        evidenceIds: ['e1'],
        pages: [1],
        recommendedEngineClass: 'table',
        blocking: true,
      };
      const input = {
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r1-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'deterministic_table' as const,
        pageProfiles: [makeProfile({ page: 1 })],
        correctableFindings: [finding],
        attemptedEnginesByPage: new Map<number, readonly ExtractionMethodV1[]>([
          [1, ['deterministic_pdfplumber'] as const],
        ]),
        allowPaidParse: false,
        maxPaidPages: 0,
        currentRound: 0,
      };
      const r1 = buildEscalationPlan(input);
      const r2 = buildEscalationPlan(input);
      expect(r1.plan.planSha256).toBe(r2.plan.planSha256);
    });
  });
});
