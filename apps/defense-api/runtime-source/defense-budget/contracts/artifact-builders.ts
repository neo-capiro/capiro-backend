/**
 * Artifact builder for defense_budget_extraction_v1.
 *
 * Adapters collect parser runs, evidence, source facts, assertions, warnings,
 * and omissions here. The builder:
 *   - generates deterministic IDs (SHA-256 over canonical identity tuples)
 *   - rejects duplicate facts/assertions before finalization
 *   - canonicalizes ordering
 *   - computes the summary, content hash, and artifact ID
 *   - runs full semantic validation before returning
 *
 * No random UUIDs, timestamps, or wall-clock values appear in IDs.
 */
import { sha256CanonicalJson, type JsonValue } from './canonical-json.js';
import {
  computeArtifactContentSha256,
  computeArtifactSummary,
  validateDefenseBudgetExtractionArtifactV1,
  type ContractFindingV1,
} from './extraction-artifact-v1.semantic.js';
import {
  DEFENSE_BUDGET_EXTRACTION_SCHEMA_VERSION,
  defenseBudgetExtractionArtifactV1Schema,
  type DefenseBudgetAssertionV1,
  type DefenseBudgetExtractionArtifactV1,
  type ExtractionOmissionV1,
  type ExtractionSourceV1,
  type ExtractionWarningV1,
  type PageRangeV1,
  type ParserRunV1,
  type SourceEvidenceV1,
  type SourceFactV1,
} from './extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* B4. Deterministic IDs                                               */
/* ------------------------------------------------------------------ */

function deterministicId(prefix: string, identity: JsonValue): string {
  return `${prefix}_${sha256CanonicalJson(identity)}`;
}

export function parserRunIdV1(identity: JsonValue): string {
  return deterministicId('prun', identity);
}
export function evidenceIdV1(identity: JsonValue): string {
  return deterministicId('ev', identity);
}
export function factIdV1(identity: JsonValue): string {
  return deterministicId('fact', identity);
}
export function assertionIdV1(identity: JsonValue): string {
  return deterministicId('asrt', identity);
}
export function warningIdV1(identity: JsonValue): string {
  return deterministicId('warn', identity);
}
export function omissionIdV1(identity: JsonValue): string {
  return deterministicId('omit', identity);
}

/* ------------------------------------------------------------------ */
/* D2. Adapter result builder                                          */
/* ------------------------------------------------------------------ */

export class ArtifactBuilderV1 {
  private readonly parserRuns: ParserRunV1[] = [];
  private readonly evidence: SourceEvidenceV1[] = [];
  private readonly sourceFacts: SourceFactV1[] = [];
  private readonly assertions: DefenseBudgetAssertionV1[] = [];
  private readonly warnings: ExtractionWarningV1[] = [];
  private readonly omissions: ExtractionOmissionV1[] = [];

  constructor(private readonly source: ExtractionSourceV1) {}

  addParserRun(run: ParserRunV1): this {
    this.parserRuns.push(run);
    return this;
  }

  /**
   * Register a stand-in run for callers that supply none (unit tests and manual
   * composition), declaring exactly the pages the already-added evidence cites.
   * A run that claims no pages cannot honestly carry page-bearing evidence, so
   * the ranges are derived from the evidence rather than left empty.
   *
   * Call this after all evidence has been added. Evidence added beforehand
   * already carries this run's ID, and page binding is a no-op while no run is
   * registered, so deferring registration does not change lineage.
   */
  addParserRunCoveringAddedEvidence(run: Omit<ParserRunV1, 'pageRanges'>): this {
    const pages = [
      ...new Set(
        this.evidence
          .filter((item) => item.parserRunId === run.parserRunId && item.page != null)
          .map((item) => item.page as number),
      ),
    ].sort((left, right) => left - right);
    const pageRanges: PageRangeV1[] = [];
    for (const page of pages) {
      const last = pageRanges[pageRanges.length - 1];
      if (last !== undefined && page === last.endPage + 1) {
        last.endPage = page;
        continue;
      }
      pageRanges.push({ startPage: page, endPage: page });
    }
    return this.addParserRun({ ...run, pageRanges });
  }

  addEvidence(evidence: SourceEvidenceV1): this {
    this.evidence.push(this.bindEvidenceToCoveringParserRun(evidence));
    return this;
  }

  addSourceFact(fact: SourceFactV1): this {
    this.sourceFacts.push(fact);
    return this;
  }

  addAssertion(assertion: DefenseBudgetAssertionV1): this {
    this.assertions.push(assertion);
    return this;
  }

  addWarning(warning: ExtractionWarningV1): this {
    this.warnings.push(warning);
    return this;
  }

  addOmission(omission: ExtractionOmissionV1): this {
    this.omissions.push(omission);
    return this;
  }

  /**
   * Phase 3 may compose selected pages from several parser runs. Semantic
   * builders historically supplied the first parser-run ID for every evidence
   * item, which corrupted lineage on later pages. When exactly one registered
   * run covers the evidence page, the builder binds the evidence to that run.
   *
   * When ranges overlap, an already-correct explicit run is retained. An
   * ambiguous or uncovered page remains unchanged so strict semantic and Phase
   * 2 proof validation can fail closed rather than choosing a winner.
   */
  private bindEvidenceToCoveringParserRun(evidence: SourceEvidenceV1): SourceEvidenceV1 {
    if (evidence.page == null) return evidence;
    const covering = this.parserRuns.filter((run) =>
      run.pageRanges.some(
        (range) => evidence.page! >= range.startPage && evidence.page! <= range.endPage,
      ),
    );
    if (covering.length === 1) {
      const parserRunId = covering[0]!.parserRunId;
      return evidence.parserRunId === parserRunId ? evidence : { ...evidence, parserRunId };
    }
    if (covering.length > 1 && covering.some((run) => run.parserRunId === evidence.parserRunId)) {
      return evidence;
    }
    return evidence;
  }

  /**
   * Finalize: reject duplicates, canonicalize ordering, compute summary + hash,
   * parse through strict Zod schema, run semantic validation, and return the
   * parsed artifact. Throws on duplicate IDs, schema errors, or semantic errors.
   */
  finalize(): DefenseBudgetExtractionArtifactV1 {
    rejectDuplicates(
      this.parserRuns.map((run) => run.parserRunId),
      'parserRunId',
    );
    rejectDuplicates(
      this.evidence.map((item) => item.evidenceId),
      'evidenceId',
    );
    rejectDuplicates(
      this.sourceFacts.map((fact) => fact.factId),
      'factId',
    );
    rejectDuplicates(
      this.assertions.map((assertion) => assertion.assertionId),
      'assertionId',
    );
    rejectDuplicates(
      this.warnings.map((warning) => warning.warningId),
      'warningId',
    );
    rejectDuplicates(
      this.omissions.map((omission) => omission.omissionId),
      'omissionId',
    );

    const ordered = {
      parserRuns: [...this.parserRuns].sort((a, b) => compareStrings(a.parserRunId, b.parserRunId)),
      evidence: [...this.evidence].sort((a, b) => compareStrings(a.evidenceId, b.evidenceId)),
      sourceFacts: [...this.sourceFacts].sort((a, b) => compareStrings(a.factId, b.factId)),
      assertions: [...this.assertions].sort(
        (a, b) =>
          compareStrings(a.assertionKind, b.assertionKind) ||
          compareStrings(a.assertionId, b.assertionId),
      ),
      warnings: [...this.warnings].sort((a, b) => compareStrings(a.warningId, b.warningId)),
      omissions: [...this.omissions].sort((a, b) => compareStrings(a.omissionId, b.omissionId)),
    };

    const summary = computeArtifactSummary({
      sourceFacts: ordered.sourceFacts,
      assertions: ordered.assertions,
      warnings: ordered.warnings,
      omissions: ordered.omissions,
    });

    const unsigned = {
      schemaVersion: DEFENSE_BUDGET_EXTRACTION_SCHEMA_VERSION,
      artifactId: 'dbx1_pending',
      contentSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      source: this.source,
      ...ordered,
      summary,
    };

    const contentSha256 = computeArtifactContentSha256(unsigned);
    const preParse: Record<string, unknown> = {
      ...unsigned,
      artifactId: `dbx1_${contentSha256}`,
      contentSha256,
    };

    // Parse through strict Zod schema to reject invalid titles, project codes,
    // performer names, fiscal years, and unknown fields.
    const artifact = defenseBudgetExtractionArtifactV1Schema.parse(preParse);

    // Run semantic validation on the parsed artifact.
    const findings = validateDefenseBudgetExtractionArtifactV1(artifact);
    const errors = findings.filter((finding) => finding.severity === 'error');
    if (errors.length > 0) {
      throw new ArtifactBuildError(errors);
    }
    return artifact;
  }
}

export class ArtifactBuildError extends Error {
  constructor(public readonly findings: ContractFindingV1[]) {
    super(
      `artifact build failed semantic validation: ${findings
        .map((finding) => `${finding.code} at ${finding.path}: ${finding.message}`)
        .join('; ')}`,
    );
    this.name = 'ArtifactBuildError';
  }
}

function rejectDuplicates(ids: string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`duplicate ${label} before finalization: ${id}`);
    }
    seen.add(id);
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
