import { describe, expect, test } from '@jest/globals';
import { ENTITY_RESOLUTION_GOLDEN_CORPUS } from './entity-resolution-golden-corpus.js';
import {
  evaluateEntityResolutionGoldenCorpus,
  type EntityResolutionGoldenObservation,
} from './entity-resolution-evaluator.js';

function perfectObservations(): EntityResolutionGoldenObservation[] {
  return ENTITY_RESOLUTION_GOLDEN_CORPUS.map((testCase) => ({
    caseId: testCase.id,
    status: testCase.expected.status,
    selectedCanonicalName:
      testCase.expected.status === 'resolved'
        ? testCase.expected.selectedCanonicalName ?? null
        : null,
    candidateCanonicalNames: [],
  }));
}

describe('entity resolution golden evaluator', () => {
  test('passes a complete precision-first observation set', () => {
    const report = evaluateEntityResolutionGoldenCorpus(
      ENTITY_RESOLUTION_GOLDEN_CORPUS,
      perfectObservations(),
    );

    expect(report.pass).toBe(true);
    expect(report.coverage).toBe(1);
    expect(report.falseMergeCount).toBe(0);
    expect(report.privacyLeakCount).toBe(0);
  });

  test('fails release on a false merge even when most cases are correct', () => {
    const observations = perfectObservations();
    const ambiguousIndex = observations.findIndex(
      (observation) => observation.caseId === 'org_ambiguous_kinetic',
    );
    observations[ambiguousIndex] = {
      caseId: 'org_ambiguous_kinetic',
      status: 'resolved',
      selectedCanonicalName: 'Kinetic Industries — Wrong Entity',
    };

    const report = evaluateEntityResolutionGoldenCorpus(
      ENTITY_RESOLUTION_GOLDEN_CORPUS,
      observations,
    );

    expect(report.pass).toBe(false);
    expect(report.falseMergeCount).toBe(1);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caseId: 'org_ambiguous_kinetic',
          kind: 'false_merge',
        }),
      ]),
    );
  });

  test('fails release when a tenant-private candidate is merely exposed', () => {
    const observations = perfectObservations();
    const privacyIndex = observations.findIndex(
      (observation) => observation.caseId === 'tenant_private_alias_isolated',
    );
    observations[privacyIndex] = {
      caseId: 'tenant_private_alias_isolated',
      status: 'unresolved',
      candidateCanonicalNames: ['Blue Lantern Holdings — Tenant A'],
    };

    const report = evaluateEntityResolutionGoldenCorpus(
      ENTITY_RESOLUTION_GOLDEN_CORPUS,
      observations,
    );

    expect(report.pass).toBe(false);
    expect(report.privacyLeakCount).toBe(1);
  });

  test('reports missing observations as incomplete coverage', () => {
    const observations = perfectObservations().slice(1);
    const report = evaluateEntityResolutionGoldenCorpus(
      ENTITY_RESOLUTION_GOLDEN_CORPUS,
      observations,
    );

    expect(report.pass).toBe(false);
    expect(report.coverage).toBeLessThan(1);
    expect(report.failures[0]).toEqual(
      expect.objectContaining({ kind: 'missing_observation' }),
    );
  });
});
