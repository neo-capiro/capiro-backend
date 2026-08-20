/**
 * Parser → structural-validation adapter (Phase 0 containment).
 *
 * Maps an existing ExtractionResult (+ classification / caller-supplied archive and
 * parse proof) into the BudgetDocument shape consumed by verifyBudgetDocument.
 *
 * Boundaries:
 * - No DB, S3, LlamaParse, or canonical PE-year writes.
 * - Records every dropped money assertion and parser warning in ExtractionDiagnostics;
 *   the verifier fails closed on them instead of silently validating an empty candidate.
 * - Emits page_only evidence with no fabricated bounding box; real cell geometry is
 *   used only if the extractor provenance ever supplies it.
 * - Extraction method is mapped one-to-one and never relabeled.
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
  ExtractionDiagnostics,
  VerificationField,
} from './budget-verification.js';

/** Extractor field names → structural-validation / PE-year field keys (mirrors assertion-mapper). */
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

const VALID_UNITS = new Set(['dollars', 'thousands', 'millions']);

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

/** Document-level line identity from classifier exhibit; procurement/O&M stay separate. */
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

/** One-to-one provenance mapping. pdfplumber is never relabeled. */
function mapExtractionMethod(
  method: YearValueAssertion['provenance']['extractionMethod'],
): BudgetEvidence['extractionMethod'] {
  switch (method) {
    case 'llamaparse':
      return 'llamaparse';
    case 'deterministic_pdfplumber':
      return 'deterministic_pdfplumber';
    case 'manual':
      return 'manual';
    default:
      return 'manual';
  }
}

type DropReason = ExtractionDiagnostics['droppedMoneyAssertions'][number]['reason'];

function dropReason(value: YearValueAssertion): DropReason | null {
  if (FIELD_MAP[value.fieldName] == null) return 'unsupported_field';
  if (value.money == null) return 'missing_money';
  if (!VALID_UNITS.has(value.money.unit)) return 'unsupported_unit';
  if (!Number.isFinite(value.money.value)) return 'non_finite_value';
  return null;
}

/** Build diagnostics from the complete extraction, recording every dropped money assertion. */
export function buildExtractionDiagnostics(extraction: ExtractionResult): ExtractionDiagnostics {
  const dropped: ExtractionDiagnostics['droppedMoneyAssertions'] = [];
  let sourceMoneyAssertionCount = 0;
  let acceptedMoneyAssertionCount = 0;
  for (const [index, value] of extraction.yearValues.entries()) {
    if (value.money != null) sourceMoneyAssertionCount += 1;
    const reason = dropReason(value);
    if (reason) {
      // Record dropped money assertions (money present but unusable) AND money-less
      // rows only when they carried a recognizable field — unsupported_field covers both.
      if (value.money != null || reason === 'unsupported_field' || reason === 'missing_money') {
        dropped.push({
          index,
          code: value.code,
          fiscalYear: value.fy,
          fieldName: value.fieldName,
          reason,
        });
      }
      continue;
    }
    acceptedMoneyAssertionCount += 1;
  }
  return {
    sourceYearValueCount: extraction.yearValues.length,
    sourceMoneyAssertionCount,
    acceptedMoneyAssertionCount,
    droppedMoneyAssertions: dropped,
    parserWarnings: [...extraction.warnings],
  };
}

/**
 * Page-level evidence. The current ValueProvenance carries no geometry, so granularity
 * is always page_only with no bounding box; invalid pages are passed through unchanged
 * so the verifier's evidence check rejects them instead of coercing to page 1.
 */
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
    page,
    granularity: 'page_only',
    extractionMethod,
    rowIndex,
    columnIndex,
    excerpt,
  };
}

interface AcceptedMoney {
  index: number;
  value: YearValueAssertion;
  field: VerificationField;
  unit: 'dollars' | 'thousands' | 'millions';
}

function moneyValues(values: YearValueAssertion[]): AcceptedMoney[] {
  const out: AcceptedMoney[] = [];
  for (const [index, value] of values.entries()) {
    if (dropReason(value) != null) continue;
    out.push({
      index,
      value,
      field: FIELD_MAP[value.fieldName]!,
      unit: value.money!.unit as AcceptedMoney['unit'],
    });
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
  const first = input.extraction.yearValues[0]?.provenance;
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
    extractionDiagnostics: buildExtractionDiagnostics(input.extraction),
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
