/**
 * Workstream L1 — Repository contract for V1 budget verification.
 *
 * Exposes high-level atomic methods, not one method per table insert.
 * Does not expose the Phase 0 five-call persistence sequence.
 */
import type { DefenseBudgetVerificationResultV1 } from '../verification-contract-v1.js';
import type {
  VerificationCheckV1,
  VerificationDiscrepancyV1,
} from '../verification-contract-v1.js';
import type {
  TrustedVerificationProofBundleV1,
  ProofFindingV1,
} from '../trusted-proof/trusted-proof-types.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* Input types                                                         */
/* ------------------------------------------------------------------ */

export interface CandidateIdentityV1 {
  cycleId: string;
  manifestContentSha256: string;
  manifestDocumentKey: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  extractionArtifactLocator: string;
  sourceDocumentId: string;
  sourceSha256: string;
  verifierVersion: string;
  policyVersion: string;
  policySha256: string;
}

export interface ProofSnapshotInputV1 {
  proofKind: string;
  status: string;
  sourceDocumentId?: string;
  artifactId?: string;
  referenceArtifactId?: string;
  evidenceJson: Record<string, unknown>;
}

export interface PersistCompletedVerificationInputV1 {
  candidateIdentity: CandidateIdentityV1;
  result: DefenseBudgetVerificationResultV1;
  proofBundle: TrustedVerificationProofBundleV1;
  proofFindings: ProofFindingV1[];
  proofSnapshots: ProofSnapshotInputV1[];
  checks: VerificationCheckV1[];
  discrepancies: VerificationDiscrepancyV1[];
  startedAt: string;
  completedAt: string;
  /**
   * Phase 7 Gap 5 decision 1. The resolved artifact, so the candidate row can
   * record its `family` and `extractionMethod` instead of leaving promotion
   * eligibility to rediscover metadata that was verified here. Optional so the
   * many existing callers and fakes keep compiling; when absent, both columns
   * stay NULL and the promotion read path refuses the candidate rather than
   * guessing.
   */
  artifact?: DefenseBudgetExtractionArtifactV1;
}

export interface PersistReviewDecisionInputV1 {
  candidateId: string;
  verificationRunId: string;
  reviewerId: string;
  decision: 'accept' | 'reject';
  notes: string;
  evidenceIds: string[];
  expectedSourceSha256: string;
  expectedExtractionArtifactSha256: string;
  expectedManifestContentSha256: string;
}

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface PersistedCandidateV1 {
  id: string;
  status: string;
  currentRunId: string | null;
}

export interface PersistedRunV1 {
  id: string;
  candidateId: string;
  decision: string;
  status: string;
  route: string;
  riskScore: number;
}

export interface PersistedReviewDecisionV1 {
  id: string;
  candidateId: string;
  runId: string;
  decision: string;
  createdAt: string;
}

export interface ReadCandidateV1 {
  id: string;
  cycleId: string;
  manifestContentSha256: string;
  manifestDocumentKey: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  sourceDocumentId: string;
  sourceSha256: string;
  verifierVersion: string;
  policyVersion: string;
  policySha256: string;
  status: string;
  currentRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReadRunV1 {
  id: string;
  candidateId: string;
  verifierVersion: string;
  policyVersion: string;
  policySha256: string;
  decision: string;
  status: string;
  route: string;
  riskScore: number;
  startedAt: string;
  completedAt: string;
  manifestContentSha256: string;
  extractionArtifactSha256: string;
  sourceSha256: string;
  resultSnapshot: unknown;
  createdAt: string;
}

export interface ReadCheckV1 {
  checkId: string;
  code: string;
  ruleVersion: string;
  outcome: string;
  required: boolean;
  blocking: boolean;
  riskPoints: number;
  message: string;
  assertionIds: string[];
  evidenceIds: string[];
  referenceArtifactIds: string[];
  details?: Record<string, unknown>;
}

export interface ReadDiscrepancyV1 {
  discrepancyId: string;
  code: string;
  severity: string;
  description: string;
  assertionIds: string[];
  evidenceIds: string[];
  referenceArtifactIds: string[];
  details?: Record<string, unknown>;
}

export interface ReadProofSnapshotV1 {
  proofKind: string;
  status: string;
  sourceDocumentId: string | null;
  artifactId: string | null;
  referenceArtifactId: string | null;
  evidenceJson: Record<string, unknown>;
}

export interface ReadReviewDecisionV1 {
  id: string;
  candidateId: string;
  runId: string;
  reviewerId: string;
  decision: string;
  notes: string;
  sourceSha256: string;
  extractionArtifactSha256: string;
  manifestContentSha256: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Repository contract (L1)                                           */
/* ------------------------------------------------------------------ */

export interface BudgetVerificationRepositoryV1 {
  /** Find an existing terminal run by exact candidate identity. */
  findTerminalRunByIdentity(
    identity: CandidateIdentityV1,
  ): Promise<{ candidate: ReadCandidateV1; run: ReadRunV1 } | null>;

  /** Persist a completed verification run and all associated audit rows atomically. */
  persistCompletedVerification(
    input: PersistCompletedVerificationInputV1,
  ): Promise<{ candidate: PersistedCandidateV1; run: PersistedRunV1 }>;

  /** Persist an immutable review decision and update candidate status atomically. */
  persistReviewDecision(input: PersistReviewDecisionInputV1): Promise<PersistedReviewDecisionV1>;

  /** Read a candidate by ID. */
  readCandidate(candidateId: string): Promise<ReadCandidateV1 | null>;

  /** Read a run by ID. */
  readRun(runId: string): Promise<ReadRunV1 | null>;

  /** Read all checks for a run. */
  readChecks(runId: string): Promise<ReadCheckV1[]>;

  /** Read all discrepancies for a run. */
  readDiscrepancies(runId: string): Promise<ReadDiscrepancyV1[]>;

  /** Read all proof findings (as snapshots) for a run. */
  readProofSnapshots(runId: string): Promise<ReadProofSnapshotV1[]>;

  /** Read all prior review decisions for a candidate. */
  readReviewDecisions(candidateId: string): Promise<ReadReviewDecisionV1[]>;
}
