import { ConflictException } from '@nestjs/common';
import { ImpactRefreshRepository, type ImpactRefreshClaim } from './impact-refresh.repository.js';

const claim: ImpactRefreshClaim = { tenantId: 'tenant', clientId: 'client', billId: '119-hr-1', requestedBy: 'actor',
  claimToken: 'token', requestVersion: '1', forceRefresh: false, attempts: 0, observedFingerprint: null };
function fixture() {
  const tx = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn().mockResolvedValue(1) };
  const prisma = { withSystem: jest.fn(async work => work(tx)) };
  return { tx, repository: new ImpactRefreshRepository(prisma as never) };
}

describe('impact refresh persistence contracts', () => {
  it('claims atomically with SKIP LOCKED, reclaims expired work, and supplies a unique token', async () => {
    const f = fixture(); f.tx.$queryRawUnsafe.mockResolvedValue([claim]);
    expect(await f.repository.claim(120000)).toBe(claim);
    const [sql, token, lease] = f.tx.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("state='running' AND claimed_until<=now()");
    expect(sql).toContain('UPDATE legiwatch_impact_refresh q');
    expect(token).toMatch(/^[a-f0-9-]{36}$/); expect(lease).toBe(120000);
  });

  it('fences persistence and completion using both token and lease expiry', async () => {
    const f = fixture(); f.tx.$queryRawUnsafe.mockResolvedValue([]);
    await expect(f.repository.assertClaim(f.tx as never, claim)).rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.$queryRawUnsafe.mock.calls[0]?.[0]).toContain('claimed_until>clock_timestamp() FOR UPDATE');
    await f.repository.finish(claim, { fingerprint: 'fp', error: null, attempts: 0, delayMs: 1000 });
    const [sql, ...values] = f.tx.$executeRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('claim_token=$4::uuid AND claimed_until>clock_timestamp()');
    expect(sql).toContain("request_version>$5::bigint THEN 'queued'");
    expect(values.slice(0, 5)).toEqual(['tenant', 'client', '119-hr-1', 'token', '1']);
  });

  it('coalesces requests and retains the newest requester for the next claim', async () => {
    const f = fixture();
    await f.repository.enqueue(f.tx as never, { tenantId: 'tenant', userId: 'actor' } as never, 'client', '119-hr-1');
    const sql = f.tx.$executeRawUnsafe.mock.calls[0]?.[0];
    expect(sql).toContain('ON CONFLICT(tenant_id,client_id,bill_id) DO UPDATE');
    expect(sql).toContain('requested_by=EXCLUDED.requested_by,force_refresh=true');
    expect(sql).toContain("state='running' THEN 'running' ELSE 'queued'");
    expect(sql).toContain('request_version=legiwatch_impact_refresh.request_version+1');
    expect(sql).not.toContain('claim_token=');
  });

  it('records attempts durably before inference, including recovery after a worker crash', async () => {
    const f = fixture(); f.tx.$queryRawUnsafe.mockResolvedValue([{ attempts: 3 }]);
    expect(await f.repository.beginAttempt({ ...claim, attempts: 2 }, 'fingerprint')).toBe(3);
    const sql = f.tx.$queryRawUnsafe.mock.calls[0]?.[0];
    expect(sql).toContain('observed_fingerprint IS DISTINCT FROM $5 THEN 1 ELSE attempts+1');
    expect(sql).toContain('claim_token=$4::uuid AND claimed_until>clock_timestamp()');
    expect(sql).toContain('OR attempts<$6');
    f.tx.$queryRawUnsafe.mockResolvedValue([]);
    await expect(f.repository.beginAttempt(claim, 'fingerprint')).rejects.toBeInstanceOf(ConflictException);
  });

  it('resolves current canonical identity only for the persisted requesting actor', async () => {
    const f = fixture(); f.tx.$queryRawUnsafe.mockResolvedValue([]);
    expect(await f.repository.actor(claim)).toBeNull();
    const [sql, ...values] = f.tx.$queryRawUnsafe.mock.calls[0]!;
    expect(sql).toContain('u.clerk_user_id AS "clerkUserId"');
    expect(sql).toContain('t.slug AS "tenantSlug"');
    expect(sql).toContain("m.status::text='active' AND t.status::text='active'");
    expect(sql).toContain("('standard_user','user_admin','capiro_admin')");
    expect(values).toEqual(['tenant', 'actor']);
  });

  it('advances a durable cursor even when creator identity cannot be resolved', async () => {
    const f = fixture();
    f.tx.$queryRawUnsafe.mockResolvedValueOnce([{ tenant: 'a', client: 'b', bill: 'c' }])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ tenantId: 't', clientId: 'c', billId: '119-hr-1', requestedBy: null }]);
    expect(await f.repository.discover(1)).toBe(0);
    const sql = f.tx.$queryRawUnsafe.mock.calls[2]?.[0];
    expect(sql).toContain("f.feature='tracker_owner_intel'");
    expect(sql).toContain('t.created_by AS actor'); expect(sql).toContain('t.tracked_by AS actor');
    expect(sql).toContain('u.id::text=p.actor OR u.clerk_user_id=p.actor');
    expect(sql).toContain('client_memory_access');
    expect(f.tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(f.tx.$executeRawUnsafe.mock.calls[0]?.slice(1)).toEqual(['t', 'c', '119-hr-1']);
  });

  it('restarts discovery after the final page and never overwrites a manually requested actor', async () => {
    const f = fixture();
    f.tx.$queryRawUnsafe.mockResolvedValueOnce([{ tenant: '', client: '', bill: '' }])
      .mockResolvedValueOnce([{ present: false }])
      .mockResolvedValueOnce([{ tenantId: 't', clientId: 'c', billId: '119-hr-1', requestedBy: 'real-creator' }]);
    expect(await f.repository.discover(10)).toBe(1);
    expect(f.tx.$queryRawUnsafe.mock.calls[2]?.[0]).not.toContain('FROM intel_tracked_bill');
    expect(f.tx.$executeRawUnsafe.mock.calls[0]?.[0]).toContain('ON CONFLICT(tenant_id,client_id,bill_id) DO NOTHING');
    expect(f.tx.$executeRawUnsafe.mock.calls[1]?.slice(1)).toEqual(['', '', '']);
  });
});
