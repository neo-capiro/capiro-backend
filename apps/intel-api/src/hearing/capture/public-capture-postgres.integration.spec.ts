import { PrismaService } from '../../prisma/prisma.service.js';
import { PublicHearingCaptureAttemptStore } from './public-hearing-capture-attempt.store.js';
import { PublicHearingCaptureStore, StaleCaptureFencingTokenError } from './public-hearing-capture.store.js';
import { PublicHearingTranscriptStore } from './public-hearing-transcript.store.js';

describe('public capture adapters (Postgres)',()=>{
  const prisma=new PrismaService(); const store=new PublicHearingCaptureStore(prisma);
  const attempts=new PublicHearingCaptureAttemptStore(prisma); const transcripts=new PublicHearingTranscriptStore(prisma);
  beforeAll(()=>prisma.$connect()); afterAll(()=>prisma.$disconnect());
  beforeEach(async()=>{ await prisma.$executeRawUnsafe(`TRUNCATE public_hearing_transcript_segment, public_hearing_capture_attempt, public_hearing_capture, hearing_subscription, committee_hearing CASCADE`);
    await prisma.$executeRawUnsafe(`INSERT INTO tenants (id,slug,name) VALUES
      ('00000000-0000-0000-0000-000000000001','phase4-test-one','Phase 4 One'),
      ('00000000-0000-0000-0000-000000000002','phase4-test-two','Phase 4 Two')
      ON CONFLICT (id) DO NOTHING`);
    await prisma.$executeRawUnsafe(`INSERT INTO committee_hearing (id,chamber,committee_name,title,date,starts_at,event_status,visibility) VALUES ('phase4-hearing','House','Test','Phase 4',CURRENT_DATE,now(),'scheduled','public')`); });

  it('shares one capture across demand from two tenants',async()=>{
    await prisma.$executeRawUnsafe(`INSERT INTO hearing_subscription (tenant_id,user_id,hearing_id) VALUES ($1::uuid,'u1','phase4-hearing'),($2::uuid,'u2','phase4-hearing')`,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
    expect((await store.getDemand('phase4-hearing')).activeSubscriptionCount).toBeGreaterThanOrEqual(2);
    const now=new Date(); const [a,b]=await Promise.all([store.ensureCapture({hearingId:'phase4-hearing',idempotencyKey:'k',now}),store.ensureCapture({hearingId:'phase4-hearing',idempotencyKey:'k',now})]);
    expect(a.id).toBe(b.id); const rows=await prisma.$queryRawUnsafe<Array<{count:number}>>(`SELECT COUNT(*)::int AS count FROM public_hearing_capture WHERE hearing_id='phase4-hearing'`); expect(rows[0]?.count).toBe(1);
  });

  it('atomically leases, rejects stale fencing, and permits expired takeover with a new attempt',async()=>{
    const capture=await store.ensureCapture({hearingId:'phase4-hearing',idempotencyKey:'k',now:new Date(0)}); const now=new Date();
    const [a,b]=await Promise.all([store.tryAcquireLease({captureId:capture.id,ownerId:'a',now,leaseDurationMs:1000}),store.tryAcquireLease({captureId:capture.id,ownerId:'b',now,leaseDurationMs:1000})]);
    expect([a.acquired,b.acquired].filter(Boolean)).toHaveLength(1); const winner=a.acquired?a:b;
    await expect(store.renewLease({captureId:capture.id,ownerId:'wrong',fencingToken:winner.lease!.fencingToken,now,leaseDurationMs:1000})).rejects.toBeInstanceOf(StaleCaptureFencingTokenError);
    await expect(store.saveFencedState({captureId:capture.id,ownerId:'wrong',fencingToken:winner.lease!.fencingToken,expectedVersion:winner.capture.version,next:{status:'PREPARING',version:winner.capture.version+1,updatedAt:now}})).rejects.toBeInstanceOf(StaleCaptureFencingTokenError);
    await attempts.recordAttempt({captureId:capture.id,workerLeaseOwner:winner.lease!.ownerId,startedAt:now,endedAt:now,outcome:'superseded'});
    const takeover=await store.tryAcquireLease({captureId:capture.id,ownerId:'second',now:new Date(now.getTime()+1001),leaseDurationMs:1000}); expect(takeover.acquired).toBe(true);
    await attempts.recordAttempt({captureId:capture.id,workerLeaseOwner:'second',startedAt:new Date(now.getTime()+1001)});
    const rows=await prisma.$queryRawUnsafe<Array<{attemptNumber:number;outcome:string|null}>>(`SELECT attempt_number AS "attemptNumber",outcome FROM public_hearing_capture_attempt ORDER BY attempt_number`);
    expect(rows).toEqual([{attemptNumber:1,outcome:'superseded'},{attemptNumber:2,outcome:null}]);
  });

  it('deduplicates final segments and marks the first segment after a gap',async()=>{
    const capture=await store.ensureCapture({hearingId:'phase4-hearing',idempotencyKey:'k',now:new Date()});
    const acquired=await store.tryAcquireLease({captureId:capture.id,ownerId:'transcript-worker',now:new Date(),leaseDurationMs:60_000});
    const lease=acquired.lease!;
    const final={captureId:capture.id,hearingId:'phase4-hearing',lease,segment:{startMs:1000,endMs:2000,text:'one'}};
    await transcripts.appendFinal(final); await transcripts.appendFinal(final);
    await transcripts.appendGap({captureId:capture.id,hearingId:'phase4-hearing',lease,gap:{startMs:2000,endMs:3000,reason:'MEDIA_DISCONNECT'}});
    await transcripts.appendFinal({captureId:capture.id,hearingId:'phase4-hearing',lease,segment:{startMs:3000,endMs:4000,text:'two'}});
    const rows=await prisma.$queryRawUnsafe<Array<{sequence:number;hasGapBefore:boolean}>>(`SELECT sequence,has_gap_before AS "hasGapBefore" FROM public_hearing_transcript_segment ORDER BY sequence`);
    expect(rows).toEqual([{sequence:1,hasGapBefore:false},{sequence:2,hasGapBefore:true}]);
    const progress=await prisma.$queryRawUnsafe<Array<{capturedMs:number}>>(`SELECT captured_ms AS "capturedMs" FROM public_hearing_capture WHERE id=$1`,capture.id);
    expect(progress[0]?.capturedMs).toBe(4000);
    await prisma.$executeRawUnsafe(`UPDATE public_hearing_capture SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,capture.id);
    // Simulate a renewal requested before expiry but not executed until after
    // it. The stale request timestamp must not resurrect an expired lease.
    await expect(store.renewLease({captureId:capture.id,ownerId:lease.ownerId,
      fencingToken:lease.fencingToken,now:new Date(Date.now()-60_000),leaseDurationMs:120_000}))
      .rejects.toBeInstanceOf(StaleCaptureFencingTokenError);
    await expect(transcripts.appendFinal({...final,segment:{startMs:4000,endMs:5000,text:'expired'}})).rejects.toBeInstanceOf(StaleCaptureFencingTokenError);
    await store.tryAcquireLease({captureId:capture.id,ownerId:'replacement-worker',now:new Date(),leaseDurationMs:60_000});
    await expect(transcripts.appendGap({captureId:capture.id,hearingId:'phase4-hearing',lease,gap:{startMs:4000,endMs:5000,reason:'MEDIA_DISCONNECT'}})).rejects.toBeInstanceOf(StaleCaptureFencingTokenError);
  });

  // ==========================================================================
  // §10 — capture RESCHEDULE PROPAGATION against REAL Postgres (2026-09-04
  // field-hearing correction). Port-level mocks proved the SQL strings; this
  // proves the SQL against a real engine (disposable PG, api-migrated schema).
  // This test caught a REAL defect the mocks could not: the reschedule UPDATE
  // filtered `status` (legacy lowercase column) with an UPPERCASE allowlist —
  // it matched ZERO rows on real Postgres, so propagation silently no-oped.
  // ==========================================================================
  it('propagates a corrected scheduled_start into the EXISTING capture row (no second row)',async()=>{
    // 1. Capture created while the canonical row said 17:00Z (the tz-encoded
    //    Eastern instant the central calendar published for the PT field hearing).
    const first=await store.ensureCapture({hearingId:'phase4-hearing',idempotencyKey:'k',scheduledStart:new Date('2026-09-04T17:00:00.000Z'),now:new Date('2026-09-03T12:00:00.000Z')});
    // 2. The official correction moves the hearing to 20:00Z (1:00 PM PT); the
    //    reconciler pushes the corrected start through ensureCapture again.
    const second=await store.ensureCapture({hearingId:'phase4-hearing',idempotencyKey:'k',scheduledStart:new Date('2026-09-04T20:00:00.000Z'),now:new Date('2026-09-03T15:00:00.000Z')});
    expect(second.id).toBe(first.id); // SAME row — dedupe key (hearing_id) untouched
    const rows=await prisma.$queryRawUnsafe<Array<{id:string;scheduledStart:Date;status:string;domainStatus:string;updatedAt:Date}>>(`SELECT id, scheduled_start AS "scheduledStart", status, domain_status AS "domainStatus", updated_at AS "updatedAt" FROM public_hearing_capture WHERE hearing_id='phase4-hearing'`);
    expect(rows).toHaveLength(1); // exactly one capture row
    expect(rows[0]!.scheduledStart.toISOString()).toBe('2026-09-04T20:00:00.000Z'); // propagated
    expect(rows[0]!.domainStatus).toBe('SCHEDULED'); // still pre-start, capture untouched otherwise
    // Idempotent: re-asserting the same corrected start is a no-op.
    const third=await store.ensureCapture({hearingId:'phase4-hearing',idempotencyKey:'k',scheduledStart:new Date('2026-09-04T20:00:00.000Z'),now:new Date('2026-09-03T16:00:00.000Z')});
    expect(third.id).toBe(first.id);
    const after=await prisma.$queryRawUnsafe<Array<{updatedAt:Date}>>(`SELECT updated_at AS "updatedAt" FROM public_hearing_capture WHERE hearing_id='phase4-hearing'`);
    expect(after[0]!.updatedAt.toISOString()).toBe(rows[0]!.updatedAt.toISOString()); // untouched by the same-value rewrite
  });

  it('never rewrites a TERMINAL capture row when the start moves',async()=>{
    // A capture that already reached a terminal outcome (BLOCKED = legacy
    // storage 'no_stream') must keep its original scheduled_start and state.
    await store.ensureCapture({hearingId:'phase4-hearing',idempotencyKey:'k',scheduledStart:new Date('2026-09-04T17:00:00.000Z'),now:new Date('2026-09-03T12:00:00.000Z')});
    await store.saveState({captureId:(await prisma.$queryRawUnsafe<Array<{id:string}>>(`SELECT id FROM public_hearing_capture WHERE hearing_id='phase4-hearing'`))[0]!.id,expectedVersion:1,next:{status:'BLOCKED',version:2,updatedAt:new Date('2026-09-03T13:00:00.000Z')}});
    await store.ensureCapture({hearingId:'phase4-hearing',idempotencyKey:'k',scheduledStart:new Date('2026-09-04T20:00:00.000Z'),now:new Date('2026-09-03T15:00:00.000Z')});
    const rows=await prisma.$queryRawUnsafe<Array<{scheduledStart:Date;status:string;domainStatus:string}>>(`SELECT scheduled_start AS "scheduledStart", status, domain_status AS "domainStatus" FROM public_hearing_capture WHERE hearing_id='phase4-hearing'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scheduledStart.toISOString()).toBe('2026-09-04T17:00:00.000Z'); // STALE start preserved — terminal rows are history
    expect(rows[0]!.domainStatus).toBe('BLOCKED');
  });
});
