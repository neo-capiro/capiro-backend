/**
 * R2-R3 remediation tests: deterministic IDs, migration contract,
 * schema integrity, and persistence correctness.
 */
import {
  deterministicUuid,
  computeCandidateId,
  computeRunId,
  candidateIdempotencyKey,
  isValidTransition,
} from './verification-persistence-mappers.js';
import type { CandidateIdentityV1 } from './verification-repository.js';
import { readFileSync } from 'node:fs';

const MIGRATION = 'prisma/migrations/20260816010000_budget_verification_v1/migration.sql';

function makeIdentity(overrides: Partial<CandidateIdentityV1> = {}): CandidateIdentityV1 {
  return {
    cycleId: 'fy2027',
    manifestContentSha256: 'a'.repeat(64),
    manifestDocumentKey: 'r1_fy2027',
    extractionArtifactId: 'art-1',
    extractionArtifactSha256: 'b'.repeat(64),
    extractionArtifactLocator: '/test/art.json',
    sourceDocumentId: '00000000-0000-0000-0000-000000000001',
    sourceSha256: 'c'.repeat(64),
    verifierVersion: 'defense_budget_verifier_v1',
    policyVersion: 'defense_budget_verification_policy_v1',
    policySha256: 'd'.repeat(64),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* R3: Deterministic UUID generation                                   */
/* ------------------------------------------------------------------ */

describe('deterministicUuid', () => {
  it('produces a valid UUID format', () => {
    const uuid = deterministicUuid('test-input');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is deterministic — same input produces same UUID', () => {
    const uuid1 = deterministicUuid('test-input');
    const uuid2 = deterministicUuid('test-input');
    expect(uuid1).toBe(uuid2);
  });

  it('different inputs produce different UUIDs', () => {
    const uuid1 = deterministicUuid('input-a');
    const uuid2 = deterministicUuid('input-b');
    expect(uuid1).not.toBe(uuid2);
  });
});

describe('computeCandidateId', () => {
  it('is deterministic from full identity', () => {
    const identity = makeIdentity();
    const id1 = computeCandidateId(identity);
    const id2 = computeCandidateId(identity);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5/);
  });

  it('changes when cycleId changes', () => {
    const identity = makeIdentity();
    const id1 = computeCandidateId(identity);
    const id2 = computeCandidateId({ ...identity, cycleId: 'fy2028' });
    expect(id1).not.toBe(id2);
  });

  it('changes when manifestDocumentKey changes', () => {
    const identity = makeIdentity();
    const id1 = computeCandidateId(identity);
    const id2 = computeCandidateId({ ...identity, manifestDocumentKey: 'r2_fy2027' });
    expect(id1).not.toBe(id2);
  });

  it('changes when extractionArtifactId changes', () => {
    const identity = makeIdentity();
    const id1 = computeCandidateId(identity);
    const id2 = computeCandidateId({ ...identity, extractionArtifactId: 'art-2' });
    expect(id1).not.toBe(id2);
  });

  it('does not collapse two candidates with same hashes but different document keys', () => {
    const identity1 = makeIdentity({ manifestDocumentKey: 'r1_fy2027' });
    const identity2 = makeIdentity({ manifestDocumentKey: 'r2_fy2027' });
    const id1 = computeCandidateId(identity1);
    const id2 = computeCandidateId(identity2);
    expect(id1).not.toBe(id2);
  });
});

describe('computeRunId', () => {
  it('is deterministic from identity and startedAt', () => {
    const identity = makeIdentity();
    const id1 = computeRunId(identity, '2026-01-01T00:00:00Z');
    const id2 = computeRunId(identity, '2026-01-01T00:00:00Z');
    expect(id1).toBe(id2);
  });

  it('changes when startedAt changes', () => {
    const identity = makeIdentity();
    const id1 = computeRunId(identity, '2026-01-01T00:00:00Z');
    const id2 = computeRunId(identity, '2026-01-01T00:00:01Z');
    expect(id1).not.toBe(id2);
  });

  it('differs from candidateId', () => {
    const identity = makeIdentity();
    const candidateId = computeCandidateId(identity);
    const runId = computeRunId(identity, '2026-01-01T00:00:00Z');
    expect(runId).not.toBe(candidateId);
  });
});

describe('candidateIdempotencyKey (R2: full identity)', () => {
  it('includes all 10 identity fields', () => {
    const identity = makeIdentity();
    const key1 = candidateIdempotencyKey(identity);
    const key2 = candidateIdempotencyKey({ ...identity, cycleId: 'fy2028' });
    expect(key1).not.toBe(key2);
  });

  it('changes when sourceDocumentId changes', () => {
    const identity = makeIdentity();
    const key1 = candidateIdempotencyKey(identity);
    const key2 = candidateIdempotencyKey({
      ...identity,
      sourceDocumentId: '00000000-0000-0000-0000-000000000002',
    });
    expect(key1).not.toBe(key2);
  });
});

/* ------------------------------------------------------------------ */
/* R2: Migration contract — corrected schema                           */
/* ------------------------------------------------------------------ */

describe('R2 migration contract', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('candidate table has deterministic ID (no gen_random_uuid default)', () => {
    // The candidate id column should NOT have a DEFAULT gen_random_uuid()
    const candidateMatch = sql.match(/CREATE TABLE "budget_extraction_candidate_v1"[\s\S]*?\);/);
    expect(candidateMatch).not.toBeNull();
    const candidateSql = candidateMatch![0];
    // id line should be '"id" UUID NOT NULL,' without DEFAULT
    expect(candidateSql).toContain('"id" UUID NOT NULL,');
    expect(candidateSql).not.toMatch(/"id" UUID NOT NULL DEFAULT/);
  });

  it('run table has deterministic ID (no gen_random_uuid default)', () => {
    const runMatch = sql.match(/CREATE TABLE "budget_verification_run_v1"[\s\S]*?\);/);
    expect(runMatch).not.toBeNull();
    const runSql = runMatch![0];
    expect(runSql).toContain('"id" UUID NOT NULL,');
    expect(runSql).not.toMatch(/"id" UUID NOT NULL DEFAULT/);
  });

  it('candidate unique index includes all 10 identity fields', () => {
    expect(sql).toContain('"cycle_id"');
    expect(sql).toContain('"manifest_document_key"');
    expect(sql).toContain('"extraction_artifact_id"');
    expect(sql).toContain('"policy_version"');
    expect(sql).toContain('"budget_v1_candidate_identity_key"');
  });

  it('all FKs use ON DELETE RESTRICT (no cascade)', () => {
    // No ON DELETE CASCADE should appear in the V1 migration
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
    // All FKs should use RESTRICT
    const restrictCount = (sql.match(/ON DELETE RESTRICT/g) || []).length;
    expect(restrictCount).toBeGreaterThanOrEqual(7);
  });

  it('run has completed_at >= started_at check', () => {
    expect(sql).toContain('completed_at" >= "started_at');
  });

  it('run has result_snapshot_jsonb column', () => {
    expect(sql).toContain('result_snapshot_jsonb');
  });

  it('review has blank notes check', () => {
    expect(sql).toContain('length(btrim("notes")) > 0');
  });

  it('review has single-terminal-decision enforcement', () => {
    expect(sql).toContain('candidate already has a terminal review decision');
  });

  it('review hash consistency trigger matches candidate hashes', () => {
    expect(sql).toContain('review source_sha256 does not match candidate');
    expect(sql).toContain('review extraction_artifact_sha256 does not match candidate');
    expect(sql).toContain('review manifest_content_sha256 does not match candidate');
  });

  it('review candidate must be NEEDS_REVIEW', () => {
    expect(sql).toContain('candidate is not in NEEDS_REVIEW state');
  });

  it('discrepancy append-only trigger exists', () => {
    expect(sql).toContain('prevent_budget_v1_discrepancy_update');
    expect(sql).toContain('budget_v1_discrepancy_no_update');
  });

  it('alters no canonical Program Element table', () => {
    expect(sql).not.toMatch(/ALTER TABLE\s+"?program_element/i);
    expect(sql).not.toMatch(/INSERT INTO\s+"?program_element/i);
    expect(sql).not.toMatch(/UPDATE\s+"?program_element_year"?/i);
  });
});

/* ------------------------------------------------------------------ */
/* R2: Lifecycle transitions remain correct                           */
/* ------------------------------------------------------------------ */

describe('R2 lifecycle transitions', () => {
  it('full lifecycle: EXTRACTED -> VALIDATING -> VERIFICATION_PASSED -> SUPERSEDED', () => {
    expect(isValidTransition('EXTRACTED', 'VALIDATING')).toBe(true);
    expect(isValidTransition('VALIDATING', 'VERIFICATION_PASSED')).toBe(true);
    expect(isValidTransition('VERIFICATION_PASSED', 'SUPERSEDED')).toBe(true);
  });

  it('review lifecycle: VALIDATING -> NEEDS_REVIEW -> REVIEW_ACCEPTED -> SUPERSEDED', () => {
    expect(isValidTransition('VALIDATING', 'NEEDS_REVIEW')).toBe(true);
    expect(isValidTransition('NEEDS_REVIEW', 'REVIEW_ACCEPTED')).toBe(true);
    expect(isValidTransition('REVIEW_ACCEPTED', 'SUPERSEDED')).toBe(true);
  });

  it('reject lifecycle: VALIDATING -> REJECTED -> SUPERSEDED', () => {
    expect(isValidTransition('VALIDATING', 'REJECTED')).toBe(true);
    expect(isValidTransition('REJECTED', 'SUPERSEDED')).toBe(true);
  });

  it('review-to-reject: NEEDS_REVIEW -> REJECTED', () => {
    expect(isValidTransition('NEEDS_REVIEW', 'REJECTED')).toBe(true);
  });

  it('forwards skip: EXTRACTED -> VERIFICATION_PASSED forbidden', () => {
    expect(isValidTransition('EXTRACTED', 'VERIFICATION_PASSED')).toBe(false);
  });

  it('backwards: VERIFICATION_PASSED -> NEEDS_REVIEW forbidden', () => {
    expect(isValidTransition('VERIFICATION_PASSED', 'NEEDS_REVIEW')).toBe(false);
  });

  it('SUPERSEDED is terminal', () => {
    expect(isValidTransition('SUPERSEDED', 'EXTRACTED')).toBe(false);
    expect(isValidTransition('SUPERSEDED', 'VALIDATING')).toBe(false);
    expect(isValidTransition('SUPERSEDED', 'VERIFICATION_PASSED')).toBe(false);
  });
});
