/** Exact synthetic Phase 3/Phase 2 fixtures for Phase 4 closeout tests. */
import { sha256CanonicalJson, type JsonValue } from '../../contracts/canonical-json.js';
import type { BudgetCycleManifestDocumentV1 } from '../../contracts/budget-cycle-manifest-v1.js';
import type { ParserRunV1 } from '../../contracts/extraction-artifact-v1.js';
import type { RdteCycleVerificationRefV1 } from '../rdte-cycle-bundle-v1.js';
import type {
  BuiltRdteArtifactV1,
  RdteCycleArtifactBuildResult,
} from './rdte-cycle-pipeline-v1.js';
import type { RdteCycleDocumentInputV1 } from './rdte-phase3-document-input-v1.js';
import {
  GOLDEN_SHA,
  goldenManifestDocument,
  goldenPagesByKey,
  goldenSource,
} from './rdte-golden-cycle-v1.js';

export const GOLDEN_DOCUMENT_KEYS = [
  'golden_r1',
  'golden_r2',
  'golden_r2a',
  'golden_r3',
  'golden_r4',
] as const;

const REQUIRED_CATEGORIES: Record<string, BudgetCycleManifestDocumentV1['requiredDataCategories']> =
  {
    golden_r1: ['identity', 'funding'],
    golden_r2: ['identity', 'narrative', 'funding'],
    golden_r2a: ['projects', 'project_funding'],
    golden_r3: ['performers'],
    golden_r4: ['milestones'],
  };

function parserRunFor(key: string, pages: RdteCycleDocumentInputV1['pages']): ParserRunV1 {
  const pageNumbers = pages.map((page) => page.page).sort((a, b) => a - b);
  return {
    parserRunId: `golden_parser_run_${key}`,
    method: 'native_structured',
    parserVersion: 'golden-structured-v1',
    parserConfigSha256: sha256CanonicalJson({ key, config: 'golden' }),
    inputSourceSha256: GOLDEN_SHA,
    outputArtifactSha256: sha256CanonicalJson(pages as unknown as JsonValue),
    pageRanges:
      pageNumbers.length > 0 ? [{ startPage: pageNumbers[0]!, endPage: pageNumbers.at(-1)! }] : [],
  };
}

export function goldenCloseoutDocument(key: string): RdteCycleDocumentInputV1 {
  const pages = goldenPagesByKey()[key] ?? [];
  return {
    document: {
      ...goldenManifestDocument(key),
      requiredDataCategories: REQUIRED_CATEGORIES[key] ?? [],
    },
    source: {
      ...goldenSource(key),
      sourceDocumentId: `golden_source_document_${key}`,
    },
    pages,
    parserRuns: [parserRunFor(key, pages)],
    unresolvedPages: [],
  };
}

export function goldenCloseoutDocuments(): RdteCycleDocumentInputV1[] {
  return GOLDEN_DOCUMENT_KEYS.map((key) => goldenCloseoutDocument(key));
}

function verificationForArtifact(input: {
  artifact: BuiltRdteArtifactV1;
  sourceDocumentId: string;
  sourcePdfSha256: string;
  manifestContentSha256: string;
  phase2Decision?: 'PASS' | 'REVIEW' | 'REJECT';
  status?: 'VERIFICATION_PASSED' | 'NEEDS_REVIEW' | 'REVIEW_ACCEPTED' | 'REJECTED';
}): RdteCycleVerificationRefV1 {
  const phase2Decision = input.phase2Decision ?? 'PASS';
  const status =
    input.status ??
    (phase2Decision === 'PASS'
      ? 'VERIFICATION_PASSED'
      : phase2Decision === 'REJECT'
        ? 'REJECTED'
        : 'NEEDS_REVIEW');
  const verificationRunId = `golden_verification_run_${input.artifact.documentKey}`;
  const candidateId = `golden_candidate_${input.artifact.documentKey}`;
  return {
    manifestDocumentKey: input.artifact.documentKey,
    manifestContentSha256: input.manifestContentSha256,
    artifactId: input.artifact.artifactRef.artifactId,
    artifactContentSha256: input.artifact.artifactRef.artifactContentSha256,
    artifactByteSha256: input.artifact.artifactRef.artifactByteSha256,
    candidateId,
    verificationRunId,
    policySha256: sha256CanonicalJson({
      documentKey: input.artifact.documentKey,
      policy: 'golden-phase2',
    }),
    sourceDocumentId: input.sourceDocumentId,
    sourcePdfSha256: input.sourcePdfSha256,
    phase2Decision,
    status,
    acceptedAssertionIds:
      // PASS and immutable REVIEW_ACCEPTED both authorize projection of
      // assertion bytes; NEEDS_REVIEW / REJECT leave the ledger empty.
      phase2Decision === 'PASS' || status === 'REVIEW_ACCEPTED'
        ? input.artifact.artifact.assertions.map((assertion) => assertion.assertionId).sort()
        : [],
    rejectedAssertionIds:
      phase2Decision === 'REJECT'
        ? input.artifact.artifact.assertions.map((assertion) => assertion.assertionId).sort()
        : [],
    verificationCandidateId: candidateId,
    decision: status,
    decisionId: verificationRunId,
  };
}

export function goldenCloseoutVerifications(input: {
  build: RdteCycleArtifactBuildResult;
  manifestContentSha256: string;
  override?: Partial<
    Record<
      string,
      {
        phase2Decision: 'PASS' | 'REVIEW' | 'REJECT';
        status: 'VERIFICATION_PASSED' | 'NEEDS_REVIEW' | 'REVIEW_ACCEPTED' | 'REJECTED';
      }
    >
  >;
}): RdteCycleVerificationRefV1[] {
  const documentByKey = new Map(
    input.build.documents.map((document) => [document.document.documentKey, document]),
  );
  return input.build.artifacts.map((artifact) => {
    const document = documentByKey.get(artifact.documentKey);
    if (!document) throw new Error(`missing golden source for ${artifact.documentKey}`);
    const override = input.override?.[artifact.documentKey];
    return verificationForArtifact({
      artifact,
      sourceDocumentId: document.source.sourceDocumentId,
      sourcePdfSha256: document.source.sourcePdfSha256,
      manifestContentSha256: input.manifestContentSha256,
      ...(override ? override : {}),
    });
  });
}
