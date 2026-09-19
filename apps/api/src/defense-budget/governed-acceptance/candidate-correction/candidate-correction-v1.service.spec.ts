/**
 * candidate-correction-v1.service.spec -- Phase 10B-35c.
 *
 * Fake-ports unit coverage of `CandidateCorrectionV1Service`, mirroring
 * `scoped-fact-review-v1.service.spec.ts`'s pattern: only the ports the
 * service actually calls are implemented, everything else throws if touched.
 * The real Postgres transactional atomicity (a losing `commitCorrection`
 * call performs ZERO writes, including no supersession) is proven separately
 * in `phase10b35c-candidate-correction-e2e.integration.spec.ts`; this spec
 * pins the SERVICE's own orchestration logic (ordering, idempotent replay vs.
 * explicit refusal, exactly one commitCorrection call per attempt) fast and
 * deterministically.
 */
import { describe, expect, it } from '@jest/globals';
import { CandidateCorrectionV1Service } from './candidate-correction-v1.service.js';
import type {
  CandidateCorrectionRepositoryV1,
  CandidateCorrectionRowV1,
  CommitCandidateCorrectionInputV1,
  CommitCandidateCorrectionResultV1,
  InsertCandidateCorrectionInputV1,
  InsertCandidateCorrectionResultV1,
} from './candidate-correction-repository-v1.js';
import {
  buildCandidateCorrectionReviewedIntentV1,
} from './candidate-correction-repository-v1.js';
import type { BudgetVerificationRepositoryV1, ReadCandidateV1 } from '../../verification/persistence/verification-repository.js';

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

function expectedIdentity(candidate: ReadCandidateV1) {
  return {
    currentRunId: candidate.currentRunId,
    sourceDocumentId: candidate.sourceDocumentId,
    sourceSha256: candidate.sourceSha256,
    extractionArtifactId: candidate.extractionArtifactId,
    extractionArtifactSha256: candidate.extractionArtifactSha256,
    manifestContentSha256: candidate.manifestContentSha256,
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

class FakeCorrections implements CandidateCorrectionRepositoryV1 {
  public commitCalls: CommitCandidateCorrectionInputV1[] = [];
  private rows: CandidateCorrectionRowV1[] = [];
  private nextCommitResults: CommitCandidateCorrectionResultV1[] = [];
  private seq = 0;

  constructor(private readonly supersededIdsToReturn: string[] = []) {}

  /** Queue what the NEXT commitCorrection call should return, instead of the
   * default (always succeed). Used to simulate a lost race -- in reality this
   * means the whole transaction (supersession included) rolled back, so
   * queuing 'conflict' here correctly implies zero side effects. */
  queueCommitResult(result: CommitCandidateCorrectionResultV1): void {
    this.nextCommitResults.push(result);
  }

  async commitCorrection(input: CommitCandidateCorrectionInputV1): Promise<CommitCandidateCorrectionResultV1> {
    this.commitCalls.push(input);
    const queued = this.nextCommitResults.shift();
    if (queued) return queued;
    const supersededScopedFactReviewIds = this.supersededIdsToReturn;
    const reviewedIntent = buildCandidateCorrectionReviewedIntentV1(input);
    const row: CandidateCorrectionRowV1 = {
      id: `link-${++this.seq}`,
      createdAt: '2026-09-09T00:00:00.000Z',
      oldCandidateId: input.oldCandidateId,
      newCandidateId: input.newCandidateId,
      oldCandidateStatusAtCorrection: input.oldCandidateStatusAtCorrection,
      oldCandidateSourceDocumentId: input.oldCandidateSourceDocumentId,
      oldCandidateSourceSha256: input.oldCandidateSourceSha256,
      newCandidateSourceDocumentId: input.newCandidateSourceDocumentId,
      newCandidateSourceSha256: input.newCandidateSourceSha256,
      reviewedIntentVersion: 1,
      reviewedIntent,
      // The real database trigger owns this digest; the service compares the
      // canonical JSON intent itself rather than trusting this field.
      reviewedIntentSha256: 'f'.repeat(64),
      supersededScopedFactReviewIds,
      actor: input.actor,
      reason: input.reason,
    };
    this.rows.push(row);
    return { outcome: 'inserted', row, supersededScopedFactReviewIds };
  }

  /** Not exercised by the service anymore (kept on the port for standalone
   * use); unimplemented here so an accidental call fails loudly. */
  insertLink = unimplemented('insertLink') as unknown as (input: InsertCandidateCorrectionInputV1) => Promise<InsertCandidateCorrectionResultV1>;

  async readByOldCandidateId(oldCandidateId: string): Promise<CandidateCorrectionRowV1 | null> {
    return this.rows.find((r) => r.oldCandidateId === oldCandidateId) ?? null;
  }
  async readByNewCandidateId(newCandidateId: string): Promise<CandidateCorrectionRowV1 | null> {
    return this.rows.find((r) => r.newCandidateId === newCandidateId) ?? null;
  }
  async readById(id: string): Promise<CandidateCorrectionRowV1 | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  /** Test-only: seed a pre-existing row directly, bypassing commitCorrection. */
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
  const corrections = opts.corrections ?? new FakeCorrections(opts.supersededIds ?? []);
  const service = new CandidateCorrectionV1Service(verification as unknown as BudgetVerificationRepositoryV1, corrections);
  return { service, verification, corrections };
}

describe('CandidateCorrectionV1Service.correct', () => {
  it('dry-run reports eligibility and any existing link, without writing anything', async () => {
    const { service, corrections } = buildService();
    const preview = await service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'neo@capiro.ai', reason: 'r' }, { commit: false });
    expect(preview.mode).toBe('dry-run');
    expect(preview.eligibility.eligible).toBe(true);
    expect(preview.persisted).toBeNull();
    expect(corrections.commitCalls).toEqual([]);
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

  it('refuses stale operator-reviewed run/source/artifact/manifest identity before any correction write', async () => {
    const oldCandidate = fakeCandidate({ id: 'candidate-old' });
    const newCandidate = fakeCandidate({ id: 'candidate-new' });
    const { service, corrections } = buildService({
      candidates: { 'candidate-old': oldCandidate, 'candidate-new': newCandidate },
    });
    await expect(
      service.correct(
        {
          oldCandidateId: oldCandidate.id,
          newCandidateId: newCandidate.id,
          actor: 'operator',
          reason: 'reviewed replacement',
          expectedOldCandidateIdentity: expectedIdentity(oldCandidate),
          expectedNewCandidateIdentity: {
            ...expectedIdentity(newCandidate),
            manifestContentSha256: 'f'.repeat(64),
          },
        },
        { commit: true },
      ),
    ).rejects.toMatchObject({ code: 'stale_eligibility' });
    expect(corrections.commitCalls).toHaveLength(0);
  });

  it('refuses to commit when ineligible, without calling commitCorrection at all', async () => {
    const { service, corrections } = buildService({
      candidates: { 'candidate-old': fakeCandidate({ id: 'candidate-old', status: 'REVIEW_ACCEPTED' }), 'candidate-new': fakeCandidate({ id: 'candidate-new' }) },
    });
    await expect(service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'a', reason: 'r' }, { commit: true })).rejects.toMatchObject({ code: 'ineligible' });
    expect(corrections.commitCalls).toEqual([]);
  });

  it('the zero-active-approvals case: commit succeeds via exactly one commitCorrection call, and supersededScopedFactReviewIds is empty', async () => {
    const { service, corrections } = buildService({ supersededIds: [] });
    const result = await service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'neo@capiro.ai', reason: 'r' }, { commit: true });
    expect(result.mode).toBe('committed');
    expect(corrections.commitCalls).toHaveLength(1);
    expect(corrections.commitCalls[0]!.oldCandidateId).toBe('candidate-old');
    expect(corrections.commitCalls[0]).toMatchObject({
      oldCandidateCurrentRunId: 'run-1',
      oldCandidateExtractionArtifactId: 'artifact-1',
      oldCandidateExtractionArtifactSha256: 'b'.repeat(64),
      oldCandidateManifestContentSha256: 'a'.repeat(64),
      newCandidateCurrentRunId: 'run-1',
      newCandidateExtractionArtifactId: 'artifact-1',
      newCandidateExtractionArtifactSha256: 'b'.repeat(64),
      newCandidateManifestContentSha256: 'a'.repeat(64),
    });
    expect(result.supersededScopedFactReviewIds).toEqual([]);
    expect(result.persisted!.supersededScopedFactReviewIds).toEqual([]);
  });

  it('the active-approval case: the ids commitCorrection reports as superseded are returned and persisted on the link row', async () => {
    const { service, corrections } = buildService({ supersededIds: ['review-a', 'review-b'] });
    const result = await service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'neo@capiro.ai', reason: 'r' }, { commit: true });
    expect(result.mode).toBe('committed');
    expect(result.supersededScopedFactReviewIds).toEqual(['review-a', 'review-b']);
    expect(corrections.commitCalls).toHaveLength(1);
    expect(corrections.commitCalls[0]!.supersessionReason).toContain('candidate-old');
    expect(corrections.commitCalls[0]!.supersessionReason).toContain('candidate-new');
  });

  it('same (old, new) pair replayed after a conflict is treated as idempotent success, returning the ORIGINAL persisted row', async () => {
    const corrections = new FakeCorrections();
    const { service } = buildService({ corrections });
    const original = await service.correct(
      { oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'someone-else', reason: 'original correction' },
      { commit: true },
    );
    const existing = original.persisted!;
    corrections.queueCommitResult({ outcome: 'conflict', conflictOn: 'old_candidate', existingLink: existing });

    const replay = await service.correct({ oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'neo@capiro.ai', reason: 'retry' }, { commit: true });
    expect(replay.mode).toBe('already_recorded');
    expect(replay.persisted!.id).toBe(existing.id);
    expect(replay.persisted!.actor).toBe('someone-else'); // the ORIGINAL row, not a new one
  });

  it('a DIFFERENT new candidate for an already-corrected old candidate is refused with an explicit conflict naming the winner', async () => {
    const corrections = new FakeCorrections();
    const existing: CandidateCorrectionRowV1 = {
      id: 'link-original',
      oldCandidateId: 'candidate-old',
      newCandidateId: 'candidate-winner',
      oldCandidateStatusAtCorrection: 'NEEDS_REVIEW',
      oldCandidateSourceDocumentId: 'doc-1',
      oldCandidateSourceSha256: 'c'.repeat(64),
      newCandidateSourceDocumentId: 'doc-1',
      newCandidateSourceSha256: 'c'.repeat(64),
      reviewedIntentVersion: null,
      reviewedIntent: null,
      reviewedIntentSha256: null,
      supersededScopedFactReviewIds: [],
      actor: 'operator-a',
      reason: 'original correction',
      createdAt: '2026-09-08T12:00:00.000Z',
    };
    corrections.seed(existing);
    corrections.queueCommitResult({ outcome: 'conflict', conflictOn: 'old_candidate', existingLink: existing });
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

  it('names a new-candidate uniqueness collision without claiming that the requested old candidate already has a winner', async () => {
    const corrections = new FakeCorrections();
    const existing: CandidateCorrectionRowV1 = {
      id: 'link-claims-new',
      oldCandidateId: 'candidate-other-old',
      newCandidateId: 'candidate-new',
      oldCandidateStatusAtCorrection: 'NEEDS_REVIEW',
      oldCandidateSourceDocumentId: 'doc-1',
      oldCandidateSourceSha256: 'c'.repeat(64),
      newCandidateSourceDocumentId: 'doc-1',
      newCandidateSourceSha256: 'c'.repeat(64),
      reviewedIntentVersion: null,
      reviewedIntent: null,
      reviewedIntentSha256: null,
      supersededScopedFactReviewIds: [],
      actor: 'operator-a',
      reason: 'existing forward correction',
      createdAt: '2026-09-08T12:00:00.000Z',
    };
    corrections.seed(existing);
    corrections.queueCommitResult({ outcome: 'conflict', conflictOn: 'new_candidate', existingLink: existing });
    const { service } = buildService({ corrections });

    await expect(
      service.correct(
        { oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'operator-b', reason: 'collision' },
        { commit: true },
      ),
    ).rejects.toMatchObject({
      code: 'new_candidate_already_claimed',
      existingLink: { oldCandidateId: 'candidate-other-old', newCandidateId: 'candidate-new' },
    });
  });

  it('surfaces live write-boundary eligibility drift and reverse/cycle refusals as distinct typed outcomes', async () => {
    const staleCorrections = new FakeCorrections();
    staleCorrections.queueCommitResult({ outcome: 'stale_eligibility', detail: 'old status changed to REVIEW_ACCEPTED' });
    const staleService = buildService({ corrections: staleCorrections }).service;
    await expect(
      staleService.correct(
        { oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'operator', reason: 'stale' },
        { commit: true },
      ),
    ).rejects.toMatchObject({ code: 'stale_eligibility' });

    const reverseCorrections = new FakeCorrections();
    reverseCorrections.queueCommitResult({ outcome: 'reverse_or_cycle_conflict', existingLink: null });
    const reverseService = buildService({ corrections: reverseCorrections }).service;
    await expect(
      reverseService.correct(
        { oldCandidateId: 'candidate-old', newCandidateId: 'candidate-new', actor: 'operator', reason: 'reverse' },
        { commit: true },
      ),
    ).rejects.toMatchObject({
      code: 'reverse_or_cycle_conflict',
      eligibility: { eligible: false, refusalReasons: [{ code: 'reverse_correction_of_already_corrected_candidate' }] },
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
      reviewedIntentVersion: null,
      reviewedIntent: null,
      reviewedIntentSha256: null,
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
