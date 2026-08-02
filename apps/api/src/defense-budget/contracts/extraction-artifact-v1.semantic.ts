/**
 * Semantic validation for defense_budget_extraction_v1 artifacts.
 *
 * Schema validation (Zod) proves shape; this module proves MEANING:
 * hash integrity, reference integrity, evidence truthfulness, source-fact
 * completeness, assertion semantics, and summary consistency.
 *
 * Contract validity is NOT verification. An artifact with explicit omissions
 * can be valid but not complete.
 */
import { sha256CanonicalJson, type JsonValue } from './canonical-json.js';
import { moneyToMillionsString } from './decimal-string.js';
import {
  DEFENSE_BUDGET_EXTRACTION_SCHEMA_VERSION,
  defenseBudgetExtractionArtifactV1Schema,
  type BoundingBoxV1,
  type DefenseBudgetAssertionV1,
  type DefenseBudgetExtractionArtifactV1,
  type ExtractionArtifactSummaryV1,
  type SourceEvidenceV1,
} from './extraction-artifact-v1.js';

export interface ContractFindingV1 {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parse unknown input into a schema-valid artifact. Throws on schema failure. */
export function parseDefenseBudgetExtractionArtifactV1(
  input: unknown,
): DefenseBudgetExtractionArtifactV1 {
  return defenseBudgetExtractionArtifactV1Schema.parse(input);
}

/** Full semantic validation. Returns findings (empty = valid). */
export function validateDefenseBudgetExtractionArtifactV1(
  artifact: DefenseBudgetExtractionArtifactV1,
): ContractFindingV1[] {
  const findings: ContractFindingV1[] = [];
  const error = (code: string, path: string, message: string): void => {
    findings.push({ severity: 'error', code, path, message });
  };
  const warn = (code: string, path: string, message: string): void => {
    findings.push({ severity: 'warning', code, path, message });
  };

  /* ---------------- identity and hash ---------------- */
  if (artifact.schemaVersion !== DEFENSE_BUDGET_EXTRACTION_SCHEMA_VERSION) {
    error(
      'schema_version_mismatch',
      'schemaVersion',
      `expected ${DEFENSE_BUDGET_EXTRACTION_SCHEMA_VERSION}`,
    );
  }
  if (!SHA256_RE.test(artifact.source.sourcePdfSha256)) {
    error('source_sha_invalid', 'source.sourcePdfSha256', 'source SHA must be lowercase SHA-256');
  }
  const recomputed = computeArtifactContentSha256(artifact);
  if (artifact.contentSha256 !== recomputed) {
    error(
      'content_sha_mismatch',
      'contentSha256',
      `content hash does not recompute: expected ${recomputed}, got ${artifact.contentSha256}`,
    );
  }
  const expectedArtifactId = `dbx1_${recomputed}`;
  if (artifact.artifactId !== expectedArtifactId) {
    error(
      'artifact_id_mismatch',
      'artifactId',
      `artifactId must be dbx1_<contentSha256>: expected ${expectedArtifactId}`,
    );
  }

  /* ---------------- uniqueness and references ---------------- */
  const parserRunIds = new Set<string>();
  for (const [index, run] of artifact.parserRuns.entries()) {
    const path = `parserRuns[${index}]`;
    if (parserRunIds.has(run.parserRunId)) {
      error('duplicate_parser_run_id', path, `duplicate parserRunId ${run.parserRunId}`);
    }
    parserRunIds.add(run.parserRunId);
    if (run.inputSourceSha256 !== artifact.source.sourcePdfSha256) {
      error(
        'parser_run_input_sha_mismatch',
        `${path}.inputSourceSha256`,
        'parser-run input SHA must equal source PDF SHA',
      );
    }
    checkPageRangeOverlap(run.pageRanges, `${path}.pageRanges`, error);
  }

  const evidenceIds = new Set<string>();
  for (const [index, evidence] of artifact.evidence.entries()) {
    const path = `evidence[${index}]`;
    if (evidenceIds.has(evidence.evidenceId)) {
      error('duplicate_evidence_id', path, `duplicate evidenceId ${evidence.evidenceId}`);
    }
    evidenceIds.add(evidence.evidenceId);
    if (evidence.sourcePdfSha256 !== artifact.source.sourcePdfSha256) {
      error(
        'evidence_source_sha_mismatch',
        `${path}.sourcePdfSha256`,
        'evidence source SHA must equal source PDF SHA',
      );
    }
    if (!parserRunIds.has(evidence.parserRunId)) {
      error(
        'unknown_parser_run_reference',
        `${path}.parserRunId`,
        `unknown parserRunId ${evidence.parserRunId}`,
      );
    }
    checkEvidenceGranularity(evidence, path, error);
    checkEvidencePageInParserRange(artifact, evidence, path, error);
  }

  const factIds = new Set<string>();
  const requiredFactIds = new Set<string>();
  for (const [index, fact] of artifact.sourceFacts.entries()) {
    const path = `sourceFacts[${index}]`;
    if (factIds.has(fact.factId)) {
      error('duplicate_source_fact_id', path, `duplicate factId ${fact.factId}`);
    }
    factIds.add(fact.factId);
    if (fact.requiredForCompleteness) requiredFactIds.add(fact.factId);
    for (const evidenceId of fact.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        error(
          'unknown_evidence_reference',
          `${path}.evidenceIds`,
          `unknown evidenceId ${evidenceId}`,
        );
      }
    }
  }

  const assertionIds = new Set<string>();
  const assertedFactIds = new Map<string, DefenseBudgetAssertionV1[]>();
  for (const [index, assertion] of artifact.assertions.entries()) {
    const path = `assertions[${index}]`;
    if (assertionIds.has(assertion.assertionId)) {
      error('duplicate_assertion_id', path, `duplicate assertionId ${assertion.assertionId}`);
    }
    assertionIds.add(assertion.assertionId);
    for (const factId of assertion.sourceFactIds) {
      if (!factIds.has(factId)) {
        error('unknown_source_fact_reference', `${path}.sourceFactIds`, `unknown factId ${factId}`);
      }
      const list = assertedFactIds.get(factId) ?? [];
      list.push(assertion);
      assertedFactIds.set(factId, list);
    }
    for (const evidenceId of assertion.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        error(
          'unknown_evidence_reference',
          `${path}.evidenceIds`,
          `unknown evidenceId ${evidenceId}`,
        );
      }
    }
    checkAssertionSemantics(assertion, path, error, warn);
  }

  // Project funding must reference a represented project assertion, or carry a warning.
  const representedProjects = new Set(
    artifact.assertions
      .filter((item) => item.assertionKind === 'project')
      .map((item) => `${item.parentPeCode}::${item.projectCode}`),
  );
  for (const [index, assertion] of artifact.assertions.entries()) {
    if (assertion.assertionKind !== 'project_funding') continue;
    const key = `${assertion.parentPeCode}::${assertion.projectCode}`;
    if (!representedProjects.has(key)) {
      warn(
        'project_funding_without_project_assertion',
        `assertions[${index}]`,
        `project funding references project ${assertion.projectCode} under PE ${assertion.parentPeCode} with no project assertion`,
      );
    }
  }

  const warningIds = new Set<string>();
  for (const [index, warning] of artifact.warnings.entries()) {
    const path = `warnings[${index}]`;
    if (warningIds.has(warning.warningId)) {
      error('duplicate_warning_id', path, `duplicate warningId ${warning.warningId}`);
    }
    warningIds.add(warning.warningId);
    for (const factId of warning.sourceFactIds) {
      if (!factIds.has(factId)) {
        error('unknown_source_fact_reference', `${path}.sourceFactIds`, `unknown factId ${factId}`);
      }
    }
    for (const evidenceId of warning.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        error(
          'unknown_evidence_reference',
          `${path}.evidenceIds`,
          `unknown evidenceId ${evidenceId}`,
        );
      }
    }
  }

  const omissionIds = new Set<string>();
  const omittedFactIds = new Map<string, number>();
  for (const [index, omission] of artifact.omissions.entries()) {
    const path = `omissions[${index}]`;
    if (omissionIds.has(omission.omissionId)) {
      error('duplicate_omission_id', path, `duplicate omissionId ${omission.omissionId}`);
    }
    omissionIds.add(omission.omissionId);
    if (!factIds.has(omission.sourceFactId)) {
      error(
        'unknown_source_fact_reference',
        `${path}.sourceFactId`,
        `unknown factId ${omission.sourceFactId}`,
      );
    }
    omittedFactIds.set(omission.sourceFactId, (omittedFactIds.get(omission.sourceFactId) ?? 0) + 1);
  }

  /* ---------------- fact coverage ---------------- */
  for (const factId of requiredFactIds) {
    const asserted = assertedFactIds.has(factId);
    const omissionCount = omittedFactIds.get(factId) ?? 0;
    if (asserted && omissionCount > 0) {
      error(
        'fact_asserted_and_omitted',
        'sourceFacts',
        `required fact ${factId} is both asserted and omitted`,
      );
    } else if (!asserted && omissionCount === 0) {
      error(
        'uncovered_required_source_fact',
        'sourceFacts',
        `required fact ${factId} is neither asserted nor omitted`,
      );
    } else if (!asserted && omissionCount > 1) {
      error(
        'fact_omitted_multiple_times',
        'omissions',
        `fact ${factId} has ${omissionCount} omissions; exactly one is allowed`,
      );
    }
  }

  // Money/quantity facts must not feed more than one value assertion unless a
  // duplicate warning explicitly exists.
  const duplicateWarningExists = artifact.warnings.some((w) => w.code.includes('duplicate'));
  for (const [factId, assertions] of assertedFactIds) {
    const fact = artifact.sourceFacts.find((item) => item.factId === factId);
    if (!fact || (fact.category !== 'money' && fact.category !== 'quantity')) continue;
    const valueAssertions = assertions.filter((assertion) =>
      ['funding', 'quantity', 'unit_cost', 'project_funding', 'procurement_line'].includes(
        assertion.assertionKind,
      ),
    );
    if (valueAssertions.length > 1 && !duplicateWarningExists) {
      error(
        'fact_consumed_by_multiple_value_assertions',
        'assertions',
        `${fact.category} fact ${factId} feeds ${valueAssertions.length} value assertions without an explicit duplicate warning`,
      );
    }
  }

  /* ---------------- summary consistency ---------------- */
  const recomputedSummary = computeArtifactSummary(artifact);
  const summaryFindings = compareSummary(artifact.summary, recomputedSummary);
  for (const finding of summaryFindings) error('summary_mismatch', finding.path, finding.message);

  return findings;
}

/** Validate and throw an aggregate error when any error-severity finding exists. */
export function assertDefenseBudgetExtractionArtifactV1(
  artifact: DefenseBudgetExtractionArtifactV1,
  options?: { requireComplete?: boolean },
): void {
  const findings = validateDefenseBudgetExtractionArtifactV1(artifact);
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (options?.requireComplete && artifact.summary.completenessStatus !== 'complete') {
    errors.push({
      severity: 'error',
      code: 'completeness_required',
      path: 'summary.completenessStatus',
      message: `requireComplete rejects status ${artifact.summary.completenessStatus}`,
    });
  }
  if (errors.length > 0) {
    const detail = errors
      .map((finding) => `${finding.code} at ${finding.path}: ${finding.message}`)
      .join('; ');
    throw new Error(`defense_budget_extraction_v1 semantic validation failed: ${detail}`);
  }
}

/* ------------------------------------------------------------------ */
/* content hash + summary (shared with the builder)                    */
/* ------------------------------------------------------------------ */

/** Hash over the full artifact payload with artifactId/contentSha256 omitted. */
export function computeArtifactContentSha256(artifact: DefenseBudgetExtractionArtifactV1): string {
  const { artifactId: _artifactId, contentSha256: _contentSha256, ...payload } = artifact;
  return sha256CanonicalJson(payload as unknown as JsonValue);
}

/** Recompute the summary from artifact contents. */
export function computeArtifactSummary(
  artifact: Pick<
    DefenseBudgetExtractionArtifactV1,
    'sourceFacts' | 'assertions' | 'warnings' | 'omissions'
  >,
): ExtractionArtifactSummaryV1 {
  const requiredFacts = artifact.sourceFacts.filter((fact) => fact.requiredForCompleteness);
  const omittedFactIds = new Set(artifact.omissions.map((omission) => omission.sourceFactId));
  const assertedFactIds = new Set(
    artifact.assertions.flatMap((assertion) => assertion.sourceFactIds),
  );
  const covered = requiredFacts.filter((fact) => assertedFactIds.has(fact.factId)).length;
  const omitted = requiredFacts.filter((fact) => omittedFactIds.has(fact.factId)).length;
  const uncovered = requiredFacts.filter(
    (fact) => !assertedFactIds.has(fact.factId) && !omittedFactIds.has(fact.factId),
  ).length;

  const countsByAssertionKind: Record<string, number> = {};
  for (const assertion of artifact.assertions) {
    countsByAssertionKind[assertion.assertionKind] =
      (countsByAssertionKind[assertion.assertionKind] ?? 0) + 1;
  }
  const countsByOmissionReason: Record<string, number> = {};
  for (const omission of artifact.omissions) {
    countsByOmissionReason[omission.reason] = (countsByOmissionReason[omission.reason] ?? 0) + 1;
  }

  const completenessStatus =
    uncovered > 0
      ? 'incomplete'
      : artifact.omissions.length > 0
        ? 'complete_with_omissions'
        : 'complete';

  return {
    sourceFactCount: artifact.sourceFacts.length,
    requiredSourceFactCount: requiredFacts.length,
    coveredRequiredSourceFactCount: covered,
    omittedRequiredSourceFactCount: omitted,
    uncoveredRequiredSourceFactCount: uncovered,
    assertionCount: artifact.assertions.length,
    warningCount: artifact.warnings.length,
    omissionCount: artifact.omissions.length,
    countsByAssertionKind,
    countsByOmissionReason,
    completenessStatus,
  };
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function checkPageRangeOverlap(
  ranges: Array<{ startPage: number; endPage: number }>,
  path: string,
  error: (code: string, path: string, message: string) => void,
): void {
  const sorted = [...ranges].sort((a, b) => a.startPage - b.startPage);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current.startPage <= previous.endPage) {
      error(
        'parser_page_range_overlap',
        path,
        `page ranges [${previous.startPage},${previous.endPage}] and [${current.startPage},${current.endPage}] overlap`,
      );
    }
  }
}

function checkEvidenceGranularity(
  evidence: SourceEvidenceV1,
  path: string,
  error: (code: string, path: string, message: string) => void,
): void {
  const hasPage = evidence.page != null;
  const hasBox = evidence.boundingBox != null;
  const hasSpan = evidence.textSpan != null;
  switch (evidence.granularity) {
    case 'document_only':
      if (hasPage || hasBox || hasSpan) {
        error(
          'evidence_granularity_violation',
          path,
          'document_only evidence must not carry page, bounding box, or text span',
        );
      }
      break;
    case 'page_only':
      if (!hasPage)
        error('evidence_granularity_violation', path, 'page_only evidence requires page');
      if (hasBox || hasSpan) {
        error(
          'evidence_granularity_violation',
          path,
          'page_only evidence must not carry bounding box or text span',
        );
      }
      break;
    case 'cell_bbox':
      if (!hasPage || !hasBox) {
        error(
          'evidence_granularity_violation',
          path,
          'cell_bbox evidence requires page and bounding box',
        );
      } else {
        checkBoundingBox(evidence.boundingBox!, `${path}.boundingBox`, error);
      }
      break;
    case 'text_span':
      if (!hasPage || !hasSpan) {
        error(
          'evidence_granularity_violation',
          path,
          'text_span evidence requires page and text span',
        );
      }
      break;
  }
}

function checkBoundingBox(
  box: BoundingBoxV1,
  path: string,
  error: (code: string, path: string, message: string) => void,
): void {
  if (!(box.x1 > box.x0) || !(box.y1 > box.y0)) {
    error('bounding_box_non_positive_area', path, 'bounding box must have positive area');
  }
  if (box.coordinateSystem === 'normalized_0_1') {
    for (const [name, value] of [
      ['x0', box.x0],
      ['y0', box.y0],
      ['x1', box.x1],
      ['y1', box.y1],
    ] as const) {
      if (value < 0 || value > 1) {
        error(
          'bounding_box_out_of_range',
          `${path}.${name}`,
          `normalized coordinate ${name}=${value} outside 0..1`,
        );
      }
    }
  }
}

function checkEvidencePageInParserRange(
  artifact: DefenseBudgetExtractionArtifactV1,
  evidence: SourceEvidenceV1,
  path: string,
  error: (code: string, path: string, message: string) => void,
): void {
  if (evidence.page == null) return;
  const run = artifact.parserRuns.find((item) => item.parserRunId === evidence.parserRunId);
  if (!run || run.pageRanges.length === 0) return;
  const contained = run.pageRanges.some(
    (range) => evidence.page! >= range.startPage && evidence.page! <= range.endPage,
  );
  if (!contained) {
    error(
      'evidence_page_outside_parser_range',
      `${path}.page`,
      `page ${evidence.page} is outside parser run ${run.parserRunId} page ranges`,
    );
  }
}

function checkAssertionSemantics(
  assertion: DefenseBudgetAssertionV1,
  path: string,
  error: (code: string, path: string, message: string) => void,
  warn: (code: string, path: string, message: string) => void,
): void {
  if (assertion.confidence < 0 || assertion.confidence > 1) {
    error('confidence_out_of_range', `${path}.confidence`, 'confidence must be within 0..1');
  }

  if (assertion.assertionKind === 'funding' || assertion.assertionKind === 'project_funding') {
    checkMoneyScaling(assertion.money, `${path}.money`, error);
  }
  if (assertion.assertionKind === 'performer' && assertion.totalCost != null) {
    checkMoneyScaling(assertion.totalCost, `${path}.totalCost`, error);
  }
  if (assertion.assertionKind === 'procurement_line' && assertion.dollars != null) {
    checkMoneyScaling(assertion.dollars, `${path}.dollars`, error);
  }
  if (assertion.assertionKind === 'milcon_project') {
    if (assertion.authorizationAmount != null) {
      checkMoneyScaling(assertion.authorizationAmount, `${path}.authorizationAmount`, error);
    }
    if (assertion.appropriationAmount != null) {
      checkMoneyScaling(assertion.appropriationAmount, `${path}.appropriationAmount`, error);
    }
  }

  if (assertion.assertionKind === 'relationship') {
    if (
      assertion.relationshipType !== 'other' &&
      JSON.stringify(assertion.from) === JSON.stringify(assertion.to)
    ) {
      error(
        'relationship_endpoints_identical',
        path,
        `relationship ${assertion.relationshipType} must not have identical endpoints`,
      );
    }
  }

  if (assertion.assertionKind === 'milestone') {
    for (const [field, value] of [
      ['plannedDate', assertion.plannedDate],
      ['actualDate', assertion.actualDate],
    ] as const) {
      if (value != null && !ISO_DATE_RE.test(value) && !ISO_DATETIME_RE.test(value)) {
        error(
          'invalid_date_format',
          `${path}.${field}`,
          `expected ISO date or datetime, got ${value}`,
        );
      }
    }
  }
}

function checkMoneyScaling(
  money: {
    originalValue: string;
    originalUnit: 'dollars' | 'thousands' | 'millions';
    valueMillions: string;
  },
  path: string,
  error: (code: string, path: string, message: string) => void,
): void {
  let expected: string;
  try {
    expected = moneyToMillionsString(money.originalValue, money.originalUnit);
  } catch (cause) {
    error('money_scaling_invalid', path, `cannot scale money: ${(cause as Error).message}`);
    return;
  }
  if (money.valueMillions !== expected) {
    error(
      'money_scaling_mismatch',
      `${path}.valueMillions`,
      `valueMillions ${money.valueMillions} != exact scaling of ${money.originalValue} ${money.originalUnit} (${expected})`,
    );
  }
}

function compareSummary(
  actual: ExtractionArtifactSummaryV1,
  expected: ExtractionArtifactSummaryV1,
): Array<{ path: string; message: string }> {
  const findings: Array<{ path: string; message: string }> = [];
  const scalarKeys = [
    'sourceFactCount',
    'requiredSourceFactCount',
    'coveredRequiredSourceFactCount',
    'omittedRequiredSourceFactCount',
    'uncoveredRequiredSourceFactCount',
    'assertionCount',
    'warningCount',
    'omissionCount',
    'completenessStatus',
  ] as const;
  for (const key of scalarKeys) {
    if (actual[key] !== expected[key]) {
      findings.push({
        path: `summary.${key}`,
        message: `summary ${key} is ${actual[key]} but recomputes to ${expected[key]}`,
      });
    }
  }
  for (const key of ['countsByAssertionKind', 'countsByOmissionReason'] as const) {
    if (JSON.stringify(sortRecord(actual[key])) !== JSON.stringify(sortRecord(expected[key]))) {
      findings.push({
        path: `summary.${key}`,
        message: `summary ${key} does not match recomputed counts`,
      });
    }
  }
  return findings;
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}
