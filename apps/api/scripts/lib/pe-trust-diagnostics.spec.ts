import { describe, expect, test } from '@jest/globals';
import { evaluatePeTrustDiagnostics } from './pe-trust-diagnostics.js';

const FRESH = {
  'pe-derive-chain': 100,
  'sync-sam-opportunities': 200,
  'send-pe-alert-emails': 300,
};

describe('evaluatePeTrustDiagnostics (K3)', () => {
  test('healthy inputs → ok with no findings', () => {
    const r = evaluatePeTrustDiagnostics({
      sourceAgeSeconds: FRESH,
      observationsWithoutSourceDocument: 0,
      duplicateObservationGroups: 0,
      openReconciliationCount: 0,
      pendingOutboxCount: 0,
      samPartialRunCount: 0,
      staleCacheEntryCount: 0,
      coverageGapCount: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.blockers).toHaveLength(0);
    expect(r.findings).toHaveLength(0);
  });

  test('unobserved required source fails closed', () => {
    const r = evaluatePeTrustDiagnostics({
      sourceAgeSeconds: {
        'pe-derive-chain': 10,
        // sync-sam missing → unobserved
        'send-pe-alert-emails': 10,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.blockers.some((f) => f.code === 'late_source_unobserved')).toBe(true);
  });

  test('late source fails closed', () => {
    const r = evaluatePeTrustDiagnostics({
      sourceAgeSeconds: {
        ...FRESH,
        'sync-sam-opportunities': 999_999,
      },
      lateSourceThresholdSeconds: 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.blockers.some((f) => f.code === 'late_source')).toBe(true);
  });

  test('null source-document observations fail closed', () => {
    const r = evaluatePeTrustDiagnostics({
      sourceAgeSeconds: FRESH,
      observationsWithoutSourceDocument: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.blockers[0]?.code).toBe('null_source_document_observation');
  });

  test('duplicate observations fail closed', () => {
    const r = evaluatePeTrustDiagnostics({
      sourceAgeSeconds: FRESH,
      duplicateObservationGroups: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.blockers[0]?.code).toBe('duplicate_observations');
  });

  test('stale reconciliation fails closed; young open is warning only', () => {
    const stale = evaluatePeTrustDiagnostics({
      sourceAgeSeconds: FRESH,
      openReconciliationCount: 4,
      oldestOpenReconciliationAgeSeconds: 10_000_000,
      staleReconciliationThresholdSeconds: 1000,
    });
    expect(stale.ok).toBe(false);
    expect(stale.blockers.some((f) => f.code === 'stale_reconciliation')).toBe(true);

    const young = evaluatePeTrustDiagnostics({
      sourceAgeSeconds: FRESH,
      openReconciliationCount: 1,
      oldestOpenReconciliationAgeSeconds: 10,
      staleReconciliationThresholdSeconds: 1000,
    });
    expect(young.ok).toBe(true);
    expect(young.warnings.some((f) => f.code === 'open_reconciliation')).toBe(true);
  });

  test('old pending outbox fails closed; fresh pending is warning', () => {
    const old = evaluatePeTrustDiagnostics({
      sourceAgeSeconds: FRESH,
      pendingOutboxCount: 5,
      oldestPendingOutboxAgeSeconds: 500_000,
      oldOutboxThresholdSeconds: 1000,
    });
    expect(old.ok).toBe(false);
    expect(old.blockers.some((f) => f.code === 'old_pending_outbox')).toBe(true);

    const fresh = evaluatePeTrustDiagnostics({
      sourceAgeSeconds: FRESH,
      pendingOutboxCount: 2,
      oldestPendingOutboxAgeSeconds: 10,
      oldOutboxThresholdSeconds: 1000,
    });
    expect(fresh.ok).toBe(true);
    expect(fresh.warnings.some((f) => f.code === 'pending_outbox')).toBe(true);
  });

  test('partial SAM + stale cache + coverage gap severities', () => {
    const r = evaluatePeTrustDiagnostics({
      sourceAgeSeconds: FRESH,
      samPartialRunCount: 1,
      staleCacheEntryCount: 2,
      coverageGapCount: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.blockers.map((f) => f.code).sort()).toEqual([
      'partial_sam_run',
      'stale_cache',
    ]);
    expect(r.warnings.some((f) => f.code === 'coverage_gap')).toBe(true);

    const forced = evaluatePeTrustDiagnostics({
      sourceAgeSeconds: FRESH,
      coverageGapCount: 1,
      forceCoverageGapsBlocker: true,
    });
    expect(forced.ok).toBe(false);
    expect(forced.blockers.some((f) => f.code === 'coverage_gap')).toBe(true);
  });
});
