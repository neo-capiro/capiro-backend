import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCoverageReconciliation, type CoverageReconciliationInput } from './coverage-reconciliation.js';

const base: CoverageReconciliationInput = {
  fiscalYear: 2024, environment: 'capiro-dev', activeSnapshotId: 'snapshot',
  slots: [{ slotId: 'r2', fiscalYear: 2024, sourceFamily: 'pb_r2', component: 'ARMY',
    optional: false, catalogComplete: false }],
  units: [
    { unitId: 'volume-a', slotId: 'r2', kind: 'volume', required: true, account: null,
      budgetActivity: '1', volume: '1',
      sourceDocumentId: 'doc-a', sourceSha256: 'sha-a', superseded: false, unavailable: false },
    { unitId: 'volume-b', slotId: 'r2', kind: 'volume', required: true, account: null,
      budgetActivity: '2', volume: '1',
      sourceDocumentId: null, sourceSha256: null, superseded: false, unavailable: false },
  ],
  candidates: [{ candidateId: 'candidate-a', sourceDocumentId: 'doc-a', sourceSha256: 'sha-a',
    runId: 'run-a', verificationDecision: 'PASS', reviewAccepted: true }],
  publications: [{ sourceDocumentId: 'doc-a', sourceSha256: 'sha-a',
    candidateId: 'candidate-a', runId: 'run-a' }],
};

describe('physical coverage reconciliation', () => {
  it('keeps logical and physical counts separate with unknown denominator', () => {
    const report = buildCoverageReconciliation(base);
    assert.equal(report.logicalSlotCount, 1);
    assert.equal(report.rows[0]?.knownRequiredUnits, 2);
    assert.equal(report.rows[0]?.denominator, null);
    assert.equal(report.rows[0]?.published, 1);
    assert.deepEqual(report.rows[0]?.exceptions, ['catalog_completeness_unknown']);
    assert.ok(report.rows[0]?.units[1]?.exceptions.includes('physical_source_missing'));
    assert.ok(report.rows[0]?.units[1]?.exceptions.includes('account_attribution_unknown'));
    assert.equal(report.rows[0]?.units[0]?.account, null);
    assert.equal(report.rows[0]?.units[0]?.budgetActivity, '1');
    assert.equal(report.rows[0]?.units[0]?.kind, 'volume');
    assert.equal(report.rows[0]?.units[0]?.sourceSha256, 'sha-a');
  });

  it('requires candidate/run/source SHA lineage on the active snapshot', () => {
    for (const publication of [
      { ...base.publications[0]!, sourceSha256: 'wrong' },
      { ...base.publications[0]!, runId: 'wrong' },
      { ...base.publications[0]!, candidateId: 'wrong' },
    ]) {
      const report = buildCoverageReconciliation({ ...base, publications: [publication] });
      assert.equal(report.rows[0]?.published, 0);
      if (publication.sourceSha256 === 'sha-a') {
        assert.ok(report.rows[0]?.units[0]?.exceptions.includes('publication_lineage_unbound'));
      }
    }
    assert.equal(buildCoverageReconciliation({ ...base, activeSnapshotId: null }).rows[0]?.published, 0);
  });

  it('does not multiply physical coverage for duplicate runs or superseded editions', () => {
    const report = buildCoverageReconciliation({ ...base,
      units: [...base.units, { ...base.units[0]!, unitId: 'old', superseded: true }],
      candidates: [...base.candidates, base.candidates[0]!],
      publications: [...base.publications, base.publications[0]!],
    });
    assert.equal(report.rows[0]?.knownRequiredUnits, 2);
    assert.equal(report.rows[0]?.units.length, 3);
    assert.equal(report.rows[0]?.units[2]?.superseded, true);
    assert.ok(report.rows[0]?.units[2]?.exceptions.includes('source_superseded'));
    assert.equal(report.rows[0]?.parsed, 1);
    assert.equal(report.rows[0]?.published, 1);
  });

  it('shows optional units and their omissions without placing them in the required denominator', () => {
    const report = buildCoverageReconciliation({ ...base, units: [
      ...base.units, { ...base.units[1]!, unitId: 'optional-annex', required: false },
    ] });
    assert.equal(report.rows[0]?.knownRequiredUnits, 2);
    assert.equal(report.rows[0]?.knownOptionalUnits, 1);
    assert.equal(report.rows[0]?.units.length, 3);
    assert.equal(report.rows[0]?.units[2]?.required, false);
    assert.ok(report.rows[0]?.units[2]?.exceptions.includes('physical_source_missing'));
  });

  it('distinguishes parsing, verification, review and publication', () => {
    const report = buildCoverageReconciliation({ ...base, candidates: [
      { ...base.candidates[0]!, verificationDecision: 'REVIEW', reviewAccepted: false },
    ], publications: [] });
    assert.equal(report.rows[0]?.parsed, 1);
    assert.equal(report.rows[0]?.verified, 0);
    assert.equal(report.rows[0]?.reviewed, 0);
    assert.equal(report.rows[0]?.published, 0);
  });

  it('reports blocked source even when an archived identity survives', () => {
    const report = buildCoverageReconciliation({ ...base, units: [
      { ...base.units[0]!, unavailable: true },
    ] });
    assert.ok(report.rows[0]?.units[0]?.exceptions.includes('source_unavailable'));
    assert.equal(report.rows[0]?.units[0]?.published, false);
    assert.ok(!report.rows[0]?.units[0]?.exceptions.includes('publication_missing'));
  });

  it('never reports a publication as current when the matching row has a non-PASS run or no accepted review', () => {
    for (const candidate of [
      { ...base.candidates[0]!, verificationDecision: 'REVIEW' as const, reviewAccepted: true },
      { ...base.candidates[0]!, verificationDecision: 'PASS' as const, reviewAccepted: false },
    ]) {
      const report = buildCoverageReconciliation({ ...base, candidates: [candidate] });
      expectUnbound(report.rows[0]?.units[0]);
    }
  });

  it('keeps superseded source history visible without treating it as current publication coverage', () => {
    const report = buildCoverageReconciliation({ ...base, units: [
      { ...base.units[0]!, superseded: true },
    ] });
    const unit = report.rows[0]?.units[0];
    assert.equal(unit?.sourceDocumentId, 'doc-a');
    assert.equal(unit?.sourceSha256, 'sha-a');
    assert.equal(unit?.published, false);
    assert.ok(unit?.exceptions.includes('source_superseded'));
    assert.ok(!unit?.exceptions.includes('physical_source_missing'));
  });
});

function expectUnbound(unit: ReturnType<typeof buildCoverageReconciliation>['rows'][number]['units'][number] | undefined) {
  assert.equal(unit?.published, false);
  assert.ok(unit?.exceptions.includes('publication_lineage_unbound'));
}
