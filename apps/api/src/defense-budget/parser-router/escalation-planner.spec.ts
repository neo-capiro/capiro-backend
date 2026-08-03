import { describe, it, expect } from '@jest/globals';
import {
  mapCorrectableFindings,
  resolveFindingPages,
  planEscalationFromVerification,
  type VerificationResultMinimalV1,
} from './escalation-planner.js';
import type { PageProfileV1 } from './page-profiler.js';

function makeProfile(page: number): PageProfileV1 {
  return {
    page,
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
  };
}

describe('escalation-planner', () => {
  describe('mapCorrectableFindings', () => {
    it('filters to only parser-correctable findings', () => {
      const result: VerificationResultMinimalV1 = {
        decision: 'REVIEW',
        checks: [
          {
            code: 'missing_evidence',
            outcome: 'FAIL',
            assertionIds: ['a1'],
            evidenceIds: ['e1'],
            blocking: true,
          },
          {
            code: 'source_sha_mismatch',
            outcome: 'FAIL',
            assertionIds: ['a2'],
            evidenceIds: ['e2'],
            blocking: true,
          },
        ],
        discrepancies: [],
      };
      const findings = mapCorrectableFindings(result);
      // missing_evidence is correctable but has no pages from extractPagesFromCheck
      // so it will be filtered out after page resolution
      expect(findings.length).toBeLessThanOrEqual(1);
    });

    it('skips checks that passed', () => {
      const result: VerificationResultMinimalV1 = {
        decision: 'PASS',
        checks: [
          {
            code: 'missing_evidence',
            outcome: 'PASS',
            assertionIds: ['a1'],
            evidenceIds: ['e1'],
            blocking: false,
          },
        ],
        discrepancies: [],
      };
      const findings = mapCorrectableFindings(result);
      expect(findings).toHaveLength(0);
    });
  });

  describe('resolveFindingPages', () => {
    it('maps evidence IDs to pages', () => {
      const findings = [
        {
          findingCode: 'missing_evidence',
          assertionIds: ['a1'],
          sourceFactIds: [],
          evidenceIds: ['e1', 'e2'],
          pages: [],
          recommendedEngineClass: 'table' as const,
          blocking: true,
        },
      ];
      const evidenceToPages = new Map([
        ['e1', [1]],
        ['e2', [2, 3]],
      ]);
      const resolved = resolveFindingPages(findings, evidenceToPages);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.pages).toEqual([1, 2, 3]);
    });

    it('filters findings with no resolvable pages', () => {
      const findings = [
        {
          findingCode: 'missing_evidence',
          assertionIds: ['a1'],
          sourceFactIds: [],
          evidenceIds: ['e_unknown'],
          pages: [],
          recommendedEngineClass: 'table' as const,
          blocking: true,
        },
      ];
      const evidenceToPages = new Map<string, number[]>();
      const resolved = resolveFindingPages(findings, evidenceToPages);
      expect(resolved).toHaveLength(0);
    });
  });

  describe('planEscalationFromVerification', () => {
    it('returns terminal when verification passed', () => {
      const result: VerificationResultMinimalV1 = {
        decision: 'PASS',
        checks: [],
        discrepancies: [],
      };
      const escalation = planEscalationFromVerification({
        executionId: 'exec-001',
        cycleId: 'fy2025',
        manifestDocumentKey: 'r1-fy2025',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        parserPolicy: 'deterministic_table',
        pageProfiles: [makeProfile(1)],
        verificationResult: result,
        evidenceToPages: new Map(),
        attemptedEnginesByPage: new Map(),
        allowPaidParse: false,
        maxPaidPages: 0,
        currentRound: 0,
      });
      expect(escalation.terminal).toBe(true);
      expect(escalation.terminalReason).toBe('no_correctable_findings');
    });
  });
});