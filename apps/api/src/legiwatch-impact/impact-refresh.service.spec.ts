import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ImpactRefreshService, impactRefreshRetryMs } from './impact-refresh.service.js';
import { IMPACT_REFRESH_CHECK_MS, type ImpactRefreshClaim } from './impact-refresh.repository.js';

const ctx = { tenantId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002',
  clerkUserId: 'user_synthetic', tenantSlug: 'synthetic', role: 'standard_user' } as TenantContext;
const claim: ImpactRefreshClaim = { tenantId: ctx.tenantId, clientId: '00000000-0000-4000-8000-000000000003',
  billId: '119-hr-1', requestedBy: ctx.userId, claimToken: '00000000-0000-4000-8000-000000000004',
  requestVersion: '1', forceRefresh: false, attempts: 0, observedFingerprint: null };
const options = { limit: 2, discoveryLimit: 10, timeoutMs: 240_000, analysisTimeoutMs: 90_000 };

function fixture(overrides: Partial<ImpactRefreshClaim> = {}) {
  const tx = {};
  const prisma = { withTenantUser: jest.fn(async (_tenant, _user, work) => work(tx)) };
  const queue = { discover: jest.fn().mockResolvedValue(1), claim: jest.fn().mockResolvedValueOnce({ ...claim, ...overrides }).mockResolvedValue(null),
    actor: jest.fn().mockResolvedValue(ctx), assertClaim: jest.fn().mockResolvedValue(undefined),
    finish: jest.fn().mockResolvedValue(1), enqueue: jest.fn().mockResolvedValue(undefined),
    beginAttempt: jest.fn().mockResolvedValue(overrides.observedFingerprint === 'current' ? (overrides.attempts ?? 0) + 1 : 1) };
  const evidence = { load: jest.fn().mockResolvedValue({ fingerprint: 'current' }) };
  const repository = { row: jest.fn().mockResolvedValue({ analysis: null }) };
  const detail = { row: { impact: { status: 'ready', inputFingerprint: 'current', stale: false } } };
  const impact = { detail: jest.fn().mockResolvedValue(detail), analyze: jest.fn(async (_ctx, _client, _bill, beforePersist) => {
    await beforePersist(tx);
    return detail;
  }) };
  const service = new ImpactRefreshService(prisma as never, queue as never, impact as never, repository as never, evidence as never);
  return { service, queue, prisma, repository, evidence, impact, detail, tx };
}

describe('durable impact refresh', () => {
  it('enqueues only after canonical authorization inside the actor transaction and returns immediately without inference', async () => {
    const f = fixture();
    expect(await f.service.request(ctx, claim.clientId, claim.billId)).toBe(f.detail);
    expect(f.queue.enqueue).toHaveBeenCalledWith(f.tx, ctx, claim.clientId, claim.billId);
    expect(f.prisma.withTenantUser).toHaveBeenCalledWith(ctx.tenantId, ctx.userId, expect.any(Function), { timeoutMs: 20_000 });
    expect(f.impact.analyze).not.toHaveBeenCalled();
    f.repository.row.mockRejectedValueOnce(new ForbiddenException());
    await expect(f.service.request(ctx, claim.clientId, claim.billId)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('hydrates the real actor, checks current client/wall access, and fences persistence', async () => {
    const f = fixture();
    expect(await f.service.run(options)).toEqual({ discovered: 1, checked: 1, analyzed: 1, unchanged: 0, failed: 0 });
    expect(f.repository.row).toHaveBeenCalledWith(f.tx, ctx, claim.clientId, claim.billId);
    expect(f.queue.assertClaim).toHaveBeenCalledWith(f.tx, claim);
    expect(f.queue.finish).toHaveBeenCalledWith(claim, { fingerprint: 'current', error: null, attempts: 0, delayMs: IMPACT_REFRESH_CHECK_MS });
  });

  it.each(['ready', 'needs_evidence'])('checks an unchanged %s fingerprint without paying for inference', async status => {
    const f = fixture({ observedFingerprint: 'current' });
    f.repository.row.mockResolvedValue({ analysis: { status, inputFingerprint: 'current' } });
    const result = await f.service.run(options);
    expect(result.unchanged).toBe(1);
    expect(f.impact.analyze).not.toHaveBeenCalled();
  });

  it('refreshes changed evidence even after the old fingerprint exhausted retries', async () => {
    const f = fixture({ observedFingerprint: 'old', attempts: 4 });
    f.repository.row.mockResolvedValue({ analysis: { status: 'ready', inputFingerprint: 'old' } });
    expect((await f.service.run(options)).analyzed).toBe(1);
    expect(f.impact.analyze).toHaveBeenCalledTimes(1);
    expect(f.queue.finish.mock.calls[0]?.[1]).toMatchObject({ attempts: 0, fingerprint: 'current' });
  });

  it('allows an explicit request to retry a same-input ungrounded result', async () => {
    const f = fixture({ observedFingerprint: 'current', forceRefresh: true });
    f.repository.row.mockResolvedValue({ analysis: { status: 'needs_evidence', inputFingerprint: 'current' } });
    expect((await f.service.run(options)).analyzed).toBe(1);
    expect(f.impact.analyze).toHaveBeenCalledTimes(1);
  });

  it('does not mark unavailable inference as done and retains bounded backoff', async () => {
    const f = fixture({ observedFingerprint: 'current', attempts: 2 });
    f.detail.row.impact.status = 'unavailable';
    expect((await f.service.run(options)).failed).toBe(1);
    expect(f.queue.finish.mock.calls[0]?.[1]).toEqual({ fingerprint: 'current', error: 'analysis_unavailable', attempts: 3, delayMs: 240_000 });
    expect(impactRefreshRetryMs(30)).toBe(IMPACT_REFRESH_CHECK_MS);
  });

  it('stops model retries at four attempts while retaining a future evidence check', async () => {
    const f = fixture({ observedFingerprint: 'current', attempts: 4 });
    expect((await f.service.run(options)).failed).toBe(1);
    expect(f.impact.analyze).not.toHaveBeenCalled();
    expect(f.queue.finish.mock.calls[0]?.[1]).toMatchObject({ error: 'attempts_exhausted', attempts: 4, delayMs: IMPACT_REFRESH_CHECK_MS });
  });

  it('never substitutes an admin when membership or identity disappeared', async () => {
    const f = fixture();
    f.queue.actor.mockResolvedValue(null);
    expect((await f.service.run(options)).failed).toBe(1);
    expect(f.repository.row).not.toHaveBeenCalled();
    expect(f.impact.analyze).not.toHaveBeenCalled();
    expect(f.queue.finish.mock.calls[0]?.[1]).toMatchObject({ error: 'actor_unavailable', attempts: 4 });
  });

  it.each([new ForbiddenException(), new NotFoundException()])('refuses revoked client/tenant/wall access before model work', async error => {
    const f = fixture();
    f.repository.row.mockRejectedValue(error);
    expect((await f.service.run(options)).failed).toBe(1);
    expect(f.evidence.load).not.toHaveBeenCalled();
    expect(f.impact.analyze).not.toHaveBeenCalled();
    expect(f.queue.finish.mock.calls[0]?.[1]).toMatchObject({ error: 'access_denied' });
  });

  it('cannot persist when another worker reclaimed the lease', async () => {
    const f = fixture();
    f.queue.assertClaim.mockRejectedValue(new ConflictException());
    expect((await f.service.run(options)).failed).toBe(1);
    expect(f.queue.finish.mock.calls[0]?.[1]).toMatchObject({ error: 'evidence_changed' });
  });

  it('limits work and refuses to start another claim without a full time allowance', async () => {
    const f = fixture();
    f.queue.claim.mockReset().mockResolvedValue(claim);
    expect((await f.service.run({ ...options, limit: 2 })).checked).toBe(2);
    expect(f.queue.claim).toHaveBeenCalledTimes(2);
    f.queue.claim.mockClear();
    expect((await f.service.run({ ...options, timeoutMs: 60_000 })).checked).toBe(0);
    expect(f.queue.claim).not.toHaveBeenCalled();
  });

  it('validates bounds before any queue or database work', async () => {
    const f = fixture();
    await expect(f.service.run({ ...options, limit: 101 })).rejects.toThrow('INVALID_IMPACT_REFRESH_OPTIONS');
    expect(f.queue.discover).not.toHaveBeenCalled();
  });
});
