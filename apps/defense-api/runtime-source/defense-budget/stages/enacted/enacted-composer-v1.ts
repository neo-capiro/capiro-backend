/** Phase 6 Workstream L — proof-gated enacted artifact composition. */
import {
  ArtifactBuilderV1,
  assertionIdV1,
  factIdV1,
  omissionIdV1,
  parserRunIdV1,
} from '../../contracts/artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
  SourceEvidenceV1,
} from '../../contracts/extraction-artifact-v1.js';
import {
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../stage-source-profile-v1.js';
import {
  DEFENSE_BUDGET_ENACTMENT_PROOF_FIELD,
  defenseBudgetEnactmentProofV1Schema,
  enactedLineCandidateV1Schema,
  type DefenseBudgetEnactmentProofV1,
  type EnactedLineCandidateV1,
} from './enactment-proof-v1.js';
import type { DefenseBudgetStageActionV1 } from '../appropriations/actions/defense-budget-stage-action-v1.js';

export interface EnactedCoverageReportV1 {
  schemaVersion: 'enacted_coverage_report_v1';
  directStatutory: number;
  incorporatedStatement: number;
  unresolved: number;
  notApplicable: number;
  blocked: number;
}

export interface ComposeEnactedStageV1Result {
  artifact: DefenseBudgetExtractionArtifactV1;
  proof: DefenseBudgetEnactmentProofV1;
  coverage: EnactedCoverageReportV1;
  actions: DefenseBudgetStageActionV1[];
}

function assertPublicLawSource(
  source: ExtractionSourceV1,
  proof: DefenseBudgetEnactmentProofV1,
): void {
  if (source.authority !== 'public_law' || source.exhibit !== 'public_law') {
    throw new Error('public-law proof source must use public_law authority/exhibit');
  }
  if (proof.publicLawSource.manifestDocumentKey !== source.manifestDocumentKey) {
    throw new Error('public-law manifest-document mismatch');
  }
  if (
    proof.publicLawSource.sourceDocumentId !==
    (source.sourceDocumentId ?? source.manifestDocumentKey)
  ) {
    throw new Error('public-law source-document mismatch');
  }
  if (proof.publicLawSource.sourceSha256 !== source.sourcePdfSha256) {
    throw new Error('public-law source SHA mismatch');
  }
}

function assertLineDetailSource(
  source: ExtractionSourceV1,
  proof: DefenseBudgetEnactmentProofV1,
): void {
  // The line-detail source is interpreted under enacted-public-law authority
  // only because the proof independently demonstrates statutory incorporation.
  if (source.authority !== 'public_law' || source.exhibit !== 'public_law') {
    throw new Error('enacted line-detail source must use public_law authority/exhibit');
  }
  if (proof.lineDetailSource.manifestDocumentKey !== source.manifestDocumentKey) {
    throw new Error('line-detail manifest-document mismatch');
  }
  if (
    proof.lineDetailSource.sourceDocumentId !==
    (source.sourceDocumentId ?? source.manifestDocumentKey)
  ) {
    throw new Error('line-detail source-document mismatch');
  }
  if (proof.lineDetailSource.sourceSha256 !== source.sourcePdfSha256) {
    throw new Error('line-detail source SHA mismatch');
  }
}

/**
 * Proof-, profile-, and vehicle-level invariants.
 *
 * A failure here invalidates the entire enactment context, not one line, so it
 * aborts composition instead of blocking a single candidate. A continuing
 * resolution without explicit line authority, a public-law number that does not
 * match the governing profile, or a superseded source document must not be able
 * to emit any enacted funding at all.
 */
function assertEnactmentContextV1(input: {
  profile: DefenseBudgetStageSourceProfileV1;
  publicLawSource: ExtractionSourceV1;
  lineDetailSource: ExtractionSourceV1;
  proof: DefenseBudgetEnactmentProofV1;
}): void {
  const { profile, publicLawSource, lineDetailSource, proof } = input;
  if (
    profile.stage !== 'public_law' ||
    profile.authority !== 'enacted_public_law' ||
    profile.track !== 'appropriations'
  ) {
    throw new Error('enacted composer requires public-law appropriations profile');
  }
  if (
    proof.fiscalYear !== profile.fiscalYear ||
    publicLawSource.fiscalYear !== profile.fiscalYear ||
    lineDetailSource.fiscalYear !== profile.fiscalYear
  ) {
    throw new Error('enacted fiscal-year mismatch');
  }
  if (profile.publicLawNumber !== proof.publicLawNumber) {
    throw new Error('public-law number mismatch');
  }
  if (profile.billId !== proof.billId) throw new Error('enacted bill mismatch');
  if (
    !profile.sourceDocumentKeys.includes(publicLawSource.manifestDocumentKey) ||
    !profile.sourceDocumentKeys.includes(lineDetailSource.manifestDocumentKey)
  ) {
    throw new Error('enactment sources are not governed by the source profile');
  }
  if (proof.publicLawSource.status !== 'current' || proof.lineDetailSource.status !== 'current') {
    throw new Error('stale/superseded enactment source is forbidden');
  }
  if (proof.incorporationEvidence != null) {
    if (
      proof.incorporationEvidence.sourceDocumentId !== proof.publicLawSource.sourceDocumentId ||
      proof.incorporationEvidence.sourceSha256 !== proof.publicLawSource.sourceSha256
    ) {
      throw new Error('incorporation evidence is not bound to the proved public-law bytes');
    }
  }
  if (proof.reviewerStatus === 'pending' || proof.reviewerStatus === 'rejected') {
    throw new Error('enactment proof is not reviewed/verified');
  }
  if (proof.vehicleKind === 'continuing_resolution' && !proof.explicitLineAuthority) {
    throw new Error('continuing resolution cannot masquerade as full-year enacted position');
  }
}

/**
 * Candidate-level invariants. A failure blocks that one line and is recorded as
 * a blocking omission; the remaining candidates still compose.
 */
function assertCandidateAgainstProofV1(input: {
  profile: DefenseBudgetStageSourceProfileV1;
  proof: DefenseBudgetEnactmentProofV1;
  candidate: EnactedLineCandidateV1;
}): void {
  const { profile, proof, candidate } = input;
  if (candidate.fiscalYear !== profile.fiscalYear) {
    throw new Error('enacted fiscal-year mismatch');
  }
  if (
    candidate.sourceDocumentId !== proof.lineDetailSource.sourceDocumentId ||
    candidate.sourceSha256 !== proof.lineDetailSource.sourceSha256
  ) {
    throw new Error('line-detail source proof mismatch');
  }
  if (candidate.bindingStatus !== 'accepted') {
    throw new Error('candidate identity cannot create enacted funding');
  }
  if (proof.division != null && candidate.division !== proof.division) {
    throw new Error('omnibus division mismatch');
  }
  if (proof.title != null && candidate.title != null && candidate.title !== proof.title) {
    throw new Error('omnibus title mismatch');
  }
}

export function composeEnactedStageV1(input: {
  profile: DefenseBudgetStageSourceProfileV1;
  publicLawSource: ExtractionSourceV1;
  lineDetailSource: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  lineDetailEvidence: readonly SourceEvidenceV1[];
  proof: DefenseBudgetEnactmentProofV1;
  candidates: readonly EnactedLineCandidateV1[];
  actions?: readonly DefenseBudgetStageActionV1[];
}): ComposeEnactedStageV1Result {
  const proof = defenseBudgetEnactmentProofV1Schema.parse(input.proof);
  if (proof.vehicleProfileHash !== stageSourceProfileHashV1(input.profile)) {
    throw new Error('enactment proof source-profile hash mismatch');
  }
  assertPublicLawSource(input.publicLawSource, proof);
  assertLineDetailSource(input.lineDetailSource, proof);
  if (
    input.lineDetailEvidence.some(
      (item) => item.sourcePdfSha256 !== input.lineDetailSource.sourcePdfSha256,
    )
  ) {
    throw new Error('line-detail evidence source SHA mismatch');
  }
  if (
    input.parserRuns.some(
      (run) => run.inputSourceSha256 !== input.lineDetailSource.sourcePdfSha256,
    )
  ) {
    throw new Error('line-detail parser run source SHA mismatch');
  }
  assertEnactmentContextV1({
    profile: input.profile,
    publicLawSource: input.publicLawSource,
    lineDetailSource: input.lineDetailSource,
    proof,
  });

  // The artifact source is the exact line-detail document that prints the line
  // amount. The public law is independently retained in the enactment proof.
  // This preserves the Phase 1 invariant that one artifact/evidence ledger is
  // bound to one exact source SHA.
  const builder = new ArtifactBuilderV1(input.lineDetailSource);
  const fallbackRun = {
    parserRunId: parserRunIdV1({
      source: input.lineDetailSource.sourcePdfSha256,
      profile: input.profile.profileId,
    }),
    method: 'manual' as const,
    parserVersion: 'enacted-proof-composer-v1',
    parserConfigSha256: stageSourceProfileHashV1(input.profile),
    inputSourceSha256: input.lineDetailSource.sourcePdfSha256,
    outputArtifactSha256: input.lineDetailSource.sourcePdfSha256,
  };
  for (const run of input.parserRuns) builder.addParserRun(run);
  for (const evidence of input.lineDetailEvidence) {
    builder.addEvidence(
      input.parserRuns.length === 0
        ? { ...evidence, parserRunId: fallbackRun.parserRunId }
        : evidence,
    );
  }

  const proofFactId = factIdV1({
    field: DEFENSE_BUDGET_ENACTMENT_PROOF_FIELD,
    proofId: proof.proofId,
  });
  builder.addSourceFact({
    factId: proofFactId,
    sourcePath: 'enactment-proof',
    category: 'metadata',
    requiredForCompleteness: true,
    rawValue: proof,
    // Incorporation evidence may belong to the public-law PDF while the
    // artifact ledger is bound to the line-detail PDF. The proof embeds the
    // independent public-law SHA/evidence identifiers; do not corrupt the
    // single-source artifact ledger by pretending those IDs are local evidence.
    evidenceIds: [],
  });
  builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: assertionIdV1({ proofFactId }),
    sourceFactIds: [proofFactId],
    evidenceIds: [],
    confidence: proof.reviewerStatus === 'verified' ? 1 : 0.99,
    fieldName: DEFENSE_BUDGET_ENACTMENT_PROOF_FIELD,
    value: proof,
  });

  const coverage: EnactedCoverageReportV1 = {
    schemaVersion: 'enacted_coverage_report_v1',
    directStatutory: 0,
    incorporatedStatement: 0,
    unresolved: 0,
    notApplicable: 0,
    blocked: 0,
  };

  for (const rawCandidate of input.candidates) {
    const candidate = enactedLineCandidateV1Schema.parse(rawCandidate);
    try {
      assertCandidateAgainstProofV1({ profile: input.profile, proof, candidate });
    } catch (error) {
      coverage.blocked += 1;
      const factId = factIdV1({ candidateId: candidate.candidateId, kind: 'enacted_blocked' });
      builder.addSourceFact({
        factId,
        sourcePath: `candidate:${candidate.candidateId}/blocked`,
        category: 'metadata',
        requiredForCompleteness: true,
        rawValue: { reason: error instanceof Error ? error.message : String(error) },
        evidenceIds: candidate.evidenceIds,
      });
      builder.addOmission({
        omissionId: omissionIdV1({ factId }),
        sourceFactId: factId,
        reason: candidate.bindingStatus === 'accepted' ? 'missing_evidence' : 'invalid_identity',
        severity: 'blocking',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const factId = factIdV1({
      candidateId: candidate.candidateId,
      proofId: proof.proofId,
      field: 'enacted',
    });
    builder.addSourceFact({
      factId,
      sourcePath: `candidate:${candidate.candidateId}/enacted`,
      category: 'money',
      requiredForCompleteness: true,
      rawValue: {
        proofId: proof.proofId,
        proofType: proof.proofType,
        publicLawSourceDocumentId: proof.publicLawSource.sourceDocumentId,
        lineDetailSourceDocumentId: proof.lineDetailSource.sourceDocumentId,
      },
      evidenceIds: candidate.evidenceIds,
    });
    builder.addAssertion({
      assertionKind: 'funding',
      assertionId: assertionIdV1({ factId, field: 'enacted' }),
      sourceFactIds: [factId, proofFactId],
      evidenceIds: candidate.evidenceIds,
      confidence: proof.proofType === 'statutory_line_item' ? 1 : 0.99,
      identity: candidate.identity,
      fiscalYear: candidate.fiscalYear,
      field: 'enacted',
      money: candidate.money,
      metadata: {
        enactmentProofId: proof.proofId,
        enactmentProofType: proof.proofType,
        vehicleKind: proof.vehicleKind,
        publicLawSourceDocumentId: proof.publicLawSource.sourceDocumentId,
        publicLawSourceSha256: proof.publicLawSource.sourceSha256,
      },
    });
    if (proof.proofType === 'statutory_line_item') coverage.directStatutory += 1;
    else coverage.incorporatedStatement += 1;
  }

  if (input.parserRuns.length === 0) builder.addParserRunCoveringAddedEvidence(fallbackRun);
  return {
    artifact: builder.finalize(),
    proof,
    coverage,
    actions: [...(input.actions ?? [])],
  };
}

export function continuingResolutionPeriodRecordV1(proof: DefenseBudgetEnactmentProofV1) {
  if (proof.vehicleKind !== 'continuing_resolution') {
    throw new Error('not a continuing resolution');
  }
  return {
    schemaVersion: 'continuing_resolution_period_v1' as const,
    fiscalYear: proof.fiscalYear,
    publicLawNumber: proof.publicLawNumber,
    enactmentDate: proof.enactmentDate,
    explicitLineAuthority: proof.explicitLineAuthority,
    fullYearEnacted: false as const,
  };
}
