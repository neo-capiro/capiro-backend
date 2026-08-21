import { PublicHearingCaptureAttemptStore } from './public-hearing-capture-attempt.store.js';
describe('PublicHearingCaptureAttemptStore',()=>{
  it('uses an atomic next-attempt subselect and only inserts',async()=>{ const raw=jest.fn().mockResolvedValue([{id:'a',captureId:'c',attemptNumber:2,createdAt:new Date()}]); const store=new PublicHearingCaptureAttemptStore({$queryRawUnsafe:raw} as never);
    await store.recordAttempt({captureId:'c',outcome:'failed',endedAt:new Date()}); expect(raw.mock.calls[0][0]).toContain('MAX(attempt_number)'); expect(raw.mock.calls[0][0]).not.toMatch(/UPDATE/i);
    await store.recordAttempt({captureId:'c',outcome:'succeeded'}); expect(raw).toHaveBeenCalledTimes(2); });

  it('counts prior attempts for the bounded worker retry ceiling', async()=>{
    const raw=jest.fn().mockResolvedValue([{count:2}]);
    const store=new PublicHearingCaptureAttemptStore({$queryRawUnsafe:raw} as never);
    await expect(store.countAttempts('c')).resolves.toBe(2);
    expect(raw.mock.calls[0][0]).toContain('COUNT(*)');
  });
});
