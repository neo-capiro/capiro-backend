/**
 * scoped-fact-review-v1.service.spec -- Phase 10B-35R follow-up.
 *
 * Independent review of PR #1549 found the revoke CLI
 * (revoke-defense-budget-scoped-fact-v1.ts) bypassed this service and called
 * PrismaScopedFactReviewRepositoryV1.revoke() directly, producing two bugs:
 * (1) it never supplied the required `now` timestamp, so every committed
 * revocation would have written revokedAt as an Invalid Date; (2) it never
 * checked for a null return -- the repository's own signal that the row was
 * not active, e.g. the losing side of a concurrent revoke race -- so a
 * losing invocation printed "Revocation committed." and exited 0 despite
 * writing nothing. The fix routes the CLI through this service instead,
 * whose revoke() already handles both correctly. This spec pins that
 * behavior directly (it was previously untested at the service layer).
 */
import { describe, expect, it } from '@jest/globals';
import { ScopedFactReviewV1Service, ScopedFactReviewError } from './scoped-fact-review-v1.service.js';
import type { ScopedFactReviewRepositoryV1, ScopedFactReviewRowV1 } from './scoped-fact-review-repository-v1.js';

function fakeRow(overrides: Partial<ScopedFactReviewRowV1> = {}): ScopedFactReviewRowV1 {
  return {
    id: 'row-1',
    candidateId: 'candidate-1',
    runId: 'run-1',
    sourceDocumentId: 'doc-1',
    sourceSha256: 'a'.repeat(64),
    extractionArtifactId: 'artifact-1',
    extractionArtifactSha256: 'b'.repeat(64),
    manifestContentSha256: 'c'.repeat(64),
    policyId: 'rdte_r2_pe_total_review_policy_v1',
    policyVersion: '1',
    policySha256: 'd'.repeat(64),
    scopeKind: 'rdte_r2_pe_total_request_fy',
    scopeKey: '0601102A|2024|ARMY',
    scope: { scopeKind: 'rdte_r2_pe_total_request_fy', peCode: '0601102A', fiscalYear: 2024, fundingField: 'request', component: 'ARMY' },
    assertionIds: [],
    evidenceIds: [],
    projection: {},
    independence: {},
    limitations: [],
    decision: 'approve',
    reviewerId: 'neo@capiro.ai',
    rationale: 'test',
    decisionHash: 'e'.repeat(64),
    status: 'active',
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    supersededById: null,
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  } as unknown as ScopedFactReviewRowV1;
}

/** Only revoke() is exercised by ScopedFactReviewV1Service.revoke() -- results are consumed
 * in call order, modeling a real DB having already serialized two concurrent updateMany
 * calls into a winner (a row) then a loser (null). */
class FakeReviewsRepo {
  public calls: Array<{ id: string; actor: string; reason: string; now: string }> = [];
  constructor(private readonly results: Array<ScopedFactReviewRowV1 | null>) {}
  async revoke(input: { id: string; actor: string; reason: string; now: string }) {
    this.calls.push(input);
    const result = this.results[this.calls.length - 1];
    return result === undefined ? null : result;
  }
}

function buildService(reviews: FakeReviewsRepo): ScopedFactReviewV1Service {
  const unimplemented = () => {
    throw new Error('unexpected call -- revoke() must not touch verification/locators/artifacts');
  };
  return new ScopedFactReviewV1Service(
    { readCandidate: unimplemented, readRun: unimplemented } as never,
    { readExtractionArtifactLocator: unimplemented } as never,
    { load: unimplemented } as never,
    reviews as unknown as ScopedFactReviewRepositoryV1,
    () => '2026-09-09T12:00:00.000Z',
  );
}

describe('ScopedFactReviewV1Service.revoke', () => {
  it('supplies a real now timestamp to the repository, not undefined', async () => {
    const reviews = new FakeReviewsRepo([fakeRow({ status: 'revoked', revokedAt: '2026-09-09T12:00:00.000Z', revokedBy: 'neo@capiro.ai' })]);
    const svc = buildService(reviews);

    await svc.revoke({ id: 'row-1', actor: 'neo@capiro.ai', reason: 'test revoke' });

    expect(reviews.calls).toHaveLength(1);
    expect(reviews.calls[0]!.now).toBe('2026-09-09T12:00:00.000Z');
    expect(reviews.calls[0]!.now).not.toBeUndefined();
  });

  it('rejects a blank reason before ever calling the repository', async () => {
    const reviews = new FakeReviewsRepo([fakeRow()]);
    const svc = buildService(reviews);

    await expect(svc.revoke({ id: 'row-1', actor: 'neo@capiro.ai', reason: '   ' })).rejects.toThrow(ScopedFactReviewError);
    expect(reviews.calls).toHaveLength(0);
  });

  it('throws a typed not_active error -- never a silent success -- when the repository returns null', async () => {
    const reviews = new FakeReviewsRepo([null]);
    const svc = buildService(reviews);

    await expect(svc.revoke({ id: 'row-1', actor: 'neo@capiro.ai', reason: 'lost the race' })).rejects.toMatchObject({
      code: 'not_active',
    });
  });

  it('a simulated two-invocation race: exactly one caller gets the row, the other gets not_active', async () => {
    const reviews = new FakeReviewsRepo([fakeRow({ status: 'revoked' }), null]);
    const svc = buildService(reviews);

    const winner = await svc.revoke({ id: 'row-1', actor: 'operator-a', reason: 'first' });
    expect(winner.status).toBe('revoked');

    await expect(svc.revoke({ id: 'row-1', actor: 'operator-b', reason: 'second, too late' })).rejects.toMatchObject({
      code: 'not_active',
    });
  });
});
