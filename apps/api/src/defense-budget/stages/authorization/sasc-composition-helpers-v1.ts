import { parseCanonicalDecimalString } from '../../contracts/decimal-string.js';
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';
import {
  composeDuplicateRowsV1,
  type CongressionalRowV1,
  type CongressionalTableV1,
  type RowMoneyV1,
} from '../congressional-table-v1.js';
import type { DefenseBudgetStageSourceProfileV1 } from '../stage-source-profile-v1.js';
import type { CommitteeStageActionTypeV1 } from './committee-stage-facts-v1.js';
import { SASC_TABLE_COMPOSITION_POLICY_V1 } from './sasc-source-profile-v1.js';

export function sascDuplicateDisposition(table: CongressionalTableV1): {
  conflicts: Set<number>;
  secondary: Set<number>;
  groups: Map<number, CongressionalRowV1[]>;
} {
  const conflicts = new Set<number>();
  const secondary = new Set<number>();
  const groups = new Map<number, CongressionalRowV1[]>();
  for (const group of composeDuplicateRowsV1(table, SASC_TABLE_COMPOSITION_POLICY_V1)) {
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

export function sascActionMoney(values: RowMoneyV1[]): RowMoneyV1 | undefined {
  return (
    values.find((item) => item.semantic === 'change') ??
    values.find((item) => item.semantic === 'transfer_amount') ??
    values.find((item) => item.semantic === 'rescission_amount')
  );
}

export function sascActionType(
  row: CongressionalRowV1,
  value: string,
): CommitteeStageActionTypeV1 {
  if (row.semanticKind === 'transfer_in') return 'transfer_in';
  if (row.semanticKind === 'transfer_out') return 'transfer_out';
  if (row.semanticKind === 'rescission') return 'rescission';
  if (row.semanticKind === 'undistributed') return 'undistributed_adjustment';
  if (row.semanticKind === 'general_provision') return 'general_provision';
  return value.startsWith('-') ? 'decrease' : 'increase';
}

export function sascSignedValue(type: CommitteeStageActionTypeV1, value: string): string {
  const canonical = parseCanonicalDecimalString(value);
  const magnitude = canonical.startsWith('-') ? canonical.slice(1) : canonical;
  if (magnitude === '0') return '0';
  return ['decrease', 'transfer_out', 'rescission'].includes(type)
    ? `-${magnitude}`
    : magnitude;
}

export function sascFiscalYear(table: CongressionalTableV1): number {
  const values = [
    ...new Set(
      table.columns.flatMap((column) =>
        column.fiscalYear == null ? [] : [column.fiscalYear],
      ),
    ),
  ];
  if (values.length !== 1) {
    throw new Error('SASC row requires one unambiguous fiscal year');
  }
  return values[0]!;
}

export function isSascPackageAction(row: CongressionalRowV1): boolean {
  return (
    ['general_provision', 'undistributed'].includes(row.semanticKind) &&
    row.reference.referenceKind === 'package_scope'
  );
}

export function sascTableKey(table: CongressionalTableV1): {
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

export function sascSourcePath(
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  suffix: string,
): string {
  const heading = table.headings.join(' > ').replace(/\s+/g, ' ').trim() || 'unheaded';
  return `page:${table.page}/table:${heading}/row:${row.rowIndex}/${suffix}`;
}

export function assertSascTableBinding(
  table: CongressionalTableV1,
  profile: DefenseBudgetStageSourceProfileV1,
  source: ExtractionSourceV1,
): void {
  if (table.profileId !== profile.profileId) {
    throw new Error('SASC table profileId mismatch');
  }
  if (table.sourceSha256 !== source.sourcePdfSha256) {
    throw new Error('SASC table source SHA mismatch');
  }
  if (table.sourceDocumentId !== (source.sourceDocumentId ?? source.manifestDocumentKey)) {
    throw new Error('SASC table sourceDocumentId mismatch');
  }
}
