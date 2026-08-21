import { OptimisticCaptureWriteError, PublicHearingCaptureStore, StaleCaptureFencingTokenError } from './public-hearing-capture.store.js';
describe('PublicHearingCaptureStore SQL guards',()=>{
  it('uses database conflict idempotency',async()=>{ const raw=jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{id:'c',hearingId:'h',status:'SCHEDULED',version:1,resolutionState:'NOT_CHECKED',consecutiveSourceErrors:0,fencingToken:0,capturedMs:0,gaps:[]}]);
    const store=new PublicHearingCaptureStore({$queryRawUnsafe:raw} as never); await store.ensureCapture({hearingId:'h',idempotencyKey:'k',now:new Date()}); expect(raw.mock.calls[0][0]).toContain('ON CONFLICT (hearing_id) DO NOTHING'); });
  it('distinguishes optimistic and stale fencing failures',async()=>{ const raw=jest.fn().mockResolvedValue([]); const store=new PublicHearingCaptureStore({$queryRawUnsafe:raw} as never);
    await expect(store.saveState({captureId:'c',expectedVersion:1,next:{status:'PREPARING',version:2,updatedAt:new Date()}})).rejects.toBeInstanceOf(OptimisticCaptureWriteError);
    await expect(store.renewLease({captureId:'c',ownerId:'wrong',fencingToken:1,now:new Date(),leaseDurationMs:1000})).rejects.toBeInstanceOf(StaleCaptureFencingTokenError); });
});
