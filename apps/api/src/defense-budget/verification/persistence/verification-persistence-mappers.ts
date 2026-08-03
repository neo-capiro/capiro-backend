/**
 * Workstream L3/L4/L5 — Persistence mappers.
 *
 * Map between the verification contract types and the Prisma model rows.
 * Also enforces status transition validation (L5).
 */
import type {
  VerificationCheckV1,
  VerificationDiscrepancyV1,
  DefenseBudgetVerificationResultV1,
} from '../verification-contract-v1.js';
import type { VerificationCandidateStatusV1 } from '../verification-contract-v1.js';
import type {
  CandidateIdentityV1,
  ProofSnapshotInputV1,
  PersistCompletedVerificationInputV1,
  ReadCandidateV1,
  ReadRunV1,
} from './verification-repository.js';
import type { JsonValue } from '../../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* Status transitions (L5)                                            */
/* ------------------------------------------------------------------ */

const VALID_TRANSITIONS: Record<string, readonly string[]> = {
  EXTRACTED: ['VALIDATING'],
  STRUCTURALLY_VALIDATED: ['VALIDATING'],
  VALIDATING: ['VERIFICATION_PASSED', 'NEEDS_REVIEW', 'REJECTED'],
  NEEDS_REVIEW: ['REVIEW_ACCEPTED', 'REJECTED'],
  VERIFICATION_PASSED: ['SUPERSEDED'],
  REVIEW_ACCEPTED: ['SUPERSEDED'],
  REJECTED: ['SUPERSEDED'],
  SUPERSEDED: [],
};

export function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export function assertValidTransition(from: string, to: string): void {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `invalid candidate status transition: ${from} -> ${to}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Check mappers                                                       */
/* ------------------------------------------------------------------ */

export function mapCheckToRow(
  runId: string,
  check: VerificationCheckV1,
): {
  runId: string;
  checkId: string;
  code: string;
  ruleVersion: string;
  outcome: string;
  required: boolean;
  blocking: boolean;
  riskPoints: number;
  message: string;
  assertionIds: JsonValue;
  evidenceIds: JsonValue;
  referenceArtifactIds: JsonValue;
  details: JsonValue | null;
  passed: boolean;
} {
  return {
    runId,
    checkId: check.checkId,
    code: check.code,
    ruleVersion: check.ruleVersion,
    outcome: check.outcome,
    required: check.required,
    blocking: check.blocking,
    riskPoints: check.riskPoints,
    message: check.message,
    assertionIds: check.assertionIds as unknown as JsonValue,
    evidenceIds: check.evidenceIds as unknown as JsonValue,
    referenceArtifactIds: check.referenceArtifactIds as unknown as JsonValue,
    details: (check.details ?? null) as JsonValue | null,
    passed: check.outcome === 'PASS',
  };
}

/* ------------------------------------------------------------------ */
/* Discrepancy mappers                                                 */
/* ------------------------------------------------------------------ */

export function mapDiscrepancyToRow(
  runId: string,
  candidateId: string,
  discrepancy: VerificationDiscrepancyV1,
): {
  runId: string;
  candidateId: string;
  discrepancyId: string;
  code: string;
  severity: string;
  description: string;
  assertionIds: JsonValue;
  evidenceIds: JsonValue;
  referenceArtifactIds: JsonValue;
  details: JsonValue | null;
} {
  return {
    runId,
    candidateId,
    discrepancyId: discrepancy.discrepancyId,
    code: discrepancy.code,
    severity: discrepancy.severity,
    description: discrepancy.description,
    assertionIds: discrepancy.assertionIds as unknown as JsonValue,
    evidenceIds: discrepancy.evidenceIds as unknown as JsonValue,
    referenceArtifactIds: discrepancy.referenceArtifactIds as unknown as JsonValue,
    details: (discrepancy.details ?? null) as JsonValue | null,
  };
}

/* ------------------------------------------------------------------ */
/* Proof snapshot mappers                                               */
/* ------------------------------------------------------------------ */

export function mapProofSnapshotToRow(
  runId: string,
  snapshot: ProofSnapshotInputV1,
): {
  runId: string;
  proofKind: string;
  status: string;
  sourceDocumentId: string | null;
  artifactId: string | null;
  referenceArtifactId: string | null;
  evidenceJson: JsonValue;
} {
  return {
    runId,
    proofKind: snapshot.proofKind,
    status: snapshot.status,
    sourceDocumentId: snapshot.sourceDocumentId ?? null,
    artifactId: snapshot.artifactId ?? null,
    referenceArtifactId: snapshot.referenceArtifactId ?? null,
    evidenceJson: snapshot.evidenceJson as unknown as JsonValue,
  };
}

/* ------------------------------------------------------------------ */
/* Run mappers                                                          */
/* ------------------------------------------------------------------ */

export function mapResultToRunRow(
  result: DefenseBudgetVerificationResultV1,
  candidateId: string,
): {
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
} {
  return {
    candidateId,
    verifierVersion: result.verifierVersion,
    policyVersion: result.policyVersion,
    policySha256: result.policySha256,
    decision: result.decision,
    status: result.status,
    route: result.route,
    riskScore: result.riskScore,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    manifestContentSha256: result.manifestContentSha256,
    extractionArtifactSha256: result.extractionArtifactSha256,
    sourceSha256: result.sourcePdfSha256,
  };
}

/* ------------------------------------------------------------------ */
/* Candidate status from decision                                      */
/* ------------------------------------------------------------------ */

export function statusFromDecision(decision: 'PASS' | 'REVIEW' | 'REJECT'): VerificationCandidateStatusV1 {
  switch (decision) {
    case 'PASS':
      return 'VERIFICATION_PASSED';
    case 'REVIEW':
      return 'NEEDS_REVIEW';
    case 'REJECT':
      return 'REJECTED';
  }
}

/* ------------------------------------------------------------------ */
/* Identity-based idempotency key                                      */
/* ------------------------------------------------------------------ */

export function candidateIdempotencyKey(identity: CandidateIdentityV1): string {
  return [
    identity.manifestContentSha256,
    identity.sourceSha256,
    identity.extractionArtifactSha256,
    identity.verifierVersion,
    identity.policySha256,
  ].join('|');
}

/* ------------------------------------------------------------------ */
/* Read mappers (from Prisma rows to contract types)                   */
/* ------------------------------------------------------------------ */

export function mapRowToReadCandidate(row: {
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
  createdAt: Date | string;
  updatedAt: Date | string;
}): ReadCandidateV1 {
  return {
    id: row.id,
    cycleId: row.cycleId,
    manifestContentSha256: row.manifestContentSha256,
    manifestDocumentKey: row.manifestDocumentKey,
    extractionArtifactId: row.extractionArtifactId,
    extractionArtifactSha256: row.extractionArtifactSha256,
    sourceDocumentId: row.sourceDocumentId,
    sourceSha256: row.sourceSha256,
    verifierVersion: row.verifierVersion,
    policyVersion: row.policyVersion,
    policySha256: row.policySha256,
    status: row.status,
    currentRunId: row.currentRunId,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : row.createdAt.toISOString(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : row.updatedAt.toISOString(),
  };
}

export function mapRowToReadRun(row: {
  id: string;
  candidateId: string;
  verifierVersion: string;
  policyVersion: string;
  policySha256: string;
  decision: string;
  status: string;
  route: string;
  riskScore: number;
  startedAt: Date | string;
  completedAt: Date | string;
  manifestContentSha256: string;
  extractionArtifactSha256: string;
  sourceSha256: string;
  createdAt: Date | string;
}): ReadRunV1 {
  return {
    id: row.id,
    candidateId: row.candidateId,
    verifierVersion: row.verifierVersion,
    policyVersion: row.policyVersion,
    policySha256: row.policySha256,
    decision: row.decision,
    status: row.status,
    route: row.route,
    riskScore: row.riskScore,
    startedAt: typeof row.startedAt === 'string' ? row.startedAt : row.startedAt.toISOString(),
    completedAt: typeof row.completedAt === 'string' ? row.completedAt : row.completedAt.toISOString(),
    manifestContentSha256: row.manifestContentSha256,
    extractionArtifactSha256: row.extractionArtifactSha256,
    sourceSha256: row.sourceSha256,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : row.createdAt.toISOString(),
  };
}
