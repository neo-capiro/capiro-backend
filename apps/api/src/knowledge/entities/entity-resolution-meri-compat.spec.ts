import { describe, expect, test } from '@jest/globals';
import {
  evaluateMeriCompatibleEntityResolution,
  type MeriCompatibleEntityResolutionObservation,
} from './entity-resolution-meri-compat-evaluator.js';
import { MERI_COMPATIBLE_ENTITY_RESOLUTION_CASES } from './entity-resolution-meri-compat-golden.js';

function perfectObservations(): MeriCompatibleEntityResolutionObservation[] {
  return MERI_COMPATIBLE_ENTITY_RESOLUTION_CASES.map((testCase) => ({
    caseId: testCase.id,
    status: testCase.expectedStatus,
    selectedCanonicalName: testCase.expectedSelectedCanonicalName ?? null,
    candidateCanonicalNames: [...(testCase.requiredCandidateCanonicalNames ?? [])],
    attemptedStages: [...testCase.requiredAttemptedStages],
    duplicateEntityCreated: false,
    privateIdentityLeaked: false,
  }));
}

describe('Meri-compatible Phase 5 identity closeout gates', () => {
  test('covers external companies, automatic public fallback, and misspellings', () => {
    expect(MERI_COMPATIBLE_ENTITY_RESOLUTION_CASES.map((testCase) => testCase.id)).toEqual([
      'external_company_exact_official_domain',
      'external_company_public_web_candidate_only',
      'external_company_misspelled_candidate_reconciliation',
    ]);
  });

  test('passes only when fallback coverage is complete and safe', () => {
    const report = evaluateMeriCompatibleEntityResolution(
      MERI_COMPATIBLE_ENTITY_RESOLUTION_CASES,
      perfectObservations(),
    );
    expect(report).toEqual(
      expect.objectContaining({
        coverage: 1,
        externalCompanyResolutionSuccess: 1,
        candidateRecall: 1,
        stageCoverage: 1,
        duplicateEntityCount: 0,
        privacyLeakCount: 0,
        pass: true,
      }),
    );
  });

  test('fails when public-web/model reconciliation silently selects an entity', () => {
    const observations = perfectObservations();
    const index = observations.findIndex(
      (observation) =>
        observation.caseId === 'external_company_misspelled_candidate_reconciliation',
    );
    observations[index] = {
      ...observations[index]!,
      status: 'resolved',
      selectedCanonicalName: 'Kinetic Industries, Inc.',
    };

    const report = evaluateMeriCompatibleEntityResolution(
      MERI_COMPATIBLE_ENTITY_RESOLUTION_CASES,
      observations,
    );
    expect(report.pass).toBe(false);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caseId: 'external_company_misspelled_candidate_reconciliation',
          reason: 'status_mismatch',
        }),
      ]),
    );
  });

  test('fails on duplicate identity or missing automatic fallback stage', () => {
    const observations = perfectObservations();
    observations[1] = {
      ...observations[1]!,
      attemptedStages: ['existing_canonical'],
      duplicateEntityCreated: true,
    };

    const report = evaluateMeriCompatibleEntityResolution(
      MERI_COMPATIBLE_ENTITY_RESOLUTION_CASES,
      observations,
    );
    expect(report.pass).toBe(false);
    expect(report.duplicateEntityCount).toBe(1);
    expect(report.stageCoverage).toBeLessThan(1);
  });
});
