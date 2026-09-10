/** Reconstruct the exact R-2/R-2A reconciliation inputs from a persisted artifact. */
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import type { MoneyUnitV1 } from '../../contracts/decimal-string.js';
import type { RdteColumnRoleV1, RdteValueDispositionV1 } from '../rdte-column-role-v1.js';
import type { R2PeTotalCell } from '../r2a/r2a-project-reconciler.js';
import type {
  R2aProjectFundingValue,
  R2aRowKindV1,
} from '../r2a/r2a-project-funding-extractor-v1.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`persisted ${label} is missing`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`persisted ${label} is missing`);
  return value;
}

function evidenceLocation(
  artifact: DefenseBudgetExtractionArtifactV1,
  evidenceIds: readonly string[],
): { page: number; printedPage?: string; tableIndex: number; rowIndex: number; columnIndex: number; headerText: string } {
  const evidence = artifact.evidence.find((candidate) => evidenceIds.includes(candidate.evidenceId));
  if (evidence == null) throw new Error(`persisted funding assertion has no resolvable evidence`);
  const tableIndex = Number(/^table_(\d+)$/.exec(evidence.tableLabel ?? '')?.[1]);
  const rowIndex = Number(/^row_(\d+)$/.exec(evidence.rowLabel ?? '')?.[1]);
  const fact = artifact.sourceFacts.find((candidate) =>
    candidate.evidenceIds.some((id) => evidenceIds.includes(id)),
  );
  const sourcePosition = /\/page:(\d+)\/row:(\d+)\/col:(\d+)$/.exec(fact?.sourcePath ?? '');
  const columnIndex = Number(sourcePosition?.[3]);
  return {
    page: requiredNumber(evidence.page, 'funding evidence page'),
    ...(evidence.printedPage != null ? { printedPage: evidence.printedPage } : {}),
    tableIndex: Number.isInteger(tableIndex) ? tableIndex : 0,
    rowIndex: Number.isInteger(rowIndex) ? rowIndex : 0,
    columnIndex: Number.isInteger(columnIndex) ? columnIndex : 0,
    headerText: evidence.columnLabel ?? '',
  };
}

function locationFromMetadata(metadata: JsonRecord, fallback: ReturnType<typeof evidenceLocation>) {
  return {
    page: typeof metadata.physicalPage === 'number' ? metadata.physicalPage : fallback.page,
    ...(typeof metadata.printedPage === 'string'
      ? { printedPage: metadata.printedPage }
      : fallback.printedPage != null
        ? { printedPage: fallback.printedPage }
        : {}),
    tableIndex: typeof metadata.tableIndex === 'number' ? metadata.tableIndex : fallback.tableIndex,
    rowIndex: typeof metadata.rowIndex === 'number' ? metadata.rowIndex : fallback.rowIndex,
    columnIndex: typeof metadata.columnIndex === 'number' ? metadata.columnIndex : fallback.columnIndex,
    headerText: typeof metadata.headerText === 'string' ? metadata.headerText : fallback.headerText,
  };
}

export function reconstructR2PeTotalCellsFromArtifact(
  artifact: DefenseBudgetExtractionArtifactV1,
): R2PeTotalCell[] {
  return artifact.assertions.flatMap((assertion) => {
    if (assertion.assertionKind !== 'funding' && assertion.assertionKind !== 'document_fact') return [];
    const value = assertion.assertionKind === 'document_fact' ? record(assertion.value) : null;
    const metadata = record(assertion.metadata) ?? value;
    if (metadata?.rowKind !== 'pe_total' || (assertion.assertionKind === 'document_fact' && !assertion.fieldName.startsWith('r2_'))) return [];
    const fallback = evidenceLocation(artifact, assertion.evidenceIds);
    const location = locationFromMetadata(metadata, fallback);
    const identity = assertion.assertionKind === 'funding'
      ? assertion.identity.lineKind === 'RDTE_PE' ? assertion.identity.peCode : null
      : value?.peCode;
    const fiscalYear = assertion.assertionKind === 'funding' ? assertion.fiscalYear : value?.fiscalYear;
    const originalValue = assertion.assertionKind === 'funding' ? assertion.money.originalValue : value?.originalValue;
    const originalUnit = assertion.assertionKind === 'funding' ? assertion.money.originalUnit : value?.originalUnit;
    return [{
      peCode: requiredString(identity, 'R-2 PE code'),
      fiscalYear: requiredNumber(fiscalYear, 'R-2 fiscal year'),
      columnRole: requiredString(metadata.columnRole, 'R-2 column role') as RdteColumnRoleV1,
      printedTotal: requiredString(originalValue, 'R-2 printed total'),
      unit: requiredString(originalUnit, 'R-2 unit') as MoneyUnitV1,
      page: location.page,
      ...(location.printedPage != null ? { printedPage: location.printedPage } : {}),
      rowIndex: location.rowIndex,
      columnIndex: location.columnIndex,
    }];
  });
}

export function reconstructR2aProjectFundingValuesFromArtifact(
  artifact: DefenseBudgetExtractionArtifactV1,
): R2aProjectFundingValue[] {
  return artifact.assertions.flatMap((assertion) => {
    if (assertion.assertionKind !== 'project_funding') return [];
    const metadata = record(assertion.metadata) ?? {};
    if (metadata.exhibit !== 'R-2A') return [];
    const location = locationFromMetadata(metadata, evidenceLocation(artifact, assertion.evidenceIds));
    return [{
      parentPeCode: assertion.parentPeCode,
      projectCode: assertion.projectCode,
      rowKind: requiredString(metadata.rowKind, 'R-2A row kind') as R2aRowKindV1,
      fiscalYear: assertion.fiscalYear,
      columnRole: requiredString(metadata.columnRole, 'R-2A column role') as RdteColumnRoleV1,
      disposition: requiredString(metadata.disposition, 'R-2A disposition') as RdteValueDispositionV1,
      originalValue: assertion.money.originalValue,
      originalUnit: assertion.money.originalUnit as MoneyUnitV1,
      valueMillions: assertion.money.valueMillions,
      page: location.page,
      ...(location.printedPage != null ? { printedPage: location.printedPage } : {}),
      tableIndex: location.tableIndex,
      rowIndex: location.rowIndex,
      columnIndex: location.columnIndex,
      headerText: location.headerText,
      direct: metadata.direct === true,
      positionCycle: requiredString(metadata.positionCycle, 'R-2A position cycle'),
    }];
  });
}
