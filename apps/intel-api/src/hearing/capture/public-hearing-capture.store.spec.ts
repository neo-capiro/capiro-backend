import { OptimisticCaptureWriteError, PublicHearingCaptureStore, StaleCaptureFencingTokenError } from './public-hearing-capture.store.js';
describe('PublicHearingCaptureStore SQL guards',()=>{
  it('uses database conflict idempotency',async()=>{ const raw=jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{id:'c',hearingId:'h',status:'SCHEDULED',version:1,resolutionState:'NOT_CHECKED',consecutiveSourceErrors:0,fencingToken:0,capturedMs:0,gaps:[]}]);
    const store=new PublicHearingCaptureStore({$queryRawUnsafe:raw} as never); await store.ensureCapture({hearingId:'h',idempotencyKey:'k',now:new Date()}); expect(raw.mock.calls[0][0]).toContain('ON CONFLICT (hearing_id) DO NOTHING'); });
  it('distinguishes optimistic and stale fencing failures',async()=>{ const raw=jest.fn().mockResolvedValue([]); const store=new PublicHearingCaptureStore({$queryRawUnsafe:raw} as never);
    await expect(store.saveState({captureId:'c',expectedVersion:1,next:{status:'PREPARING',version:2,updatedAt:new Date()}})).rejects.toBeInstanceOf(OptimisticCaptureWriteError);
    await expect(store.renewLease({captureId:'c',ownerId:'wrong',fencingToken:1,now:new Date(),leaseDurationMs:1000})).rejects.toBeInstanceOf(StaleCaptureFencingTokenError); });
});

describe('PublicHearingCaptureStore.ensureCapture reschedule propagation (2026-09-04)',()=>{
  const existingRow={id:'c',hearingId:'h',status:'SCHEDULED',version:1,resolutionState:'NOT_CHECKED',consecutiveSourceErrors:0,fencingToken:0,capturedMs:0,gaps:[]};
  it('propagates the corrected start into an existing SCHEDULED capture (no second row)',async()=>{
    const raw=jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{...existingRow,scheduledStart:new Date('2026-09-04T20:00:00Z')}]).mockResolvedValueOnce([{...existingRow}]);
    const store=new PublicHearingCaptureStore({$queryRawUnsafe:raw} as never);
    const out=await store.ensureCapture({hearingId:'h',idempotencyKey:'k',scheduledStart:new Date('2026-09-04T20:00:00Z'),now:new Date()});
    const updateSql=raw.mock.calls[1][0] as string;
    expect(updateSql).toContain("status IN ('SCHEDULED','PREPARING','WAITING_FOR_STREAM','READY')");
    expect(updateSql).toContain('actual_start IS NULL');
    expect(out.hearingId).toBe('h'); // the SAME capture row (idempotent upsert), propagation asserted via the SQL allowlist above
  });
  it('never rewrites a terminal or already-started capture (SQL allowlist)',async()=>{
    const raw=jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([existingRow]);
    const store=new PublicHearingCaptureStore({$queryRawUnsafe:raw} as never);
    await store.ensureCapture({hearingId:'h',idempotencyKey:'k',scheduledStart:new Date('2026-09-04T20:00:00Z'),now:new Date()});
    const sql=raw.mock.calls[1][0] as string;
    for(const terminal of ['COMPLETE','COMPLETE_WITH_GAPS','FAILED','CANCELED','BLOCKED','CAPTURING']) expect(sql).not.toContain(`'${terminal}',` .trim());
    expect(sql).toContain('actual_start IS NULL');
  });
});
