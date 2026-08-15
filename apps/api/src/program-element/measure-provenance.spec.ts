/**
 * Neo's decision, 2026-08-08 — settled architecture, do not reopen.
 *
 * **One response may contain canonical snapshot data and live enrichment, but
 * they must remain separately typed, separately attributed, separately dated,
 * and never be silently aggregated.**
 *
 * This is the contract rule that keeps that true. It is a separate rule from
 * `assertOneSnapshotV1`, which forbids two *canonical snapshots* in one
 * response and is silent on snapshot-plus-external — the case that actually
 * produced a wrong number in `getContractors`.
 *
 * The specific defect being locked out: `getContractors` computed
 * `acceptedDirectAmountM = directAwardM + namedPrimeM`, adding a
 * government-stated R-3 exhibit value to a rolling 24-month USAspending
 * obligation total and rendering the sum as one dollar figure. That figure
 * changed daily while claiming to describe an immutable exhibit, and a reader
 * could not decompose it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MeasureConflationError,
  sumAttributedMeasures,
  type AttributedMeasure,
} from '@capiro/shared/funding-claim';

const exhibit: AttributedMeasure = {
  amountM: 42,
  count: 3,
  unit: 'USD millions',
  label: 'Government-named performer value (R-3 exhibit)',
  provenance: {
    kind: 'canonical_snapshot',
    source: 'R-3',
    snapshotId: 'snap-1',
    asOf: '2026-08-01T00:00:00.000Z',
  },
};

const awards: AttributedMeasure = {
  amountM: 18.6,
  count: 7,
  unit: 'USD millions',
  label: 'Recent federal award obligations (USAspending)',
  provenance: {
    kind: 'live_external',
    source: 'USAspending',
    asOf: '2026-08-08T00:00:00.000Z',
    windowMonths: 24,
  },
};

describe('measure provenance — snapshot and live external are never conflated', () => {
  it('refuses to add a canonical-snapshot measure to a live external one', () => {
    expect(() => sumAttributedMeasures([exhibit, awards])).toThrow(MeasureConflationError);
  });

  it('names both provenance kinds in the refusal, so the message is actionable', () => {
    let caught: unknown;
    try {
      sumAttributedMeasures([exhibit, awards]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MeasureConflationError);
    expect((caught as MeasureConflationError).message).toContain('canonical_snapshot');
    expect((caught as MeasureConflationError).message).toContain('live_external');
  });

  it('refuses regardless of order — this is not an argument-position accident', () => {
    expect(() => sumAttributedMeasures([awards, exhibit])).toThrow(MeasureConflationError);
  });

  it('still allows summing within one provenance kind', () => {
    // Two USAspending windows may legitimately add; the rule is about crossing
    // the boundary, not about forbidding arithmetic.
    const second: AttributedMeasure = { ...awards, amountM: 1.4 };
    expect(sumAttributedMeasures([awards, second])).toBeCloseTo(20, 10);
  });

  it('sums a single measure and an empty set without complaint', () => {
    expect(sumAttributedMeasures([exhibit])).toBe(42);
    expect(sumAttributedMeasures([])).toBe(0);
  });

  it('a live external measure always carries a freshness timestamp', () => {
    // Typed as required rather than optional, so this is a compile-time
    // guarantee the test pins at runtime too: an undated live measure is the
    // failure mode where stale enrichment reads as current.
    expect(awards.provenance.kind).toBe('live_external');
    if (awards.provenance.kind === 'live_external') {
      expect(awards.provenance.asOf).toBeTruthy();
      expect(awards.provenance.windowMonths).toBe(24);
    }
  });

  it('a canonical snapshot measure carries its snapshot reference', () => {
    expect(exhibit.provenance.kind).toBe('canonical_snapshot');
    if (exhibit.provenance.kind === 'canonical_snapshot') {
      expect(exhibit.provenance.snapshotId).toBe('snap-1');
      expect(exhibit.provenance.asOf).toBe('2026-08-01T00:00:00.000Z');
    }
  });

  it('legacy-compatibility is its own kind and never merges with the others', () => {
    const legacy: AttributedMeasure = {
      amountM: 42,
      count: 3,
      unit: 'USD millions',
      label: 'Government-named performer value (R-3 exhibit)',
      provenance: {
        kind: 'legacy_compatibility',
        source: 'R-3',
        table: 'program_element_performer',
        reason: 'canonical_rdte_performer carries no money axis',
      },
    };
    expect(() => sumAttributedMeasures([legacy, awards])).toThrow(MeasureConflationError);
    expect(() => sumAttributedMeasures([legacy, exhibit])).toThrow(MeasureConflationError);
  });
});

/**
 * Regression guard for a defect that actually shipped: `getContractors`
 * labelled its exhibit measure `kind: 'canonical_snapshot'` with a live
 * `snapshotId`, while `namedPrimes` reads `program_element_performer`
 * unconditionally. That attaches a real snapshot id to legacy data the moment
 * any snapshot goes active — the exact misattribution this contract exists to
 * prevent.
 *
 * Asserted against the source text rather than by invoking the method, because
 * the method needs a live Prisma client and the property under test is which
 * literal the code carries, not what a query returns.
 */
describe('getContractors does not claim snapshot provenance for a legacy read', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'program-element-read.service.ts'),
    'utf8',
  );
  const block = source.slice(
    source.indexOf('governmentExhibit:'),
    source.indexOf('federalAwards:'),
  );

  it('labels the exhibit measure legacy_compatibility', () => {
    expect(block).toContain("kind: 'legacy_compatibility'");
  });

  it('never labels it canonical_snapshot while the read is on the legacy table', () => {
    expect(block).not.toContain("kind: 'canonical_snapshot'");
    expect(block).not.toContain('snapshotId');
  });

  it('names the compatibility table it actually reads', () => {
    expect(block).toContain('program_element_performer');
    expect(source).toContain('FROM program_element_performer');
  });
});
