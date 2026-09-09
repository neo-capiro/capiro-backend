/**
 * candidate-correction-v1.service.spec -- Phase 10B-35c.
 *
 * Fake-ports unit coverage of `CandidateCorrectionV1Service`, mirroring
 * `scoped-fact-review-v1.service.spec.ts`'s pattern: only the ports the
 * service actually calls are implemented, everything else throws if touched.
 * The real Postgres unique-index arbitration and the real DB triggers are
 * proven separately in `phase10b35c-candidate-correction-e2e.integration.spec.ts`;
 * this spec pins the SERVICE's own orchestration logic (ordering, idempotent
 * replay vs. explicit refusal, always-attempt-supersede-first) fast and
 * deterministically.
 */
import { describe, expect, it } from '@jest/globals';
import { CandidateCorrectionV1Service } from './candidate-correction-v1.service.js';
import type { CandidateCorrectionRepositoryV1, CandidateCorrectionRowV1, InsertCandidateCorrectionInputV1, InsertCandidateCorrectionResultV1 } from './candidate-correction-repository-v1.js';
import type { BudgetVerificationRepositoryV1, ReadCandidateV1 } from '../../verification/persistence/verification-repository.js';
import type { ScopedFactReviewRepositoryV1 } from '../scoped-fact-review/scoped-fact-review-repository-v1.js';

function fakeCandidate(overrides: Partial<ReadCandidateV1> = {}): ReadCandidateV1 {
  return {
    id: 'candidate-old',
    cycleId: 'cycle-1',
    manifestContentSha256: 'a'.repeat(64),
    manifestDocumentKey: 'manifest-key',
    extractionArtifactId: 'artifact-1',
    extractionArtifactSha256: 'b'.repeat(64),
    sourceDocumentId: 'doc-1',
    sourceSha256: 'c'.repeat(64),
    verifierVersion: 'v1',
    policyVersion: '1',
    policySha256: 'd'.repeat(64),
    status: 'NEEDS_REVIEW',
    currentRunId: 'run-1',
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

function unimplemented(name: string) {
  return () => {
    throw new Error(`unimplemented fake method: ${name}`);
  };
}

class FakeVerification implements Partial<BudgetVerificationRepositoryV1> {
  constructor(private readonly candidates: Record<string, ReadCandidateV1 | undefined>) {}
  async readCandidate(id: string): Promise<ReadCandidateV1 | null> {
    return this.candidates[id] ?? null;
  }
  findTerminalRunByIdentity = unimplemented('findTerminalRunByIdentity') as never;
  readRun = unimplemented('readRun') as never;
  readChecks = unimplemented('readChecks') as never;
  readDiscrepancies = unimplemented('readDiscrepancies') as never;
  readProofSnapshots = unimplemented('readProofSnapshots') as never;
  persistCompletedVerification = unimplemented('persistCompletedVerification') as never;
}

class FakeReviews implements Partial<ScopedFactReviewRepositoryV1> {
  public supersedeCalls: Array<{ candidateId: string; actor: string; reason: string; now: string }> = [];
  constructor(private readonly supersededIdsToReturn: string[] = []) {}
  async supersedeAllForCandidate(input: { candidateId: string; actor: string; reason: string; now: string }): Promise<string[]> {
    this.supersedeCalls.push(input);
    return this.supersededIdsToReturn;
  }
  listByCandidate = unimplemented('listByCandidate') as never;
  listActiveByScopeKey = unimplemented('listActiveByScopeKey') as never;
  insertDecision = unimplemented('insertDecision') as never;
  revoke = unimplemented('revoke') as never;
  readById = unimplemented('readById') as never;
}

class FakeCorrections implements CandidateCorrectionRepositoryV1 {
  public insertCalls: InsertCandidateCorrectionInputV1[] = [];
  private rows: CandidateCorrectionRowV1[] = [];
  private nextInsertResults: InsertCandidateCorrectionResultV1[] = [];
  private seq = 0;

  /** Queue what the NEXT insertLink call should return, instead of the
   * default (always succeed). Used to simulate a lost race. */
  queueInsertResult(result: InsertCandidateCorrectionResultV1): void {
    this.nextInsertResults.push(result);
  }

  async insertLink(input: InsertCandidateCorrectionInputV1): Promise<InsertCandidateCorrectionResultV1> {
    this.insertCalls.push(input);
    const queued = this.nextInsertResults.shift();
    if (queued) return queued;
    const row: CandidateCorrectionRowV1 = {
      id: `link-${++this.seq}`,
      createdAt: '2026-09-09T00:00:00.000Z',
      ...input,
    };
    this.rows.push(row);
    return { outcome: 'inserted', row };
  }
  async readByOldCandidateId(oldCandidateId: string): Promise<CandidateCorrectionRowV1 | null> {
    return this.rows.find((r) => r.oldCandidateId === oldCandidateId) ?? null;
  }
  async readByNewCandidateId(newCandidateId: string): Promise<CandidateCorrectionRowV1 | null> {
    return this.rows.find((r) => r.newCandidateId === newCandidateId) ?? null;
  }
  async readById(id: string): Promise<CandidateCorrectionRowV1 | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  /** Test-only: seed a pre-existing row directly, bypassing insertLink. */
  seed(row: CandidateCorrectionRowV1): void {
    this.rows.push(row);
  }
}

function buildService(opts: {
  candidates?: Record<string, ReadCandidateV1 | undefined>;
  supersededIds?: string[];
  corrections?: FakeCorrections;
} = {}) {
  const verification = new FakeVerification(
    opts.candidates ?? { 'candidate-old': fakeCandidate({ id: 'candidate-old' }), 'candidate-new': fakeCandidate({ id: 'candidate-new' }) },
  );
  const reviews = new FakeReviews(opts.supersededIds ?? []);
  const corrections = opts.corrections ?? new FakeCorrections();
  const service = new CandidateCorrectionV1Service(verification as unknown as BudgetVerificationRepositoryV1, reviews as unknown as ScopedFactReviewRepositoryV1, corrections);
  return { service, verification, reviews, corrections };
}

describe('CandidateCorrectionV1Service.correct', () => {
  it('dry-run reports eligibility and any existing link, without writing anything', async () => {
    const { service, corrections } = buildService();
    const preview = await service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'neo@capiro.ai', reason: 'r' }, { commit: false });
    expect(preview.mode).toBe('dry-run');
    expect(preview.eligibility.eligible).toBe(true);
    expect(preview.persisted).toBeNull();
    expect(corrections.insertCalls).toEqual([]);
  });

  it('rejects a blank actor/reason before touching any port', async () => {
    const { service, verification } = buildService();
    const spy = jest.spyOn(verification, 'readCandidate');
    await expect(service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: '  ', reason: 'r' }, { commit: true })).rejects.toMatchObject({ code: 'blank_actor' });
    await expect(service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'a', reason: ' ' }, { commit: true })).rejects.toMatchObject({ code: 'blank_reason' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws candidate_not_found for a missing old or new candidate', async () => {
    const { service } = buildService({ candidates: { 'candidate-old': fakeCandidate({ id: 'candidate-old' }) } });
    await expect(service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'missing', actor: 'a', reason: 'r' }, { commit: false })).rejects.toMatchObject({ code: 'new_candidate_not_found' });
    await expect(service.correct({ oldCandidateId: 'missing', newCandidateId: 'candidate-old', actor: 'a', reason: 'r' }, { commit: false })).rejects.toMatchObject({ code: 'old_candidate_not_found' });
  });

  it('refuses to commit when ineligible, without calling supersede or insert', async () => {
    const { service, reviews, corrections } = buildService({
      candidates: { 'candidate-old': fakeCandidate({ id: 'candidate-old', status: 'REVIEW_ACCEPTED' }), 'candidate-new': fakeCandidate({ id: 'candidate-new' }) },
    });
    await expect(service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'a', reason: 'r' }, { commit: true })).rejects.toMatchObject({ code: 'ineligible' });
    expect(reviews.supersedeCalls).toEqual([]);
    expect(corrections.insertCalls).toEqual([]);
  });

  it('the zero-active-approvals case: commit succeeds, supersede is still called (idempotent no-op), and supersededScopedFactReviewIds is empty', async () => {
    const { service, reviews } = buildService({ supersededIds: [] });
    const result = await service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'neo@capiro.ai', reason: 'r' }, { commit: true });
    expect(result.mode).toBe('committed');
    expect(reviews.supersedeCalls).toHaveLength(1);
    expect(reviews.supersedeCalls[0]!.candidateId).toBe('candidate-old');
    expect(result.supersededScopedFactReviewIds).toEqual([]);
    expect(result.persisted!.supersededScopedFactReviewIds).toEqual([]);
  });

  it('the active-approval case: commit calls supersede BEFORE insert, and the returned ids are persisted on the link row', async () => {
    const { service, corrections } = buildService({ supersededIds: ['review-a', 'review-b'] });
    const result = await service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'neo@capiro.ai', reason: 'r' }, { commit: true });
    expect(result.mode).toBe('committed');
    expect(result.supersededScopedFactReviewIds).toEqual(['review-a', 'review-b']);
    expect(corrections.insertCalls[0]!.supersededScopedFactReviewIds).toEqual(['review-a', 'review-b']);
  });

  it('same (old, new) pair replayed after a conflict is treated as idempotent success, returning the ORIGINAL persisted row', async () => {
    const corrections = new FakeCorrections();
    corrections.seed({
      id: 'link-original',
      oldCandidateId: 'candidate-old',
      newCandidateId: 'candidate-new',
      oldCandidateStatusAtCorrection: 'NEEDS_REVIEW',
      oldCandidateSourceDocumentId: 'doc-1',
      oldCandidateSourceSha256: 'c'.repeat(64),
      newCandidateSourceDocumentId: 'doc-1',
      newCandidateSourceSha256: 'c'.repeat(64),
      supersededScopedFactReviewIds: [],
      actor: 'someone-else',
      reason: 'original correction',
      createdAt: '2026-09-08T12:00:00.000Z',
    });
    corrections.queueInsertResult({ outcome: 'conflict' });
    const { service } = buildService({ corrections });

    const replay = await service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'neo@capiro.ai', reason: 'retry' }, { commit: true });
    expect(replay.mode).toBe('already_recorded');
    expect(replay.persisted!.id).toBe('link-original');
    expect(replay.persisted!.actor).toBe('someone-else'); // the ORIGINAL row, not a new one
  });

  it('a DIFFERENT new candidate for an already-corrected old candidate is refused with an explicit conflict naming the winner', async () => {
    const corrections = new FakeCorrections();
    corrections.seed({
      id: 'link-original',
      oldCandidateId: 'candidate-old',
      newCandidateId: 'candidate-winner',
      oldCandidateStatusAtCorrection: 'NEEDS_REVIEW',
      oldCandidateSourceDocumentId: 'doc-1',
      oldCandidateSourceSha256: 'c'.repeat(64),
      newCandidateSourceDocumentId: 'doc-1',
      newCandidateSourceSha256: 'c'.repeat(64),
      supersededScopedFactReviewIds: [],
      actor: 'operator-a',
      reason: 'original correction',
      createdAt: '2026-09-08T12:00:00.000Z',
    });
    corrections.queueInsertResult({ outcome: 'conflict' });
    const { service } = buildService({
      candidates: {
        'candidate-old': fakeCandidate({ id: 'candidate-old' }),
        'candidate-new': fakeCandidate({ id: 'candidate-new' }), // the LOSING attempt's new candidate
      },
      corrections,
    });

    await expect(service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'operator-b', reason: 'conflicting attempt' }, { commit: true })).rejects.toMatchObject({
      code: 'already_corrected_by_different_candidate',
      existingLink: { newCandidateId: 'candidate-winner' },
    });
  });

  it('readByOldCandidateId / readByNewCandidateId delegate to the repository', async () => {
    const corrections = new FakeCorrections();
    corrections.seed({
      id: 'link-1',
      oldCandidateId: 'candidate-old',
      newCandidateId: 'candidate-new',
      oldCandidateStatusAtCorrection: 'NEEDS_REVIEW',
      oldCandidateSourceDocumentId: 'doc-1',
      oldCandidateSourceSha256: 'c'.repeat(64),
      newCandidateSourceDocumentId: 'doc-1',
      newCandidateSourceSha256: 'c'.repeat(64),
      supersededScopedFactReviewIds: [],
      actor: 'neo@capiro.ai',
      reason: 'x',
      createdAt: '2026-09-08T00:00:00.000Z',
    });
    const { service } = buildService({ corrections });
    expect((await service.readByOldCandidateId('candidate-old'))!.id).toBe('link-1');
    expect((await service.readByNewCandidateId('candidate-new'))!.id).toBe('link-1');
    expect(await service.readByOldCandidateId('nope')).toBeNull();
  });
});
