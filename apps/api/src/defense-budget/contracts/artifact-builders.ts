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
  type DefenseBudgetAssertionV1,
  type DefenseBudgetExtractionArtifactV1,
  type ExtractionOmissionV1,
  type ExtractionSourceV1,
  type ExtractionWarningV1,
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

  addEvidence(evidence: SourceEvidenceV1): this {
    this.evidence.push(evidence);
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
   * Finalize: reject duplicates, canonicalize ordering, compute summary + hash,
   * and run semantic validation. Throws on duplicate IDs or semantic errors.
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
    } satisfies DefenseBudgetExtractionArtifactV1;

    const contentSha256 = computeArtifactContentSha256(unsigned);
    const artifact: DefenseBudgetExtractionArtifactV1 = {
      ...unsigned,
      artifactId: `dbx1_${contentSha256}`,
      contentSha256,
    };

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
