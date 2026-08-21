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
    const final={captureId:capture.id,hearingId:'phase4-hearing',segment:{startMs:1000,endMs:2000,text:'one'}};
    await transcripts.appendFinal(final); await transcripts.appendFinal(final);
    await transcripts.appendGap({captureId:capture.id,hearingId:'phase4-hearing',gap:{startMs:2000,endMs:3000,reason:'MEDIA_DISCONNECT'}});
    await transcripts.appendFinal({captureId:capture.id,hearingId:'phase4-hearing',segment:{startMs:3000,endMs:4000,text:'two'}});
    const rows=await prisma.$queryRawUnsafe<Array<{sequence:number;hasGapBefore:boolean}>>(`SELECT sequence,has_gap_before AS "hasGapBefore" FROM public_hearing_transcript_segment ORDER BY sequence`);
    expect(rows).toEqual([{sequence:1,hasGapBefore:false},{sequence:2,hasGapBefore:true}]);
  });
});
