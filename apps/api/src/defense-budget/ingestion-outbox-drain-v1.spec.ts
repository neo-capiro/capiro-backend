import { readFileSync } from 'node:fs';
import {
  ingestionOutboxDispositionForBridgeResultV1,
  readinessScopeForSucceededObservationV1,
  SUPPORTED_DRAIN_FAMILY_GROUPS_V1,
} from './ingestion-outbox-drain-v1.js';
import type {
  ObservationIngestionBridgeResult,
  ObservationIngestionBridgeStatus,
} from './observation-ingestion-bridge.service.js';

function bridge(
  status: ObservationIngestionBridgeStatus,
  ingestionSucceeded = false,
): ObservationIngestionBridgeResult {
  return {
    status,
    ingestionSucceeded,
    observationId: 'o',
    sourceDocumentId: 'd',
    reason: status,
    sourceDocumentBound: ingestionSucceeded,
    parserVerificationSucceeded: ingestionSucceeded,
    durableEvidencePersisted: ingestionSucceeded,
    parserHandoffInvoked: true,
    parserHandoffError: null,
    verifierDecision: ingestionSucceeded ? 'PASS' : null,
  };
}
describe('ingestion outbox policy', () => {
  test.each([
    ['ingested', true, 'succeeded'],
    ['already_ingested', true, 'succeeded'],
    ['source_bytes_changed', false, 'governed_reject'],
    ['downstream_failed', false, 'retry'],
    ['review_required', false, 'governed_review'],
    ['verification_rejected', false, 'governed_reject'],
    ['blocked', false, 'governed_reject'],
    ['rejected', false, 'governed_reject'],
  ] as const)('%s maps to %s', (status, success, expected) =>
    expect(ingestionOutboxDispositionForBridgeResultV1(bridge(status, success)).disposition).toBe(
      expected,
    ),
  );
  test('rejected is deterministic and never retryable', () =>
    expect(ingestionOutboxDispositionForBridgeResultV1(bridge('rejected')).disposition).not.toBe(
      'retry',
    ));

  test.each([
    ['pb_r1', 'request', 'rdte'],
    ['pb_p1', 'request', 'procurement'],
    ['pb_o1', 'request', 'om'],
    ['pb_milcon_c1', 'request', 'milcon'],
    ['auth_committee_mark', 'authorization', 'committee'],
    ['auth_public_law', 'authorization', 'committee'],
  ] as const)('derives %s', (classifiedSourceFamily, authorityTrack, familyGroup) =>
    expect(
      readinessScopeForSucceededObservationV1({
        classifiedSourceFamily,
        authorityTrack,
        fiscalYear: 2027,
      }),
    ).toEqual({ fiscalYear: 2027, authorityTrack, familyGroup }),
  );
  test.each([
    ['pb_overview', 'request'],
    ['exec_allocation', 'request'],
    ['alt_supplemental', 'alternative_funding'],
    ['exec_obligation', 'execution'],
  ] as const)('returns null for %s/%s', (classifiedSourceFamily, authorityTrack) =>
    expect(
      readinessScopeForSucceededObservationV1({
        classifiedSourceFamily,
        authorityTrack,
        fiscalYear: 2027,
      }),
    ).toBeNull(),
  );
  test('drain allow-list excludes committee', () =>
    expect(SUPPORTED_DRAIN_FAMILY_GROUPS_V1).toEqual(['rdte', 'procurement', 'om', 'milcon']));
  test('contains no authorization/execution boundary access', () => {
    const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      'DefenseBudgetPromotionAuthorizationServiceV1',
      'DefenseBudgetCanonicalPromotionServiceV1',
      'PROMOTER_DATABASE_URL',
    ])
      expect(source).not.toContain(forbidden);
  });
});
