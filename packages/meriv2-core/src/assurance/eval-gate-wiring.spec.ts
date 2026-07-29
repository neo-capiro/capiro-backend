import { describe, expect, it } from '@jest/globals';
import {
  defaultReleaseGateThresholds,
  evaluateReleaseGate,
  type AssuranceEvalResult,
  type EvalProvenance,
} from './eval-gate';

/**
 * These pin the properties the CI runner now DEPENDS on for its exit code.
 *
 * Before this, `evaluateReleaseGate` had no production caller at all: run-evals.ts
 * counted passes and console.logged them, so the category-specific gate — the whole
 * reason this module exists — never ran. Now the runner exits non-zero on
 * `!allowed`, which means these behaviours are load-bearing.
 */

const provenance: EvalProvenance = {
  gitSha: 'abc123',
  promptVersion: 'meriv2-deterministic',
  contextCompilerVersion: 'unknown',
  toolManifestHash: 'unknown',
  model: 'none-deterministic',
  provider: 'none',
  datasetVersion: 'ga-goldens-v1.0.0',
  date: '2026-07-29T00:00:00.000Z',
};

function result(over: Partial<AssuranceEvalResult> = {}): AssuranceEvalResult {
  return {
    id: 'legislation/bill-status',
    tier: 'L1',
    domain: 'legislation',
    severity: 'critical',
    passed: true,
    metric: 'deterministic_check',
    detail: 'ok',
    ...over,
  };
}

describe('release gate as the CI exit code', () => {
  const thresholds = defaultReleaseGateThresholds();

  it('ALLOWS a run where every deterministic case passed', () => {
    const report = evaluateReleaseGate({
      provenance,
      thresholds,
      results: [
        result(),
        result({ id: 'leakage/matrix', domain: 'security_tenancy', metric: 'tenant_isolation' }),
        result({
          id: 'compliance/gate',
          domain: 'compliance_actions',
          metric: 'approval_invariant',
        }),
      ],
    });
    expect(report.allowed).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.provenanceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('BLOCKS on a single critical regression, however many cases passed', () => {
    const report = evaluateReleaseGate({
      provenance,
      thresholds,
      results: [
        ...Array.from({ length: 20 }, (_, i) => result({ id: `ok-${i}` })),
        result({ id: 'legislation/state-bill', passed: false, detail: 'crossover-dead regressed' }),
      ],
    });
    // This is the property a pass COUNT cannot express: 20/21 is not a release.
    expect(report.allowed).toBe(false);
    expect(report.blockers.join(' ')).toContain('Critical legislation regression');
  });

  it('BLOCKS on a tenant-isolation or approval-invariant failure at ANY severity', () => {
    for (const metric of ['tenant_isolation', 'approval_invariant'] as const) {
      const report = evaluateReleaseGate({
        provenance,
        thresholds,
        results: [result({ id: `x-${metric}`, passed: false, severity: 'low', metric })],
      });
      expect(report.allowed).toBe(false);
      expect(report.blockers.join(' ')).toContain(metric);
    }
  });

  it('reports the per-DOMAIN breakdown that gets persisted as immutable evidence', () => {
    const report = evaluateReleaseGate({
      provenance,
      thresholds,
      results: [
        result({ id: 'l1', domain: 'legislation' }),
        result({ id: 'l2', domain: 'legislation', passed: false }),
        result({ id: 's1', domain: 'security_tenancy' }),
      ],
    });
    const legislation = report.domains.find((d) => d.domain === 'legislation');
    expect(legislation).toMatchObject({ passed: 1, failed: 1, criticalFailed: 1 });
    const tenancy = report.domains.find((d) => d.domain === 'security_tenancy');
    expect(tenancy).toMatchObject({ passed: 1, failed: 0, criticalFailed: 0 });
  });

  it('never lets a cost/latency sign-off waive a safety failure', () => {
    const report = evaluateReleaseGate({
      provenance,
      thresholds: {
        ...thresholds,
        costLatencySignoff: { approved: true, approvedBy: 'neo', reason: 'accepted' },
      },
      results: [result({ id: 'leak', passed: false, metric: 'tenant_isolation' })],
    });
    // Sign-off exists for cost/latency ONLY. A tenancy failure is not waivable.
    expect(report.allowed).toBe(false);
  });

  it('produces a STABLE provenance hash for identical provenance', () => {
    const a = evaluateReleaseGate({ provenance, thresholds, results: [result()] });
    const b = evaluateReleaseGate({ provenance, thresholds, results: [result({ id: 'other' })] });
    // The hash covers PROVENANCE (what was run), not the results — so the same
    // commit/dataset/model tuple is idempotent for the unique index on
    // assurance_eval_run (tenant_id, provenance_hash).
    expect(a.provenanceHash).toBe(b.provenanceHash);
  });
});
