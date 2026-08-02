import { isValidPeCode, type LineKind } from '../extractors/types.js';
import { normalizeMoneyToMillions, type MoneyUnit } from '@capiro/shared/money';

/** Verification lifecycle proposed by the PE closeout handoff. */
export type VerificationStatus =
  | 'EXTRACTED'
  | 'VALIDATING'
  | 'VERIFIED_AUTOMATIC'
  | 'VERIFIED_REVIEWED'
  | 'NEEDS_REVIEW'
  | 'REJECTED'
  | 'CANONICAL'
  | 'SUPERSEDED';

/** A route is a recommendation only; this module never calls a paid provider. */
export type VerificationRoute =
  | 'automatic'
  | 'targeted_local_reextraction'
  | 'paid_page_verifier'
  | 'human_review'
  | 'none';

export type VerificationField =
  | 'request'
  | 'hascMark'
  | 'sascMark'
  | 'hacDMark'
  | 'sacDMark'
  | 'ndaaConference'
  | 'conference'
  | 'enacted'
  | 'reprogrammed'
  | 'executed';

export type BudgetSourceAuthority =
  | 'manual_override'
  | 'presidents_budget_request'
  | 'hasc_authorization'
  | 'sasc_authorization'
  | 'hacd_appropriations'
  | 'sacd_appropriations'
  | 'ndaa_conference'
  | 'appropriations_conference'
  | 'enacted_public_law'
  | 'reprogramming'
  | 'execution'
  | 'fixture'
  | 'unknown';

export interface BoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Evidence is immutable-source evidence, not merely a parser confidence score. */
export interface BudgetEvidence {
  sourceDocumentId: string;
  sourceSha256: string;
  page: number;
  boundingBox: BoundingBox;
  rowIndex?: number;
  columnIndex?: number;
  excerpt?: string;
  extractionMethod: 'llamaparse' | 'targeted_local_reextraction' | 'paid_page_verifier' | 'manual';
}

export type BudgetRowKind = 'header' | 'line' | 'continuation' | 'subtotal' | 'total';

export interface BudgetColumn {
  key: string;
  fiscalYear: number;
  field: VerificationField;
  label: string;
  unit: MoneyUnit;
  evidence: BudgetEvidence;
}

export interface BudgetCell {
  id: string;
  columnKey: string;
  lineKind: LineKind;
  code: string;
  fiscalYear: number;
  field: VerificationField;
  rawValue: number;
  unit: MoneyUnit;
  evidence: BudgetEvidence;
}

export interface BudgetRow {
  id: string;
  kind: BudgetRowKind;
  lineKind: LineKind;
  code?: string;
  title?: string;
  groupKey?: string;
  continuationOf?: string;
  /** Explicit arithmetic children; totals are never inferred from titles. */
  totalOfRowIds?: string[];
  evidence: BudgetEvidence;
  cells: BudgetCell[];
}

export interface ArchiveProof {
  bucket: string;
  key: string;
  versionId: string;
  sha256: string;
}

export interface ParseProof {
  id: string;
  provider: 'llamaparse';
  status: 'succeeded';
  inputSha256: string;
  outputJsonKey?: string;
}

export interface BudgetDocument {
  sourceDocumentId: string;
  sourceSha256: string;
  archiveProof: ArchiveProof;
  parseProof: ParseProof;
  documentId: string;
  fiscalYear: number;
  sourceAuthority: BudgetSourceAuthority;
  sourceLineKind: LineKind;
  evidence: BudgetEvidence;
  columns: BudgetColumn[];
  rows: BudgetRow[];
  /** Optional deterministic controls supplied by a separate corpus/reconciliation query. */
  comparisons?: BudgetComparison[];
}

export interface BudgetComparison {
  id: string;
  kind: 'cross_document' | 'historical';
  candidate: {
    code: string;
    fiscalYear: number;
    field: VerificationField;
  };
  referenceValueMillions: number;
  /** Absolute tolerance in canonical USD millions. */
  toleranceMillions: number;
  evidence: BudgetEvidence;
  description: string;
}

export type VerificationCheckCode =
  | 'source_sha256'
  | 'source_evidence'
  | 'archive_proof'
  | 'parse_proof'
  | 'schema_identifiers'
  | 'fiscal_year_columns'
  | 'field_ownership'
  | 'numeric_units'
  | 'duplicate_cells'
  | 'repeated_headers'
  | 'continuation_links'
  | 'arithmetic_reconciliation'
  | 'cross_document_reconciliation'
  | 'historical_consistency';

export interface VerificationCheck {
  code: VerificationCheckCode;
  passed: boolean;
  blocking: boolean;
  riskPoints: number;
  message: string;
  evidence: BudgetEvidence[];
  details?: Record<string, unknown>;
}

export interface NormalizedBudgetRecord {
  rowId: string;
  cellId: string;
  peCode: string;
  lineKind: LineKind;
  fy: number;
  field: VerificationField;
  originalValue: number;
  originalUnit: MoneyUnit;
  valueMillions: number;
  sourceDocumentId: string;
  sourceSha256: string;
  sourcePage: number;
  boundingBox: BoundingBox;
  evidence: BudgetEvidence;
}

export interface VerificationPolicy {
  /** Scores at or below this threshold are automatically verified. */
  automaticRiskMax: number;
  /** Scores above automatic and at or below this threshold get targeted extraction. */
  targetedReextractionRiskMax: number;
  /** Scores above targeted and at or below this threshold get paid page verification. */
  paidVerifierRiskMax: number;
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  automaticRiskMax: 10,
  targetedReextractionRiskMax: 30,
  paidVerifierRiskMax: 60,
};

export interface VerificationOptions {
  policy?: Partial<VerificationPolicy>;
  /** Exact operator approval is deliberately separate from verification status. */
  approvedSha256?: string;
}

export interface BudgetVerificationResult {
  status: VerificationStatus;
  route: VerificationRoute;
  riskScore: number;
  checks: VerificationCheck[];
  normalizedRecords: NormalizedBudgetRecord[];
  blockingFailures: VerificationCheck[];
  /** Status eligibility only; this is not an instruction to write canonical data. */
  canonicalEligible: boolean;
  /** Exact-SHA gate + verification status, for a future writer to consume. */
  promotionReady: boolean;
  sourceSha256: string;
  sourceDocumentId: string;
}

export interface BudgetVerificationRun {
  runId: string;
  candidateId: string;
  status: VerificationStatus;
  route: VerificationRoute;
  riskScore: number;
  startedAt: string;
  completedAt: string;
  checks: VerificationCheck[];
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const VALID_UNITS = new Set<MoneyUnit>(['dollars', 'thousands', 'millions']);
const MAX_SAFE_RISK = 100;

const FIELD_AUTHORITIES: Record<VerificationField, readonly BudgetSourceAuthority[]> = {
  request: ['manual_override', 'presidents_budget_request'],
  hascMark: ['manual_override', 'hasc_authorization'],
  sascMark: ['manual_override', 'sasc_authorization'],
  hacDMark: ['manual_override', 'hacd_appropriations'],
  sacDMark: ['manual_override', 'sacd_appropriations'],
  ndaaConference: ['manual_override', 'ndaa_conference'],
  conference: ['manual_override', 'appropriations_conference'],
  enacted: ['manual_override', 'enacted_public_law'],
  reprogrammed: ['manual_override', 'reprogramming'],
  executed: ['manual_override', 'execution'],
};

function check(
  code: VerificationCheckCode,
  passed: boolean,
  blocking: boolean,
  riskPoints: number,
  message: string,
  evidence: BudgetEvidence[],
  details?: Record<string, unknown>,
): VerificationCheck {
  return {
    code,
    passed,
    blocking,
    riskPoints: passed ? 0 : riskPoints,
    message,
    evidence,
    details,
  };
}

function allEvidence(document: BudgetDocument): BudgetEvidence[] {
  return [
    document.evidence,
    ...document.columns.map((column) => column.evidence),
    ...document.rows.flatMap((row) => [row.evidence, ...row.cells.map((cell) => cell.evidence)]),
    ...(document.comparisons ?? []).map((comparison) => comparison.evidence),
  ];
}

function boundedRisk(checks: VerificationCheck[]): number {
  return Math.min(
    MAX_SAFE_RISK,
    checks.filter((item) => !item.passed).reduce((sum, item) => sum + item.riskPoints, 0),
  );
}

function isValidBoundingBox(box: BoundingBox): boolean {
  return (
    [box.left, box.top, box.right, box.bottom].every(Number.isFinite) &&
    box.left >= 0 &&
    box.top >= 0 &&
    box.right >= box.left &&
    box.bottom >= box.top
  );
}

function evidenceIsValid(document: BudgetDocument, evidence: BudgetEvidence): boolean {
  return (
    evidence.sourceDocumentId === document.sourceDocumentId &&
    evidence.sourceSha256 === document.sourceSha256 &&
    Number.isInteger(evidence.page) &&
    evidence.page >= 1 &&
    isValidBoundingBox(evidence.boundingBox) &&
    evidence.extractionMethod !== ('pdfplumber' as BudgetEvidence['extractionMethod'])
  );
}

function archiveProofIsValid(document: BudgetDocument): boolean {
  const proof = document.archiveProof;
  return Boolean(
    proof.bucket.trim() &&
    proof.key.trim() &&
    proof.versionId.trim() &&
    SHA256_RE.test(proof.sha256) &&
    proof.sha256 === document.sourceSha256,
  );
}

function parseProofIsValid(document: BudgetDocument): boolean {
  const proof = document.parseProof;
  return Boolean(
    proof.id.trim() &&
    proof.provider === 'llamaparse' &&
    proof.status === 'succeeded' &&
    proof.inputSha256 === document.sourceSha256 &&
    (!proof.outputJsonKey || proof.outputJsonKey.trim()),
  );
}

function checkEvidence(document: BudgetDocument): BudgetEvidence[] {
  const evidence = document.rows.flatMap((row) => [
    row.evidence,
    ...row.cells.map((cell) => cell.evidence),
  ]);
  return evidence.length > 0 ? evidence : [document.evidence];
}

function isCandidateRow(row: BudgetRow): boolean {
  return row.kind === 'line' || row.kind === 'continuation';
}

function normalizedCellValue(cell: BudgetCell): number | null {
  if (!Number.isFinite(cell.rawValue) || !VALID_UNITS.has(cell.unit)) return null;
  return normalizeMoneyToMillions(cell.rawValue, cell.unit).valueM;
}

function sameNaturalKey(left: BudgetCell, right: BudgetCell): boolean {
  return (
    left.lineKind === right.lineKind &&
    left.code === right.code &&
    left.fiscalYear === right.fiscalYear &&
    left.field === right.field
  );
}

function normalizeCell(
  document: BudgetDocument,
  row: BudgetRow,
  cell: BudgetCell,
): NormalizedBudgetRecord {
  const normalized = normalizeMoneyToMillions(cell.rawValue, cell.unit);
  return {
    rowId: row.id,
    cellId: cell.id,
    peCode: cell.code,
    lineKind: cell.lineKind,
    fy: cell.fiscalYear,
    field: cell.field,
    originalValue: normalized.originalValue,
    originalUnit: normalized.originalUnit,
    valueMillions: normalized.valueM,
    sourceDocumentId: document.sourceDocumentId,
    sourceSha256: document.sourceSha256,
    sourcePage: cell.evidence.page,
    boundingBox: cell.evidence.boundingBox,
    evidence: cell.evidence,
  };
}

function runChecks(document: BudgetDocument): VerificationCheck[] {
  const sourceEvidence = allEvidence(document);
  const checks: VerificationCheck[] = [];

  checks.push(
    check(
      'source_sha256',
      SHA256_RE.test(document.sourceSha256),
      true,
      100,
      SHA256_RE.test(document.sourceSha256)
        ? 'Source SHA-256 is an exact lowercase 64-character digest.'
        : 'Source SHA-256 is missing or malformed; exact-SHA promotion is blocked.',
      [document.evidence],
    ),
  );

  const invalidEvidence = sourceEvidence.filter((item) => !evidenceIsValid(document, item));
  const candidateEvidence = document.rows.flatMap((row) => row.cells.map((cell) => cell.evidence));
  checks.push(
    check(
      'source_evidence',
      invalidEvidence.length === 0 && sourceEvidence.length > 0,
      true,
      100,
      invalidEvidence.length === 0 && sourceEvidence.length > 0
        ? 'Every candidate/check source reference has matching document identity, SHA, page, bounding box, and an allowed extraction method.'
        : `${invalidEvidence.length} source reference(s) do not carry valid exact-SHA page/bounding-box evidence.`,
      invalidEvidence.length > 0
        ? invalidEvidence
        : candidateEvidence.length > 0
          ? candidateEvidence
          : [document.evidence],
      { invalidEvidenceCount: invalidEvidence.length },
    ),
  );

  checks.push(
    check(
      'archive_proof',
      archiveProofIsValid(document),
      true,
      100,
      archiveProofIsValid(document)
        ? 'The exact source SHA is linked to an immutable archived object version.'
        : 'Immutable source archive proof is incomplete or does not match the candidate SHA.',
      checkEvidence(document),
      { archive: document.archiveProof },
    ),
  );

  checks.push(
    check(
      'parse_proof',
      parseProofIsValid(document),
      true,
      100,
      parseProofIsValid(document)
        ? 'A succeeded LlamaParse job is linked to the exact source SHA.'
        : 'A succeeded exact-SHA LlamaParse parse proof is required before verification.',
      checkEvidence(document),
      { parse: document.parseProof },
    ),
  );

  const identifierFailures: string[] = [];
  const identifierEvidence: BudgetEvidence[] = [];
  for (const row of document.rows) {
    if (row.kind === 'line' && !row.code) {
      identifierFailures.push(`row ${row.id} has no identifier`);
      identifierEvidence.push(row.evidence);
    }
    if (isCandidateRow(row) && document.sourceLineKind !== row.lineKind) {
      identifierFailures.push(
        `row ${row.id} line kind ${row.lineKind} differs from document ${document.sourceLineKind}`,
      );
      identifierEvidence.push(row.evidence);
    }
    if (isCandidateRow(row) && row.lineKind === 'RDTE_PE' && row.code && !isValidPeCode(row.code)) {
      identifierFailures.push(`row ${row.id} has invalid PE code ${row.code}`);
      identifierEvidence.push(row.evidence);
    }
    if (row.kind === 'header') continue;
    for (const cell of row.cells) {
      if (!cell.code) {
        identifierFailures.push(`cell ${cell.id} has no identifier`);
        identifierEvidence.push(cell.evidence);
      } else if (isCandidateRow(row) && cell.lineKind === 'RDTE_PE' && !isValidPeCode(cell.code)) {
        identifierFailures.push(`cell ${cell.id} has invalid PE code ${cell.code}`);
        identifierEvidence.push(cell.evidence);
      }
      if (cell.lineKind !== row.lineKind) {
        identifierFailures.push(`cell ${cell.id} line kind differs from row ${row.id}`);
        identifierEvidence.push(cell.evidence);
      }
    }
  }
  checks.push(
    check(
      'schema_identifiers',
      identifierFailures.length === 0,
      true,
      40,
      identifierFailures.length === 0
        ? 'Identifiers and line-kind identity are valid.'
        : identifierFailures.join('; '),
      identifierEvidence.length ? identifierEvidence : [document.evidence],
      { failures: identifierFailures },
    ),
  );

  const columnByKey = new Map<string, BudgetColumn>();
  const columnFailures: string[] = [];
  const columnEvidence: BudgetEvidence[] = [];
  for (const column of document.columns) {
    if (columnByKey.has(column.key)) {
      columnFailures.push(`duplicate column key ${column.key}`);
      columnEvidence.push(column.evidence);
    }
    columnByKey.set(column.key, column);
    if (
      !Number.isInteger(column.fiscalYear) ||
      column.fiscalYear < 1900 ||
      column.fiscalYear > 2200
    ) {
      columnFailures.push(`column ${column.key} has invalid fiscal year ${column.fiscalYear}`);
      columnEvidence.push(column.evidence);
    }
    if (!column.label.trim() || !VALID_UNITS.has(column.unit)) {
      columnFailures.push(`column ${column.key} has invalid label/unit`);
      columnEvidence.push(column.evidence);
    }
  }
  const seenColumnFields = new Set<string>();
  for (const column of document.columns) {
    const key = `${column.fiscalYear}|${column.field}`;
    if (seenColumnFields.has(key)) {
      columnFailures.push(`duplicate fiscal-year/field column ${key}`);
      columnEvidence.push(column.evidence);
    }
    seenColumnFields.add(key);
  }
  for (const row of document.rows) {
    for (const cell of row.cells) {
      const column = columnByKey.get(cell.columnKey);
      if (!column) {
        columnFailures.push(`cell ${cell.id} references missing column ${cell.columnKey}`);
        columnEvidence.push(cell.evidence);
        continue;
      }
      if (cell.fiscalYear !== column.fiscalYear || cell.field !== column.field) {
        columnFailures.push(`cell ${cell.id} does not agree with column ${column.key}`);
        columnEvidence.push(cell.evidence);
      }
      if (cell.unit !== column.unit) {
        columnFailures.push(
          `cell ${cell.id} unit ${cell.unit} does not agree with column ${column.key} unit ${column.unit}`,
        );
        columnEvidence.push(cell.evidence, column.evidence);
      }
    }
  }
  checks.push(
    check(
      'fiscal_year_columns',
      columnFailures.length === 0,
      true,
      35,
      columnFailures.length === 0
        ? 'Fiscal-year columns are unique and cells agree with their columns.'
        : columnFailures.join('; '),
      columnEvidence.length ? columnEvidence : [document.evidence],
      { failures: columnFailures },
    ),
  );

  const ownershipFailures: string[] = [];
  const ownershipEvidence: BudgetEvidence[] = [];
  for (const row of document.rows) {
    for (const cell of row.cells) {
      const authorities = (
        FIELD_AUTHORITIES as Partial<Record<string, readonly BudgetSourceAuthority[]>>
      )[cell.field];
      if (!authorities || !authorities.includes(document.sourceAuthority)) {
        ownershipFailures.push(`${cell.field} is not owned by ${document.sourceAuthority}`);
        ownershipEvidence.push(cell.evidence);
      }
    }
  }
  checks.push(
    check(
      'field_ownership',
      ownershipFailures.length === 0,
      true,
      50,
      ownershipFailures.length === 0
        ? 'Every candidate field remains on its PE-specific budget-authority track.'
        : ownershipFailures.join('; '),
      ownershipEvidence.length ? ownershipEvidence : [document.evidence],
      { failures: ownershipFailures, sourceAuthority: document.sourceAuthority },
    ),
  );

  const numericFailures: string[] = [];
  const numericEvidence: BudgetEvidence[] = [];
  for (const row of document.rows) {
    for (const cell of row.cells) {
      if (!VALID_UNITS.has(cell.unit) || !Number.isFinite(cell.rawValue)) {
        numericFailures.push(`cell ${cell.id} has non-finite value or unsupported unit`);
        numericEvidence.push(cell.evidence);
      }
      if (!evidenceIsValid(document, cell.evidence)) numericEvidence.push(cell.evidence);
    }
  }
  checks.push(
    check(
      'numeric_units',
      numericFailures.length === 0,
      true,
      45,
      numericFailures.length === 0
        ? 'All numeric cells have finite values and explicit supported source units.'
        : numericFailures.join('; '),
      numericEvidence.length ? numericEvidence : [document.evidence],
      { failures: numericFailures },
    ),
  );

  const cells = document.rows.filter(isCandidateRow).flatMap((row) => row.cells);
  const duplicateFailures: string[] = [];
  const duplicateEvidence: BudgetEvidence[] = [];
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) {
      if (sameNaturalKey(cells[i]!, cells[j]!)) {
        duplicateFailures.push(`${cells[i]!.id} and ${cells[j]!.id} share a natural key`);
        duplicateEvidence.push(cells[i]!.evidence, cells[j]!.evidence);
      }
    }
  }
  checks.push(
    check(
      'duplicate_cells',
      duplicateFailures.length === 0,
      true,
      35,
      duplicateFailures.length === 0
        ? 'No duplicate PE/FY/field assertions exist.'
        : duplicateFailures.join('; '),
      duplicateEvidence.length ? duplicateEvidence : [document.evidence],
      { failures: duplicateFailures },
    ),
  );

  const headerSignatures = new Map<string, BudgetRow[]>();
  for (const row of document.rows) {
    if (row.kind !== 'header') continue;
    const signature = `${row.title ?? ''}|${row.cells.map((cell) => `${cell.fiscalYear}:${cell.field}`).join(',')}`;
    headerSignatures.set(signature, [...(headerSignatures.get(signature) ?? []), row]);
  }
  const repeatedHeaderRows = [...headerSignatures.values()]
    .filter((rows) => rows.length > 1)
    .flat();
  checks.push(
    check(
      'repeated_headers',
      repeatedHeaderRows.length === 0,
      false,
      10,
      repeatedHeaderRows.length === 0
        ? 'No repeated header rows were detected.'
        : `${repeatedHeaderRows.length} repeated header row(s) require review.`,
      repeatedHeaderRows.length
        ? repeatedHeaderRows.map((row) => row.evidence)
        : [document.evidence],
      { repeatedRowIds: repeatedHeaderRows.map((row) => row.id) },
    ),
  );

  const rowIds = new Set(document.rows.map((row) => row.id));
  const continuationFailures: string[] = [];
  const continuationEvidence: BudgetEvidence[] = [];
  for (const row of document.rows) {
    if (row.kind === 'continuation' && (!row.continuationOf || !rowIds.has(row.continuationOf))) {
      continuationFailures.push(`continuation row ${row.id} has no valid parent`);
      continuationEvidence.push(row.evidence);
    }
  }
  checks.push(
    check(
      'continuation_links',
      continuationFailures.length === 0,
      true,
      25,
      continuationFailures.length === 0
        ? 'Continuation rows link to an identified parent row.'
        : continuationFailures.join('; '),
      continuationEvidence.length ? continuationEvidence : [document.evidence],
      { failures: continuationFailures },
    ),
  );

  const arithmeticFailures: string[] = [];
  const arithmeticEvidence: BudgetEvidence[] = [];
  const rowsById = new Map(document.rows.map((row) => [row.id, row]));
  for (const row of document.rows) {
    if ((row.kind !== 'total' && row.kind !== 'subtotal') || !row.totalOfRowIds?.length) continue;
    const children = row.totalOfRowIds.map((id) => rowsById.get(id));
    if (children.some((child) => !child)) {
      arithmeticFailures.push(`total row ${row.id} references a missing child`);
      arithmeticEvidence.push(row.evidence);
      continue;
    }
    for (const totalCell of row.cells) {
      const childValues = children
        .map((child) => child!.cells.find((cell) => cell.columnKey === totalCell.columnKey))
        .map((cell) => (cell ? normalizedCellValue(cell) : null));
      const totalValue = normalizedCellValue(totalCell);
      if (totalValue == null || childValues.some((value) => value == null)) continue;
      const expected = childValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      if (Math.abs(expected - totalValue) > Math.max(0.01, Math.abs(expected) * 0.005)) {
        arithmeticFailures.push(
          `total cell ${totalCell.id}=${totalValue} million does not equal child sum ${expected} million`,
        );
        arithmeticEvidence.push(totalCell.evidence, ...children.map((child) => child!.evidence));
      }
    }
  }
  checks.push(
    check(
      'arithmetic_reconciliation',
      arithmeticFailures.length === 0,
      true,
      40,
      arithmeticFailures.length === 0
        ? 'Explicit subtotal/total arithmetic reconciles within the deterministic tolerance.'
        : arithmeticFailures.join('; '),
      arithmeticEvidence.length ? arithmeticEvidence : [document.evidence],
      { failures: arithmeticFailures },
    ),
  );

  checks.push(runComparisonCheck(document, 'cross_document'));
  checks.push(runComparisonCheck(document, 'historical'));
  return checks;
}

function runComparisonCheck(
  document: BudgetDocument,
  kind: BudgetComparison['kind'],
): VerificationCheck {
  const comparisons = (document.comparisons ?? []).filter((item) => item.kind === kind);
  if (comparisons.length === 0) {
    return check(
      kind === 'cross_document' ? 'cross_document_reconciliation' : 'historical_consistency',
      true,
      false,
      0,
      `No ${kind.replace('_', ' ')} controls were supplied for this candidate.`,
      [document.evidence],
    );
  }
  const records = document.rows
    .filter(isCandidateRow)
    .flatMap((row) => row.cells.map((cell) => ({ row, cell })));
  const failures: string[] = [];
  const evidence: BudgetEvidence[] = [];
  for (const comparison of comparisons) {
    const match = records.find(
      ({ cell }) =>
        cell.code === comparison.candidate.code &&
        cell.fiscalYear === comparison.candidate.fiscalYear &&
        cell.field === comparison.candidate.field,
    );
    if (!match) {
      failures.push(`${comparison.id} has no candidate cell`);
      evidence.push(comparison.evidence);
      continue;
    }
    const actual = normalizeMoneyToMillions(match.cell.rawValue, match.cell.unit).valueM;
    if (Math.abs(actual - comparison.referenceValueMillions) > comparison.toleranceMillions) {
      failures.push(
        `${comparison.id} actual ${actual} differs from reference ${comparison.referenceValueMillions}`,
      );
      evidence.push(match.cell.evidence, comparison.evidence);
    }
  }
  const code =
    kind === 'cross_document' ? 'cross_document_reconciliation' : 'historical_consistency';
  return check(
    code,
    failures.length === 0,
    false,
    kind === 'cross_document' ? 20 : 15,
    failures.length === 0
      ? `All supplied ${kind.replace('_', ' ')} controls reconcile.`
      : failures.join('; '),
    evidence.length ? evidence : comparisons.map((item) => item.evidence),
    { failures, comparisonCount: comparisons.length },
  );
}

function routeForRisk(riskScore: number, policy: VerificationPolicy): VerificationRoute {
  if (riskScore <= policy.automaticRiskMax) return 'automatic';
  if (riskScore <= policy.targetedReextractionRiskMax) return 'targeted_local_reextraction';
  if (riskScore <= policy.paidVerifierRiskMax) return 'paid_page_verifier';
  return 'human_review';
}

function statusFor(
  checks: VerificationCheck[],
  riskScore: number,
  policy: VerificationPolicy,
): VerificationStatus {
  if (checks.some((item) => !item.passed && item.blocking)) return 'REJECTED';
  if (riskScore <= policy.automaticRiskMax) return 'VERIFIED_AUTOMATIC';
  return 'NEEDS_REVIEW';
}

function mergePolicy(policy?: Partial<VerificationPolicy>): VerificationPolicy {
  const merged = { ...DEFAULT_VERIFICATION_POLICY, ...policy };
  if (
    !Number.isFinite(merged.automaticRiskMax) ||
    !Number.isFinite(merged.targetedReextractionRiskMax) ||
    !Number.isFinite(merged.paidVerifierRiskMax) ||
    merged.automaticRiskMax < 0 ||
    merged.automaticRiskMax > merged.targetedReextractionRiskMax ||
    merged.targetedReextractionRiskMax > merged.paidVerifierRiskMax ||
    merged.paidVerifierRiskMax > MAX_SAFE_RISK
  ) {
    throw new Error('Verification risk thresholds must be ordered between 0 and 100.');
  }
  return merged;
}

/**
 * Verify a normalized, extract-only candidate. This function has no database or writer
 * dependency and cannot promote PE-year dollars; it emits a reviewable decision artifact.
 */
export function verifyBudgetDocument(
  document: BudgetDocument,
  options: VerificationOptions = {},
): BudgetVerificationResult {
  const policy = mergePolicy(options.policy);
  const checks = runChecks(document);
  const normalizedRecords: NormalizedBudgetRecord[] = [];
  for (const row of document.rows) {
    for (const cell of row.cells) {
      if (
        isCandidateRow(row) &&
        Number.isFinite(cell.rawValue) &&
        VALID_UNITS.has(cell.unit) &&
        evidenceIsValid(document, cell.evidence)
      ) {
        normalizedRecords.push(normalizeCell(document, row, cell));
      }
    }
  }
  const riskScore = boundedRisk(checks);
  const status = statusFor(checks, riskScore, policy);
  const route = status === 'REJECTED' ? 'none' : routeForRisk(riskScore, policy);
  const blockingFailures = checks.filter((item) => !item.passed && item.blocking);
  const canonicalEligible = status === 'VERIFIED_AUTOMATIC' || status === 'VERIFIED_REVIEWED';
  const promotionReady = canonicalEligible && options.approvedSha256 === document.sourceSha256;
  return {
    status,
    route,
    riskScore,
    checks,
    normalizedRecords,
    blockingFailures,
    canonicalEligible,
    promotionReady,
    sourceSha256: document.sourceSha256,
    sourceDocumentId: document.sourceDocumentId,
  };
}

export function buildVerificationRun(
  result: BudgetVerificationResult,
  input: { runId: string; candidateId: string; startedAt: string; completedAt: string },
): BudgetVerificationRun {
  if (!input.runId.trim() || !input.candidateId.trim()) {
    throw new Error('Verification runs require run and candidate identifiers.');
  }
  return {
    runId: input.runId,
    candidateId: input.candidateId,
    status: result.status,
    route: result.route,
    riskScore: result.riskScore,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    checks: result.checks,
  };
}

export function getCanonicalPromotionRecords(
  result: BudgetVerificationResult,
): NormalizedBudgetRecord[] {
  return result.promotionReady ? result.normalizedRecords : [];
}

/** Preserve exact-SHA approval as a separate, explicit writer precondition. */
export function assertPromotionReady(result: BudgetVerificationResult): void {
  if (!result.promotionReady) {
    throw new Error(
      `Canonical promotion is blocked for ${result.sourceDocumentId}; verification and exact-SHA approval are both required.`,
    );
  }
}

export interface ReviewDecision {
  reviewerId: string;
  accepted: boolean;
  notes: string;
  evidence: BudgetEvidence[];
}

/** Apply a human review without touching canonical PE data. */
export function applyReviewDecision(
  result: BudgetVerificationResult,
  decision: ReviewDecision,
  approvedSha256?: string,
): BudgetVerificationResult {
  if (result.status !== 'NEEDS_REVIEW') {
    throw new Error(`Human review requires NEEDS_REVIEW status; received ${result.status}`);
  }
  if (!decision.reviewerId.trim() || !decision.notes.trim() || decision.evidence.length === 0) {
    throw new Error('A review decision requires reviewer identity, notes, and source evidence.');
  }
  const reviewEvidenceValid = decision.evidence.every(
    (item) =>
      item.sourceDocumentId === result.sourceDocumentId &&
      item.sourceSha256 === result.sourceSha256 &&
      evidenceIsValid(
        {
          sourceDocumentId: result.sourceDocumentId,
          sourceSha256: result.sourceSha256,
          archiveProof: {
            bucket: 'review',
            key: 'review',
            versionId: 'review',
            sha256: result.sourceSha256,
          },
          parseProof: {
            id: 'review',
            provider: 'llamaparse',
            status: 'succeeded',
            inputSha256: result.sourceSha256,
          },
          documentId: 'review',
          fiscalYear: 0,
          sourceAuthority: 'unknown',
          sourceLineKind: 'UNKNOWN',
          evidence: item,
          columns: [],
          rows: [],
        },
        item,
      ),
  );
  if (!reviewEvidenceValid)
    throw new Error('Review evidence must point to the exact candidate document and SHA.');
  if (!decision.accepted) {
    return {
      ...result,
      status: 'REJECTED',
      route: 'none',
      canonicalEligible: false,
      promotionReady: false,
    };
  }
  return {
    ...result,
    status: 'VERIFIED_REVIEWED',
    route: 'human_review',
    canonicalEligible: true,
    promotionReady: approvedSha256 === result.sourceSha256,
  };
}
