/** Phase 6 Workstream L — enacted funding requires an independently proved enactment chain. */
import {
  DEFENSE_BUDGET_ENACTMENT_PROOF_FIELD,
  defenseBudgetEnactmentProofV1Schema,
} from '../../stages/enacted/enactment-proof-v1.js';
import {
  failCheck,
  makeDiscrepancy,
  passCheck,
  skippedCheck,
  type VerificationRuleV1,
} from './rule-types.js';

function artifactSourceDocumentId(artifact: {
  source: { sourceDocumentId?: string; manifestDocumentKey: string };
}): string {
  return artifact.source.sourceDocumentId ?? artifact.source.manifestDocumentKey;
}

export const ENACTMENT_PROOF_RULE: VerificationRuleV1 = {
  code: 'enactment_proof',
  name: 'Enactment proof',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: true,
  riskPoints: 100,
  execute(ctx) {
    const enacted = ctx.input.artifact.assertions.filter(
      (assertion) => assertion.assertionKind === 'funding' && assertion.field === 'enacted',
    );
    if (enacted.length === 0) {
      return {
        check: skippedCheck(
          ENACTMENT_PROOF_RULE,
          ctx.verificationRunId,
          'artifact has no enacted funding assertions',
        ),
        discrepancies: [],
      };
    }

    const assertionIds = enacted.map((item) => item.assertionId);
    const evidenceIds = [...new Set(enacted.flatMap((item) => item.evidenceIds))];
    const proofAssertions = ctx.input.artifact.assertions.filter(
      (assertion) =>
        assertion.assertionKind === 'document_fact' &&
        assertion.fieldName === DEFENSE_BUDGET_ENACTMENT_PROOF_FIELD,
    );

    const failure = (
      code: string,
      message: string,
      referenceArtifactIds: readonly string[] = [],
      details: Record<string, string | number | boolean | null> = {},
    ) => ({
      check: failCheck(
        ENACTMENT_PROOF_RULE,
        ctx.verificationRunId,
        assertionIds,
        evidenceIds,
        referenceArtifactIds,
        message,
        details,
        { required: true, blocking: true, riskPoints: 100 },
      ),
      discrepancies: [
        makeDiscrepancy(
          code,
          'blocking',
          message,
          assertionIds,
          evidenceIds,
          referenceArtifactIds,
          details,
        ),
      ],
    });

    if (proofAssertions.length !== 1) {
      return failure(
        'enactment_proof_missing_or_ambiguous',
        'enacted assertions require exactly one explicit enactment-proof fact; public-law label alone is insufficient',
        [],
        { proofAssertionCount: proofAssertions.length },
      );
    }

    const proofAssertion = proofAssertions[0]!;
    const parsed = defenseBudgetEnactmentProofV1Schema.safeParse(proofAssertion.value);
    if (!parsed.success) {
      return failure('enactment_proof_invalid', 'enactment proof failed strict schema validation');
    }
    const proof = parsed.data;
    if (proof.reviewerStatus === 'pending' || proof.reviewerStatus === 'rejected') {
      return failure(
        'enactment_proof_not_reviewed',
        `enactment proof reviewer status '${proof.reviewerStatus}' cannot support enacted funding`,
      );
    }
    if (
      proof.publicLawSource.status !== 'current' ||
      proof.lineDetailSource.status !== 'current' ||
      proof.fiscalYear !== ctx.input.artifact.source.fiscalYear
    ) {
      return failure(
        'enactment_proof_source_mismatch',
        'stale, superseded, or cross-FY enactment proof is forbidden',
      );
    }
    if (proof.vehicleKind === 'continuing_resolution' && !proof.explicitLineAuthority) {
      return failure(
        'continuing_resolution_line_authority_missing',
        'continuing resolution cannot create a line-level enacted position without explicit line authority',
      );
    }

    const lineDetailDocumentId = artifactSourceDocumentId(ctx.input.artifact);
    if (
      lineDetailDocumentId !== proof.lineDetailSource.sourceDocumentId ||
      ctx.input.artifact.source.sourcePdfSha256 !== proof.lineDetailSource.sourceSha256 ||
      ctx.input.artifact.source.manifestDocumentKey !== proof.lineDetailSource.manifestDocumentKey
    ) {
      return failure(
        'enactment_line_detail_proof_mismatch',
        'candidate artifact is not the exact line-detail source named by the enactment proof',
      );
    }

    const proofFactIds = new Set(proofAssertion.sourceFactIds);
    for (const assertion of enacted) {
      if (!assertion.sourceFactIds.some((factId) => proofFactIds.has(factId))) {
        return failure(
          'enactment_assertion_not_bound_to_proof_fact',
          `enacted assertion ${assertion.assertionId} is not source-fact-bound to the enactment proof`,
        );
      }
      if (assertion.metadata?.enactmentProofId !== proof.proofId) {
        return failure(
          'enactment_assertion_proof_id_mismatch',
          `enacted assertion ${assertion.assertionId} does not name proof ${proof.proofId}`,
        );
      }
    }

    const publicLawIsLineDetail =
      proof.publicLawSource.sourceDocumentId === proof.lineDetailSource.sourceDocumentId &&
      proof.publicLawSource.sourceSha256 === proof.lineDetailSource.sourceSha256 &&
      proof.publicLawSource.manifestDocumentKey === proof.lineDetailSource.manifestDocumentKey;

    if (proof.proofType === 'statutory_line_item') {
      if (!publicLawIsLineDetail) {
        return failure(
          'statutory_line_source_mismatch',
          'statutory line-item proof requires the verified artifact itself to be the public-law bytes',
        );
      }
      return {
        check: passCheck(
          ENACTMENT_PROOF_RULE,
          ctx.verificationRunId,
          assertionIds,
          evidenceIds,
          [],
          `direct statutory enacted funding is bound to proof ${proof.proofId}`,
          { proofType: proof.proofType, proofId: proof.proofId },
          { required: true, blocking: true },
        ),
        discrepancies: [],
      };
    }

    if (proof.incorporationEvidence == null) {
      return failure(
        'incorporation_evidence_missing',
        'incorporated enacted funding requires explicit statutory incorporation evidence',
      );
    }

    const matchingReferenceIndex = ctx.input.referenceArtifacts.findIndex((reference) => {
      const referenceDocumentId = reference.source.sourceDocumentId ?? reference.source.manifestDocumentKey;
      return (
        referenceDocumentId === proof.publicLawSource.sourceDocumentId &&
        reference.source.sourcePdfSha256 === proof.publicLawSource.sourceSha256 &&
        reference.source.manifestDocumentKey === proof.publicLawSource.manifestDocumentKey
      );
    });
    if (matchingReferenceIndex < 0) {
      return failure(
        'public_law_reference_missing',
        'incorporated enacted proof requires the exact public-law artifact as an independent trusted reference',
      );
    }

    const reference = ctx.input.referenceArtifacts[matchingReferenceIndex]!;
    const referenceProof = ctx.input.referenceArtifactsProofBundles[matchingReferenceIndex];
    const referenceArtifactIds = [reference.artifactId];
    if (
      referenceProof == null ||
      referenceProof.sourceDocument.id !== proof.publicLawSource.sourceDocumentId ||
      referenceProof.sourceDocument.sourceSha256 !== proof.publicLawSource.sourceSha256 ||
      referenceProof.extractionArtifact.artifactId !== reference.artifactId ||
      referenceProof.extractionArtifact.contentSha256 !== reference.contentSha256
    ) {
      return failure(
        'public_law_reference_proof_mismatch',
        'public-law reference artifact is not independently proof-bound to the exact statute bytes',
        referenceArtifactIds,
      );
    }

    const blockingReferenceFinding = ctx.input.referenceArtifactsFindings.find(
      (finding) =>
        finding.severity === 'blocking' &&
        (finding.artifactId === reference.artifactId ||
          finding.sourceDocumentId === proof.publicLawSource.sourceDocumentId),
    );
    if (blockingReferenceFinding != null) {
      return failure(
        'public_law_reference_proof_failed',
        `public-law trusted reference proof is blocking: ${blockingReferenceFinding.code}`,
        referenceArtifactIds,
      );
    }

    return {
      check: passCheck(
        ENACTMENT_PROOF_RULE,
        ctx.verificationRunId,
        assertionIds,
        evidenceIds,
        referenceArtifactIds,
        `incorporated enacted funding is bound to proof ${proof.proofId} and independently proved public-law reference ${reference.artifactId}`,
        {
          proofType: proof.proofType,
          proofId: proof.proofId,
          publicLawSourceDocumentId: proof.publicLawSource.sourceDocumentId,
        },
        { required: true, blocking: true },
      ),
      discrepancies: [],
    };
  },
};
