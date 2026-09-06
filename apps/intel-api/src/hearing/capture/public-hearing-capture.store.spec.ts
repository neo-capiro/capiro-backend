import { OptimisticCaptureWriteError, PublicHearingCaptureStore, StaleCaptureFencingTokenError } from './public-hearing-capture.store.js';
describe('PublicHearingCaptureStore SQL guards',()=>{
  it('checks renewal expiry at database execution time instead of a queued request timestamp', async () => {
    const raw = jest.fn().mockResolvedValue([]);
    const store = new PublicHearingCaptureStore({ $queryRawUnsafe: raw } as never);
    const requestedAt = new Date('2026-09-06T10:00:00Z');
    await expect(store.renewLease({
      captureId: 'c', ownerId: 'worker', fencingToken: 7,
      now: requestedAt, leaseDurationMs: 60_000,
    })).rejects.toBeInstanceOf(StaleCaptureFencingTokenError);
    const sql = raw.mock.calls[0]![0] as string;
    expect(sql).toContain('worker_lease_owner=$2 AND fencing_token=$5');
    expect(sql).toContain('lease_expires_at > clock_timestamp()');
    expect(sql).not.toContain('lease_expires_at > $3');
  });

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
    expect(updateSql).toContain("domain_status IN ('SCHEDULED','PREPARING','WAITING_FOR_STREAM','READY')");
    // REGRESSION (disposable-PG proof 2026-09-03): the physical status column is
    // legacy-lowercase ('scheduled','leased',...) — an uppercase allowlist on
    // bare `status` matched ZERO real rows, so propagation silently no-oped.
    // The allowlist MUST target domain_status (word-boundary before status).
    expect(updateSql).not.toMatch(/(^|[^_])status IN \('SCHEDULED'/);
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
