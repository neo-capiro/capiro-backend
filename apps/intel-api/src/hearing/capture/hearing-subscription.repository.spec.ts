import { HearingSubscriptionRepository } from './hearing-subscription.repository.js';
describe('HearingSubscriptionRepository',()=>{
  it('binds tenantId and hearingId on tenant reads',async()=>{ const raw=jest.fn().mockResolvedValue([]); const repo=new HearingSubscriptionRepository({$queryRawUnsafe:raw} as never);
    await repo.list('00000000-0000-0000-0000-000000000001','hearing'); expect(raw.mock.calls[0][0]).toContain('tenant_id=$1::uuid'); expect(raw.mock.calls[0].slice(1)).toEqual(['00000000-0000-0000-0000-000000000001','hearing']); });
  it('returns only the aggregate count',async()=>{ const raw=jest.fn().mockResolvedValue([{count:2}]); const repo=new HearingSubscriptionRepository({$queryRawUnsafe:raw} as never); await expect(repo.countActiveForHearing('h')).resolves.toBe(2); });
});
