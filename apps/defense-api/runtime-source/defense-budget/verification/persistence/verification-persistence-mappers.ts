/**
 * Workstream L3/L4/L5 — Persistence mappers.
 *
 * Map between the verification contract types and the Prisma model rows.
 * Also enforces status transition validation (L5).
 *
 * R3: Added deterministic UUID generation for candidate and run IDs.
 * IDs are derived from the canonical identity material so that inspect
 * and persist modes produce the same IDs.
 */
import { createHash } from 'node:crypto';
import type {
  VerificationCheckV1,
  VerificationDiscrepancyV1,
  DefenseBudgetVerificationResultV1,
} from '../verification-contract-v1.js';
import type { VerificationCandidateStatusV1 } from '../verification-contract-v1.js';
import type {
  CandidateIdentityV1,
  ProofSnapshotInputV1,
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
    throw new Error(`invalid candidate status transition: ${from} -> ${to}`);
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic UUID generation (R3)                                  */
/* ------------------------------------------------------------------ */

/**
 * Generate a deterministic UUID v5 from a string input.
 * Uses a fixed namespace UUID so results are reproducible across runs.
 */
const NAMESPACE_UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace

export function deterministicUuid(input: string): string {
  const hash = createHash('sha256').update(NAMESPACE_UUID).update(input).digest();

  const bytes = new Uint8Array(hash);
  // Set version (5 = SHA-1 based, but we use SHA-256; set to 5 for semantic)
  const b6 = bytes[6] ?? 0;
  bytes[6] = (b6 & 0x0f) | 0x50;
  // Set variant (10xx)
  const b8 = bytes[8] ?? 0;
  bytes[8] = (b8 & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Compute a deterministic candidate UUID from the full candidate identity.
 * Inspect and persist modes produce the same ID.
 */
export function computeCandidateId(identity: CandidateIdentityV1): string {
  const material = [
    identity.cycleId,
    identity.manifestContentSha256,
    identity.manifestDocumentKey,
    identity.sourceDocumentId,
    identity.sourceSha256,
    identity.extractionArtifactId,
    identity.extractionArtifactSha256,
    identity.verifierVersion,
    identity.policyVersion,
    identity.policySha256,
  ].join('|');
  return deterministicUuid(material);
}

/**
 * Compute a deterministic run UUID from the candidate identity and an
 * attempt identity. R8.1 §5.2: the default (exact) verification uses a
 * fixed attempt identity ("0") so the run ID is stable across invocations
 * and an exact replay returns the persisted run. A new attempt must be
 * explicit — pass a distinct attemptId to force a fresh run ID.
 */
export function computeRunId(identity: CandidateIdentityV1, attemptId: string): string {
  const material = [
    identity.cycleId,
    identity.manifestContentSha256,
    identity.manifestDocumentKey,
    identity.sourceDocumentId,
    identity.sourceSha256,
    identity.extractionArtifactId,
    identity.extractionArtifactSha256,
    identity.verifierVersion,
    identity.policyVersion,
    identity.policySha256,
    attemptId,
  ].join('|');
  return deterministicUuid(material);
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
  resultSnapshot: JsonValue;
} {
  return {
    id: result.verificationRunId,
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
    resultSnapshot: result as unknown as JsonValue,
  };
}

/* ------------------------------------------------------------------ */
/* Candidate status from decision                                      */
/* ------------------------------------------------------------------ */

export function statusFromDecision(
  decision: 'PASS' | 'REVIEW' | 'REJECT',
): VerificationCandidateStatusV1 {
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
    identity.cycleId,
    identity.manifestContentSha256,
    identity.manifestDocumentKey,
    identity.sourceDocumentId,
    identity.sourceSha256,
    identity.extractionArtifactId,
    identity.extractionArtifactSha256,
    identity.verifierVersion,
    identity.policyVersion,
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
  resultSnapshot: unknown;
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
    completedAt:
      typeof row.completedAt === 'string' ? row.completedAt : row.completedAt.toISOString(),
    manifestContentSha256: row.manifestContentSha256,
    extractionArtifactSha256: row.extractionArtifactSha256,
    sourceSha256: row.sourceSha256,
    resultSnapshot: row.resultSnapshot,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : row.createdAt.toISOString(),
  };
}
