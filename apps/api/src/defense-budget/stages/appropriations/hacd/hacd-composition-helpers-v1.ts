/** Phase 6 Workstream H — pure HAC-D composition helpers. */
import { parseCanonicalDecimalString } from '../../../contracts/decimal-string.js';
import type { ExtractionSourceV1 } from '../../../contracts/extraction-artifact-v1.js';
import {
  composeDuplicateRowsV1,
  type CongressionalRowV1,
  type CongressionalTableV1,
  type RowMoneyV1,
} from '../../congressional-table-v1.js';
import type { DefenseBudgetStageSourceProfileV1 } from '../../stage-source-profile-v1.js';
import type { CommitteeStageActionTypeV1 } from '../../authorization/committee-stage-facts-v1.js';
import { HACD_TABLE_COMPOSITION_POLICY_V1 } from './hacd-source-profile-v1.js';

export function hacdDuplicateDisposition(table: CongressionalTableV1): {
  conflicts: Set<number>;
  secondary: Set<number>;
  groups: Map<number, CongressionalRowV1[]>;
} {
  const conflicts = new Set<number>();
  const secondary = new Set<number>();
  const groups = new Map<number, CongressionalRowV1[]>();
  for (const group of composeDuplicateRowsV1(table, HACD_TABLE_COMPOSITION_POLICY_V1)) {
    if (group.rows.length < 2) continue;
    const rows = [...group.rows].sort((left, right) => left.rowIndex - right.rowIndex);
    if (group.conflict != null) {
      rows.forEach((row) => conflicts.add(row.rowIndex));
    } else if (group.agreedValue != null) {
      groups.set(rows[0]!.rowIndex, rows);
      rows.slice(1).forEach((row) => secondary.add(row.rowIndex));
    }
  }
  return { conflicts, secondary, groups };
}

export function hacdActionMoney(values: RowMoneyV1[]): RowMoneyV1 | undefined {
  return (
    values.find((item) => item.semantic === 'change') ??
    values.find((item) => item.semantic === 'transfer_amount') ??
    values.find((item) => item.semantic === 'rescission_amount')
  );
}

export function hacdActionType(row: CongressionalRowV1, value: string): CommitteeStageActionTypeV1 {
  if (row.semanticKind === 'transfer_in') return 'transfer_in';
  if (row.semanticKind === 'transfer_out') return 'transfer_out';
  if (row.semanticKind === 'rescission') return 'rescission';
  if (row.semanticKind === 'undistributed') return 'undistributed_adjustment';
  if (row.semanticKind === 'general_provision') return 'general_provision';
  return value.startsWith('-') ? 'decrease' : 'increase';
}

export function hacdSignedValue(type: CommitteeStageActionTypeV1, value: string): string {
  const canonical = parseCanonicalDecimalString(value);
  const magnitude = canonical.startsWith('-') ? canonical.slice(1) : canonical;
  if (magnitude === '0') return '0';
  return ['decrease', 'transfer_out', 'rescission'].includes(type) ? `-${magnitude}` : magnitude;
}

export function hacdFiscalYear(table: CongressionalTableV1): number {
  const values = [
    ...new Set(
      table.columns.flatMap((column) => (column.fiscalYear == null ? [] : [column.fiscalYear])),
    ),
  ];
  if (values.length !== 1) {
    throw new Error('HAC-D row requires one unambiguous fiscal year');
  }
  return values[0]!;
}

export function isHacdPackageAction(row: CongressionalRowV1): boolean {
  return (
    row.reference.referenceKind === 'package_scope' &&
    [
      'adjustment',
      'transfer_in',
      'transfer_out',
      'rescission',
      'undistributed',
      'general_provision',
    ].includes(row.semanticKind)
  );
}

export function hacdTableKey(table: CongressionalTableV1): {
  page: number;
  printedPage: string | null;
  headings: string[];
  columns: { columnIndex: number; headerText: string }[];
} {
  return {
    page: table.page,
    printedPage: table.printedPage ?? null,
    headings: table.headings,
    columns: table.columns.map(({ columnIndex, headerText }) => ({ columnIndex, headerText })),
  };
}

export function hacdSourcePath(
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  suffix: string,
): string {
  const heading = table.headings.join(' > ').replace(/\s+/g, ' ').trim() || 'unheaded';
  return `page:${table.page}/table:${heading}/row:${row.rowIndex}/${suffix}`;
}

export function assertHacdTableBinding(
  table: CongressionalTableV1,
  profile: DefenseBudgetStageSourceProfileV1,
  source: ExtractionSourceV1,
): void {
  if (table.profileId !== profile.profileId) throw new Error('HAC-D table profileId mismatch');
  if (table.sourceSha256 !== source.sourcePdfSha256) {
    throw new Error('HAC-D table source SHA mismatch');
  }
  if (table.sourceDocumentId !== (source.sourceDocumentId ?? source.manifestDocumentKey)) {
    throw new Error('HAC-D table sourceDocumentId mismatch');
  }
}

export function hacdAccountKey(row: CongressionalRowV1): string | null {
  if (row.reference.referenceKind === 'procurement_line') return row.reference.account ?? null;
  if (row.reference.referenceKind === 'om_sag') return row.reference.account ?? null;
  if (row.reference.referenceKind === 'package_scope') return row.reference.scope;
  return null;
}

export function hacdIsClassified(row: CongressionalRowV1, table: CongressionalTableV1): boolean {
  const text = `${row.rawLabel} ${table.headings.join(' ')}`.toLowerCase();
  return row.reference.referenceKind === 'package_scope' && text.includes('classified');
}
