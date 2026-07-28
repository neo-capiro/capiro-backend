/**
 * Assertion mapper (Slice 5 bridge) — converts INDEPENDENT extractor assertions into the
 * program-element writer's PeRecordInput / PeYearInput shape, which already does per-field
 * merge, source-priority resolution and reconciliation-queue emission.
 *
 * Design decisions that preserve the identity + independence guarantees:
 *   - ONLY RDTE_PE lines feed the ProgramElement (PE) writer. PROCUREMENT_BLIN / OM_SAG
 *     lines are returned separately and MUST NOT be written into the PE table (they have
 *     their own identity — writing them as PEs would violate the core guardrail).
 *   - Money is normalized to USD MILLIONS (the writer's canonical unit) for the value field,
 *     while the original unit + exact printed value are preserved in the per-field source
 *     value provenance so nothing is lost.
 *   - We DO NOT pick winners here. Each assertion maps to one field on one PE-year; the
 *     writer merges and the reconciliation layer resolves conflicts.
 */
import { normalizeMoneyToMillions } from '@capiro/shared/money';
import type { ExtractionResult, LineAssertion, Money, YearValueAssertion } from './extractors/types.js';
import type { PeRecordInput, PeYearInput } from '../program-element/types.js';

/** Map a field name from the extractor's vocabulary to the writer's PeYearInput key. */
const FIELD_MAP: Record<string, keyof PeYearInput> = {
  request: 'request',
  hascMark: 'hascMark',
  sascMark: 'sascMark',
  hacdMark: 'hacDMark',
  sacdMark: 'sacDMark',
  conference: 'conference',
  ndaaConference: 'ndaaConference',
  enacted: 'enacted',
  reprogrammed: 'reprogrammed',
  executed: 'executed',
};

/** Normalize an exact printed Money to the writer's canonical USD-millions unit. */
export function toMillions(m: Money): number {
  return normalizeMoneyToMillions(m.value, m.unit).valueM;
}

export interface MappedPeData {
  records: PeRecordInput[];
  years: PeYearInput[];
  /** Non-PE lines (procurement/O&M) — carried through for their own loaders, NEVER as PEs. */
  nonPeLines: LineAssertion[];
  /** Independent per-field source-value rows (peCode, fy, field, value, unit, provenance). */
  sourceValues: Array<{
    peCode: string;
    fy: number;
    fieldName: keyof PeYearInput;
    /** Canonical value in USD millions. */
    valueM: number;
    originalUnit: Money['unit'];
    originalValue: number;
    provenance: YearValueAssertion['provenance'];
  }>;
}

export function mapAssertionsToPeWriter(extraction: ExtractionResult): MappedPeData {
  const records = new Map<string, PeRecordInput>();
  const nonPeLines: LineAssertion[] = [];

  for (const line of extraction.lineAssertions) {
    if (line.lineKind !== 'RDTE_PE') {
      nonPeLines.push(line);
      continue;
    }
    // First non-empty title wins for the catalog record; keep it independent per PE code.
    if (!records.has(line.code)) {
      records.set(line.code, {
        peCode: line.code,
        service: line.component ?? null,
        title: line.title,
        budgetActivity: line.budgetActivity ?? null,
        description: line.mission ?? null,
      });
    }
  }

  // Merge per (peCode, fy) so one PeYearInput carries all fields for that year, but keep
  // each field's contribution as its own source-value row (independence preserved).
  const yearMap = new Map<string, PeYearInput>();
  const sourceValues: MappedPeData['sourceValues'] = [];

  for (const v of extraction.yearValues) {
    if (v.lineKind !== 'RDTE_PE') continue; // procurement/O&M values are not PE-year rows
    const field = FIELD_MAP[v.fieldName];
    if (!field || v.money == null) continue; // only money fields land on PE-year rows here
    const valueM = toMillions(v.money);

    const key = `${v.code}::${v.fy}`;
    const row = yearMap.get(key) ?? { peCode: v.code, fy: v.fy };
    // Writer accepts string|number; store the normalized USD-millions value.
    (row as unknown as Record<string, unknown>)[field] = valueM;
    yearMap.set(key, row);

    sourceValues.push({
      peCode: v.code,
      fy: v.fy,
      fieldName: field,
      valueM,
      originalUnit: v.money.unit,
      originalValue: v.money.value,
      provenance: v.provenance,
    });
  }

  return {
    records: Array.from(records.values()),
    years: Array.from(yearMap.values()),
    nonPeLines,
    sourceValues,
  };
}
