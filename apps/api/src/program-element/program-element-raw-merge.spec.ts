import { describe, expect, test } from '@jest/globals';
import { mergeProgramElementRaw, mergeProgramElementYearRaw } from './program-element-raw-merge.js';

describe('Program Element raw source ownership', () => {
  test('preserves P-40 and OP-5 enrichment across later source writes', () => {
    const initial = {
      pDocDetail: { contractors: ['A'] },
      op5Detail: { activity: 'SAG' },
      unrelated: { keep: true },
      sourcePayloads: { p_doc: { old: true } },
    };
    const merged = mergeProgramElementRaw(initial, { requestTable: [1], drop: undefined }, 'r_doc_fy27') as Record<string, unknown>;
    expect(merged.pDocDetail).toEqual({ contractors: ['A'] });
    expect(merged.op5Detail).toEqual({ activity: 'SAG' });
    expect(merged.unrelated).toEqual({ keep: true });
    expect((merged.sourcePayloads as Record<string, unknown>).r_doc).toEqual({ requestTable: [1] });
    expect((merged.sourcePayloads as Record<string, unknown>).p_doc).toEqual({ old: true });
  });

  test('new P-40 and OP-5 owner payloads update their top-level compatibility keys', () => {
    const withP40 = mergeProgramElementRaw({}, { pDocDetail: { quantity: 2 } }, 'p_doc_fy27') as Record<string, unknown>;
    const withOp5 = mergeProgramElementRaw(withP40, { op5Detail: { obligations: 5 } }, 'o1_fy27') as Record<string, unknown>;
    expect(withOp5.pDocDetail).toEqual({ quantity: 2 });
    expect(withOp5.op5Detail).toEqual({ obligations: 5 });
  });

  test('array/non-object roots are isolated instead of replacing the raw root', () => {
    const merged = mergeProgramElementRaw(['legacy-array'], ['incoming-array'], 'r_doc') as Record<string, unknown>;
    expect(merged).toEqual({ sourcePayloads: { r_doc: ['incoming-array'] } });
  });

  test('year merge retains provenance maps at top level and omits undefined recursively', () => {
    const merged = mergeProgramElementYearRaw(
      { pDocDetail: { keep: true }, sourcePayloads: { p_doc: { a: 1 } } },
      { nested: { yes: 1, no: undefined } },
      'hasc_report_fy27',
      { request: 'r_doc_fy27', hascMark: 'hasc_report_fy27' },
      { request: "President's Budget (R-2)", hascMark: 'HASC report' },
      { request: '2026-07-29', hascMark: '2026-07-29' },
    ) as Record<string, unknown>;
    expect(merged.pDocDetail).toEqual({ keep: true });
    expect(merged.fieldSources).toEqual({ request: 'r_doc_fy27', hascMark: 'hasc_report_fy27' });
    expect(merged.sourceAttribution).toEqual({ request: "President's Budget (R-2)", hascMark: 'HASC report' });
    expect(merged.datesAdded).toEqual({ request: '2026-07-29', hascMark: '2026-07-29' });
    expect((merged.sourcePayloads as Record<string, unknown>).hasc_report).toEqual({ nested: { yes: 1 } });
  });
});
