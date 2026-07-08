import { diffMarks } from './mark-dry-run-diff.js';
import type { CommitteeReportMarkRecord } from './committee-report-parser.js';

const rec = (peCode: string, markDollars: number | null): CommitteeReportMarkRecord => ({
  peCode,
  fy: 2027,
  request: null,
  mark: markDollars,
  explanation: null,
});

describe('diffMarks (parse-verb dry-run gate)', () => {
  const known = new Set(['0601102A', '0603270A', '0207138F']);

  it('classifies new / changed / unchanged / missing / no-mark rows', () => {
    const existing = new Map([
      ['0601102A', { currentMillions: 12.5 }],
      ['0603270A', { currentMillions: null }],
      ['0207138F', { currentMillions: 100.0 }],
    ]);
    const out = diffMarks(
      [
        rec('0601102A', 12_500_000), // equal → unchanged
        rec('0603270A', 224_000_000), // blank → new_value
        rec('0207138F', 99_000_000), // differs → changed
        rec('9999999Z', 1_000_000), // unknown PE → missing_pe (writer would quarantine)
        rec('0601102A', null), // no mark → skipped
      ],
      existing,
      known,
    );
    expect(out).toMatchObject({
      total: 5,
      noMark: 1,
      newValue: 1,
      changed: 1,
      unchanged: 1,
      missingPe: 1,
    });
    const changed = out.samples.find((s) => s.kind === 'changed');
    expect(changed).toMatchObject({ peCode: '0207138F', currentMillions: 100, incomingMillions: 99 });
  });

  it('a replayed already-loaded artifact diffs to 100% unchanged (the Phase 4 drill contract)', () => {
    const existing = new Map([
      ['0601102A', { currentMillions: 12.5 }],
      ['0603270A', { currentMillions: 224.0 }],
    ]);
    const out = diffMarks(
      [rec('0601102A', 12_500_000), rec('0603270A', 224_000_000)],
      existing,
      known,
    );
    expect(out.changed).toBe(0);
    expect(out.newValue).toBe(0);
    expect(out.missingPe).toBe(0);
    expect(out.unchanged).toBe(2);
  });

  it('tolerates sub-$K float noise but not real deltas', () => {
    const existing = new Map([['0601102A', { currentMillions: 12.3456784 }]]);
    expect(diffMarks([rec('0601102A', 12_345_678)], existing, known).unchanged).toBe(1);
    expect(diffMarks([rec('0601102A', 12_346_800)], existing, known).changed).toBe(1);
  });

  it('caps samples at the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => rec('0601102A', 1_000_000 * (i + 2)));
    const existing = new Map([['0601102A', { currentMillions: 1.0 }]]);
    const out = diffMarks(many, existing, known, 15);
    expect(out.samples).toHaveLength(15);
  });

  it('reports maxAbsDeltaMillions and surfaces the biggest change first (ceiling check)', () => {
    // A pile of tiny rounding refinements plus one real multi-million overwrite.
    const existing = new Map([
      ['0601102A', { currentMillions: 237.68 }],
      ['0603270A', { currentMillions: 78.95 }],
      ['0207138F', { currentMillions: 100.0 }], // real change buried here
    ]);
    const out = diffMarks(
      [
        rec('0601102A', 237_678_000), // Δ $2K (rounding)
        rec('0603270A', 78_947_000), // Δ $3K (rounding)
        rec('0207138F', 150_000_000), // Δ $50M (real — must surface first)
      ],
      existing,
      known,
      2,
    );
    expect(out.changed).toBe(3);
    expect(out.maxAbsDeltaMillions).toBeCloseTo(50, 5);
    // Sorted most-material-first, so the $50M change is sample #1 even at limit 2.
    expect(out.samples[0]?.peCode).toBe('0207138F');
    expect(out.samples).toHaveLength(2);
  });

  it('maxAbsDeltaMillions is null when nothing changes', () => {
    const existing = new Map([['0601102A', { currentMillions: 12.5 }]]);
    const out = diffMarks([rec('0601102A', 12_500_000)], existing, known);
    expect(out.maxAbsDeltaMillions).toBeNull();
  });
});
