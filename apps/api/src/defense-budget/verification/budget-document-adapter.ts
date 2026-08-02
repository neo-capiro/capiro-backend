/**
 * Parser → verification adapter.
 *
 * Maps existing LlamaParse ExtractionResult (+ classification / archive / parse proof)
 * into the pure BudgetDocument shape consumed by verifyBudgetDocument.
 *
 * Boundaries:
 * - No DB, S3, LlamaParse, or canonical PE-year writes.
 * - Preserves original money unit + value; normalization stays in the verifier.
 * - Field names accept extractor vocabulary (hacdMark) and canonical PE keys (hacDMark).
 * - Bounding boxes are page-level placeholders until extractor provenance carries real boxes.
 */
import type {
  LineKind,
  ExtractionResult,
  LineAssertion,
  YearValueAssertion,
} from '../extractors/types.js';
import type { DocClassification } from '../document-classifier.js';
import type {
  BudgetCell,
  BudgetColumn,
  BudgetDocument,
  BudgetEvidence,
  BudgetRow,
  BudgetSourceAuthority,
  VerificationField,
} from './budget-verification.js';

/** Extractor field names → verification / PE-year field keys (mirrors assertion-mapper). */
const FIELD_MAP: Record<string, VerificationField> = {
  request: 'request',
  hascMark: 'hascMark',
  sascMark: 'sascMark',
  hacdMark: 'hacDMark',
  hacDMark: 'hacDMark',
  sacdMark: 'sacDMark',
  sacDMark: 'sacDMark',
  ndaaConference: 'ndaaConference',
  conference: 'conference',
  enacted: 'enacted',
  reprogrammed: 'reprogrammed',
  executed: 'executed',
};

const SOURCE_AUTHORITIES = new Set<BudgetSourceAuthority>([
  'manual_override',
  'presidents_budget_request',
  'hasc_authorization',
  'sasc_authorization',
  'hacd_appropriations',
  'sacd_appropriations',
  'ndaa_conference',
  'appropriations_conference',
  'enacted_public_law',
  'reprogramming',
  'execution',
  'fixture',
  'unknown',
]);

/** Page-level placeholder until ValueProvenance carries real geometry. */
const PAGE_PLACEHOLDER_BBOX = { left: 0, top: 0, right: 1, bottom: 1 } as const;

function sourceAuthority(classification: DocClassification): BudgetSourceAuthority {
  switch (classification.authority) {
    case 'dod-comptroller':
      return 'presidents_budget_request';
    case 'hasc':
      return 'hasc_authorization';
    case 'sasc':
      return 'sasc_authorization';
    case 'hac_d':
      return 'hacd_appropriations';
    case 'sac_d':
      return 'sacd_appropriations';
    case 'ndaa_conference':
      return 'ndaa_conference';
    case 'public_law':
      return 'enacted_public_law';
    default:
      return SOURCE_AUTHORITIES.has(classification.authority as BudgetSourceAuthority)
        ? (classification.authority as BudgetSourceAuthority)
        : 'unknown';
  }
}

/**
 * Document-level line identity from classifier exhibit.
 * Committee/conference/public-law PE marks are RDTE_PE; procurement/O&M stay separate.
 */
export function sourceLineKindFromClassification(classification: DocClassification): LineKind {
  switch (classification.exhibit) {
    case 'R-2':
      return 'RDTE_PE';
    case 'P-40':
      return 'PROCUREMENT_BLIN';
    case 'OP-5':
      return 'OM_SAG';
    case 'committee_report':
    case 'conference_report':
    case 'public_law':
      return 'RDTE_PE';
    default:
      return 'UNKNOWN';
  }
}

function mapExtractionMethod(
  method: YearValueAssertion['provenance']['extractionMethod'],
): BudgetEvidence['extractionMethod'] {
  // Verifier rejects pdfplumber as a primary money path; never label it llamaparse.
  if (method === 'llamaparse') return 'llamaparse';
  return 'manual';
}

function fieldFor(value: YearValueAssertion): VerificationField | null {
  return FIELD_MAP[value.fieldName] ?? null;
}

function unitFor(value: YearValueAssertion): 'dollars' | 'thousands' | 'millions' | null {
  if (value.money == null) return null;
  const unit = value.money.unit;
  if (unit === 'dollars' || unit === 'thousands' || unit === 'millions') return unit;
  return null;
}

function evidence(
  sourceDocumentId: string,
  sourceSha256: string,
  page: number,
  extractionMethod: BudgetEvidence['extractionMethod'],
  rowIndex?: number,
  columnIndex?: number,
  excerpt?: string,
): BudgetEvidence {
  return {
    sourceDocumentId,
    sourceSha256,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    boundingBox: { ...PAGE_PLACEHOLDER_BBOX },
    extractionMethod,
    rowIndex,
    columnIndex,
    excerpt,
  };
}

function moneyValues(values: YearValueAssertion[]): Array<{
  index: number;
  value: YearValueAssertion;
  field: VerificationField;
  unit: 'dollars' | 'thousands' | 'millions';
}> {
  const out: Array<{
    index: number;
    value: YearValueAssertion;
    field: VerificationField;
    unit: 'dollars' | 'thousands' | 'millions';
  }> = [];
  for (const [index, value] of values.entries()) {
    const field = fieldFor(value);
    const unit = unitFor(value);
    if (!field || unit == null || value.money == null) continue;
    if (!Number.isFinite(value.money.value)) continue;
    out.push({ index, value, field, unit });
  }
  return out;
}

function buildColumns(
  values: YearValueAssertion[],
  sourceDocumentId: string,
  sourceSha256: string,
): BudgetColumn[] {
  const columns = new Map<string, BudgetColumn>();
  for (const { index, value, field, unit } of moneyValues(values)) {
    const key = `${value.fy}-${field}`;
    if (columns.has(key)) continue;
    columns.set(key, {
      key,
      fiscalYear: value.fy,
      field,
      label: value.provenance.colLabel?.trim() || `${value.fy} ${field}`,
      unit,
      evidence: evidence(
        sourceDocumentId,
        sourceSha256,
        value.provenance.pdfPage,
        mapExtractionMethod(value.provenance.extractionMethod),
        index,
        undefined,
        value.provenance.rowLabel,
      ),
    });
  }
  return [...columns.values()];
}

function buildRows(
  values: YearValueAssertion[],
  lines: LineAssertion[],
  sourceDocumentId: string,
  sourceSha256: string,
): BudgetRow[] {
  const titleByCode = new Map(lines.map((line) => [line.code, line.title]));
  const rows = new Map<string, BudgetRow>();

  for (const { index, value, field, unit } of moneyValues(values)) {
    const rowId = `${value.lineKind}:${value.code}:${value.fy}`;
    const cellId = `${rowId}:${field}`;
    const cellEvidence = evidence(
      sourceDocumentId,
      sourceSha256,
      value.provenance.pdfPage,
      mapExtractionMethod(value.provenance.extractionMethod),
      index,
      undefined,
      value.provenance.rowLabel,
    );
    const cell: BudgetCell = {
      id: cellId,
      columnKey: `${value.fy}-${field}`,
      lineKind: value.lineKind,
      code: value.code,
      fiscalYear: value.fy,
      field,
      rawValue: value.money!.value,
      unit,
      evidence: cellEvidence,
    };

    const existing = rows.get(rowId);
    if (existing) {
      existing.cells.push(cell);
      continue;
    }

    rows.set(rowId, {
      id: rowId,
      kind: 'line',
      lineKind: value.lineKind,
      code: value.code,
      title: titleByCode.get(value.code),
      evidence: cellEvidence,
      cells: [cell],
    });
  }

  return [...rows.values()];
}

export function buildBudgetDocumentFromExtraction(input: {
  classification: DocClassification;
  extraction: ExtractionResult;
  sourceDocumentId: string;
  sourceSha256: string;
  archive: { bucket: string; key: string; versionId: string; sha256: string };
  parse: {
    id: string;
    provider: 'llamaparse';
    status: 'succeeded';
    inputSha256: string;
    outputJsonKey?: string;
  };
}): BudgetDocument {
  const first = moneyValues(input.extraction.yearValues)[0]?.value.provenance;
  const documentEvidence = evidence(
    input.sourceDocumentId,
    input.sourceSha256,
    first?.pdfPage ?? 1,
    first ? mapExtractionMethod(first.extractionMethod) : 'manual',
  );

  return {
    sourceDocumentId: input.sourceDocumentId,
    sourceSha256: input.sourceSha256,
    archiveProof: input.archive,
    parseProof: input.parse,
    documentId: input.classification.sourceKey,
    fiscalYear: input.classification.fiscalYear ?? 0,
    sourceAuthority: sourceAuthority(input.classification),
    sourceLineKind: sourceLineKindFromClassification(input.classification),
    evidence: documentEvidence,
    columns: buildColumns(input.extraction.yearValues, input.sourceDocumentId, input.sourceSha256),
    rows: buildRows(
      input.extraction.yearValues,
      input.extraction.lineAssertions,
      input.sourceDocumentId,
      input.sourceSha256,
    ),
  };
}

/** Convenience wrapper when the caller only has a DocumentParseJob id + optional derived key. */
export function buildBudgetDocumentFromMappedExtraction(input: {
  classification: DocClassification;
  extraction: ExtractionResult;
  sourceDocumentId: string;
  sourceSha256: string;
  archive: { bucket: string; key: string; versionId: string; sha256: string };
  parseJobId: string;
  outputJsonS3Key?: string;
}): BudgetDocument {
  return buildBudgetDocumentFromExtraction({
    classification: input.classification,
    extraction: input.extraction,
    sourceDocumentId: input.sourceDocumentId,
    sourceSha256: input.sourceSha256,
    archive: input.archive,
    parse: {
      id: input.parseJobId,
      provider: 'llamaparse',
      status: 'succeeded',
      inputSha256: input.sourceSha256,
      outputJsonKey: input.outputJsonS3Key,
    },
  });
}

export function evidenceForAssertion(
  value: YearValueAssertion,
  sourceDocumentId: string,
  sourceSha256: string,
): BudgetEvidence {
  return evidence(
    sourceDocumentId,
    sourceSha256,
    value.provenance.pdfPage,
    mapExtractionMethod(value.provenance.extractionMethod),
    undefined,
    undefined,
    value.provenance.rowLabel,
  );
}
