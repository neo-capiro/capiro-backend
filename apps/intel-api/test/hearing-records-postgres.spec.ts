import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { reportRuntime } from '../src/tracker/reports/report-runtime.js';
import { HearingCryptoService } from '../src/hearing/hearing-crypto.service.js';
import { digest } from '../src/tracker/reports/report-domain.js';
import type { RecordClaim } from '../src/hearing/published-record-domain.js';
if (
  process.env.LEGIWATCH_PHASE5_TEST_DATABASE !== 'disposable' ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
)
  throw Error('Disposable PostgreSQL required');
describe('published record workflow on PostgreSQL', () => {
  jest.setTimeout(30000);
  const p = new PrismaService({ transactionOptions: { timeout: 20000, maxWait: 10000 } }),
    runtime = reportRuntime(p),
    w = runtime.records;
  const tenantId = randomUUID(),
    userId = randomUUID(),
    clientId = randomUUID(),
    actor = 'phase5_' + randomUUID(),
    eventId = 'phase5-' + randomUUID(),
    billId = 'fl-2098-hb' + Math.floor(Math.random() * 1000000),
    recordId = randomUUID();
  const ctx = { tenantId, clerkUserId: actor, role: 'org:admin' },
    hash = 'a'.repeat(64);
  let runId: string, briefId: string, briefHash: string, contactId: string, latestBriefId: string;
  let heartbeat: Array<{ enabled: boolean; schedule_enabled: boolean }> = [];
  const originalEnv = process.env.LEGIWATCH_RECORD_EMAIL_ENABLED;
  beforeAll(async () => {
    process.env.LEGIWATCH_RECORD_EMAIL_ENABLED = 'true';
    Object.assign(w, {
      crypto: new HearingCryptoService(
        new ConfigService({ HEARING_ENCRYPTION_KEY: '2'.repeat(64) }),
      ),
    });
    jest.spyOn(runtime.reports.flags, 'isEnabled').mockResolvedValue(true);
    await p.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenantId}::uuid,${'p5-' + tenantId},'Synthetic Phase 5')`;
    await p.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${userId}::uuid,${actor},${actor + '@example.invalid'})`;
    await p.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenantId}::uuid,${userId}::uuid,'standard_user','active')`;
    await p.$executeRaw`INSERT INTO clients(id,tenant_id,name) VALUES(${clientId}::uuid,${tenantId}::uuid,'Synthetic client')`;
    await p.$executeRaw`INSERT INTO committee_hearing(id,geographic_jurisdiction,legislative_session,chamber,committee_name,title,date,visibility) VALUES(${eventId},'FL','2098','House','Synthetic committee','Synthetic hearing without recording','2098-01-02','public')`;
    await p.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,source_check_status,source_checked_at) VALUES(${billId},'FL','2098','2098','HB 1','hb1','Synthetic bill','success',now())`;
    await p.$executeRaw`INSERT INTO legislative_agenda_item(id,hearing_id,item_key,position,kind,title,bill_scope,state_bill_key,source_url,evidence,revision) VALUES(${randomUUID()}::uuid,${eventId},'bill',0,'bill','HB 1','state',${billId},'https://example.gov/agenda','{}'::jsonb,1)`;
    await p.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence) VALUES(${recordId}::uuid,${billId},'vote','v1',${hash},'2098-01-02',0,
      ${JSON.stringify({ publisher: 'Synthetic legislature', provider: 'LegiScan', motion: 'Favorable recommendation', chamber: 'H', yeas: 7, nays: 2, date: '2098-01-02', url: 'https://example.gov/vote' })}::jsonb)`;
    contactId = (
      await p.legiWatchReportContact.create({
        data: {
          tenantId,
          ownerClerkId: actor,
          name: 'Synthetic contact',
          email: actor + '-recipient@example.invalid',
          verified: true,
        },
      })
    ).id;
    heartbeat =
      await p.$queryRaw`SELECT enabled,schedule_enabled FROM legiwatch_runtime_heartbeat WHERE job_key='hearing-delivery-worker'`;
    await p.$executeRaw`UPDATE legiwatch_runtime_heartbeat SET enabled=true,schedule_enabled=true WHERE job_key='hearing-delivery-worker'`;
  });
  afterAll(async () => {
    if (originalEnv === undefined) delete process.env.LEGIWATCH_RECORD_EMAIL_ENABLED;
    else process.env.LEGIWATCH_RECORD_EMAIL_ENABLED = originalEnv;
    if (heartbeat[0])
      await p.$executeRaw`UPDATE legiwatch_runtime_heartbeat SET enabled=${heartbeat[0].enabled},schedule_enabled=${heartbeat[0].schedule_enabled} WHERE job_key='hearing-delivery-worker'`;
    // Immutable fixtures deliberately remain in this disposable database for
    // inspection. No production table trigger is disabled for cleanup.
    await p.$disconnect();
  });
  it('supports a record-only event and idempotent frozen reconciliation', async () => {
    const list = await w.listRecords(ctx, eventId);
    expect(list.records).toHaveLength(1);
    expect(list.records[0]!.association).toBe('bill_context_only');
    const [a, b] = await Promise.allSettled([
      w.reconcile(ctx, eventId, {}),
      w.reconcile(ctx, eventId, {}),
    ]);
    const done = [a, b].find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof w.reconcile>>
    >;
    expect(done.value.current).toBe(true);
    runId = done.value.id;
    expect((await w.reconcile(ctx, eventId, {})).id).toBe(runId);
    expect(await p.liveHearingSession.count({ where: { tenantId } })).toBe(0);
  });
  it('generates and approves an exact record brief without capture permissions', async () => {
    const claim: RecordClaim & {
      section: string;
      outcome: string;
      rationale: string;
      supported: string[];
      unresolved: string[];
    } = {
      id: 'fact-1',
      kind: 'fact',
      scope: 'bill_record',
      billId,
      text: 'The published vote records seven yeas.',
      references: [{ id: recordId, hash, locator: 'record' }],
      section: 'developments',
      outcome: 'supported',
      rationale: 'Exact supplied vote tally.',
      supported: ['Seven yeas'],
      unresolved: [],
    };
    const provider = jest
      .spyOn(w.orchestrator, 'publishedRecords')
      .mockResolvedValue({ promptVersion: 'published-record-brief-v1', claims: [claim as never] });
    jest.spyOn(w.clientContext, 'fetch').mockResolvedValue(null);
    const brief = await w.generateBrief(ctx, eventId, runId, { clientId, folderIds: [] });
    briefId = brief.id;
    briefHash = brief.contentHash;
    expect(brief.status).toBe('draft');
    expect((await w.generateBrief(ctx, eventId, runId, { clientId, folderIds: [] })).id).toBe(
      brief.id,
    );
    expect(provider).toHaveBeenCalledTimes(1);
    await w.approveBrief(ctx, eventId, briefId, { contentHash: briefHash, attestSupported: true });
    const doc = await w.approvedDocument(ctx, eventId, briefId, briefHash);
    expect(doc.schema).toBe('legiwatch.approved-record-brief-document.v1');
    expect(doc.markdown).toContain(recordId);
    expect(doc.markdown).toContain(hash);
  });
  it('enforces tenant and owner RLS even when bypass_rls is set', async () => {
    const visible = async (tenant: string, owner: string) =>
      p.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
        await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.folder_actor',${owner},true),set_config('app.bypass_rls','on',true)`;
        return tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM intel_hearing_record_run WHERE id=${runId}`;
      });
    expect(await visible(tenantId, actor)).toHaveLength(1);
    expect(await visible(randomUUID(), actor)).toHaveLength(0);
    expect(await visible(tenantId, 'other')).toHaveLength(0);
    await expect(w.run({ ...ctx, clerkUserId: 'other' }, eventId, runId)).rejects.toThrow();
    await expect(
      p.$executeRaw`UPDATE intel_hearing_record_brief SET content_hash=${'b'.repeat(64)} WHERE id=${briefId}`,
    ).rejects.toThrow('IMMUTABLE');
  });
  it('holds stale unsent work after a reviewed version is superseded', async () => {
    const input = { channel: 'email', selection: [{ kind: 'contact', id: contactId, role: 'to' }] },
      preview = await runtime.recordDelivery.preview(ctx, eventId, briefId, input);
    const queued = await runtime.recordDelivery.enqueue(ctx, eventId, briefId, {
      ...input,
      approvalHash: preview.approvalHash,
    });
    const old = await w.brief(ctx, eventId, briefId),
      revision = await w.editBrief(ctx, eventId, briefId, {
        contentHash: briefHash,
        rationale: 'Clarify attribution',
        claims: old.payload.claims.map((c) => ({
          ...c,
          text: 'The published record reports a tally of seven yeas.',
          rationale: 'Reviewed exact tally.',
        })),
      });
    expect(revision.version).toBe(2);
    expect((await w.brief(ctx, eventId, briefId)).status).toBe('superseded');
    latestBriefId = revision.id;
    const send = jest
      .spyOn(runtime.delivery.email, 'sendReport')
      .mockResolvedValue({ outcome: 'accepted', messageId: 'synthetic' });
    const result = await runtime.delivery.drain(tenantId, 25, new Date(), 'record_brief');
    expect(result.held).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(
      (await p.legiWatchDeliveryRecipient.findFirstOrThrow({ where: { deliveryId: queued.id } }))
        .state,
    ).toBe('held');
  });
  it('maps immutable correction lineage and limits it to still-eligible affected recipients', async () => {
    const previous = await w.brief(ctx, eventId, latestBriefId),
      prior = await w.correctionSource(ctx, eventId, { priorKind: 'brief', priorId: briefId });
    const correction = {
      ...prior,
      attestChronology: true,
      items: [
        {
          priorClaimId: prior.claims[0]!.id,
          classification: 'still_supported',
          claimIds: [previous.payload.claims[0]!.id],
          rationale:
            'The same tally remains supported; this synthetic review only clarifies attribution.',
        },
      ],
    };
    const input = {
      contentHash: previous.contentHash,
      claims: previous.payload.claims,
      rationale: 'Preserve and explain earlier account',
      correction,
    };
    await expect(
      w.editBrief(ctx, eventId, latestBriefId, {
        ...input,
        correction: { ...correction, priorHash: '0'.repeat(64) },
      }),
    ).rejects.toThrow('CHRONOLOGY');
    const revised = await w.editBrief(ctx, eventId, latestBriefId, input);
    latestBriefId = revised.id;
    expect(revised.payload.correction?.priorHash).toBe(briefHash);
    expect(revised.approvedAt).toBeNull();
    await w.approveBrief(ctx, eventId, revised.id, {
      contentHash: revised.contentHash,
      attestSupported: true,
    });
    // A receipt fixture represents prior provider acceptance; no provider call.
    await p.legiWatchDeliveryRecipient.updateMany({
      where: { tenantId, delivery: { composition: { path: ['briefId'], equals: briefId } } },
      data: { state: 'provider_accepted' },
    });
    const selection = [{ kind: 'contact', id: contactId, role: 'to' }];
    const preview = await runtime.recordDelivery.preview(ctx, eventId, revised.id, {
      channel: 'email',
      selection,
    });
    expect(preview.composition.kind).toBe('record_correction');
    expect(preview.composition.plainText).toContain(prior.claims[0]!.text);
    const other = await p.legiWatchReportContact.create({
      data: {
        tenantId,
        ownerClerkId: actor,
        name: 'Not affected',
        email: actor + '-other@example.invalid',
        verified: true,
      },
    });
    await expect(
      runtime.recordDelivery.preview(ctx, eventId, revised.id, {
        channel: 'email',
        selection: [{ kind: 'contact', id: other.id, role: 'to' }],
      }),
    ).rejects.toThrow('AFFECTED_PRIOR_RECIPIENTS');
    await p.legiWatchReportContact.update({
      where: { id: contactId },
      data: { optedOut: true, version: { increment: 1 } },
    });
    await expect(
      runtime.recordDelivery.enqueue(ctx, eventId, revised.id, {
        channel: 'email',
        selection,
        approvalHash: preview.approvalHash,
      }),
    ).rejects.toThrow();
    expect(
      await p.legiWatchDelivery.count({ where: { tenantId, kind: 'record_correction' } }),
    ).toBe(0);
  });
  it('denies a brief when its client wall is revoked and allows explicit selected evidence only', async () => {
    await p.$executeRaw`UPDATE clients SET memory_wall=true WHERE id=${clientId}::uuid`;
    await expect(w.brief(ctx, eventId, latestBriefId)).rejects.toThrow('CLIENT_UNAVAILABLE');
    await p.$executeRaw`UPDATE clients SET memory_wall=false WHERE id=${clientId}::uuid`;
    const scoped = await w.reconcile(ctx, eventId, {
      sourceSelections: [{ identity: 'v1', locators: ['record'] }],
    });
    expect(scoped.payload.records[0]!.evidence.coverage).toBe('explicit_selected_passages_only');
    expect(scoped.id).not.toBe(runId);
    expect((await w.run(ctx, eventId, scoped.id)).current).toBe(true);
  });
  it('serializes source commits with review and invalidates old runs afterwards', async () => {
    let release!: () => void, locked!: () => void;
    const barrier = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (locked = r));
    const reader = p.$transaction(
      async (tx) => {
        await w.sourceBoundary(tx, ctx, eventId);
        locked();
        await barrier;
      },
      { timeout: 10000 },
    );
    await ready;
    const writer = p.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='150ms'");
      await tx.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence) VALUES(${randomUUID()}::uuid,${billId},'action','later',${digest('later')},'2098-01-02',1,'{"text":"Later publication"}'::jsonb)`;
    });
    await expect(writer).rejects.toThrow();
    release();
    await reader;
    await p.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence) VALUES(${randomUUID()}::uuid,${billId},'action','later',${digest('later')},'2098-01-02',1,'{"text":"Later publication"}'::jsonb)`;
    expect((await w.run(ctx, eventId, runId)).current).toBe(false);
    expect((await w.run(ctx, eventId, runId)).payload.records).toHaveLength(1);
  });
  it('invalidates a frozen run when a publisher restores a previously observed version',async()=>{
    const sourceKey=`state:${billId}:vote:v1`, second=randomUUID(), secondHash=digest(second);
    await p.$executeRaw`INSERT INTO published_record_source_observation(source_key,state_record_id) VALUES(${sourceKey},${recordId}::uuid)`;
    await p.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence)
      VALUES(${second}::uuid,${billId},'vote','v1',${secondHash},'2098-01-02',0,'{"yeas":8,"nays":1}'::jsonb)`;
    await p.$executeRaw`INSERT INTO published_record_source_observation(source_key,state_record_id) VALUES(${sourceKey},${second}::uuid)`;
    const before=await w.reconcile(ctx,eventId,{sourceSelections:[{identity:'v1',locators:['record']}]});
    expect(before.current).toBe(true);
    await p.$executeRaw`INSERT INTO published_record_source_observation(source_key,state_record_id) VALUES(${sourceKey},${recordId}::uuid)`;
    expect((await w.run(ctx,eventId,before.id)).current).toBe(false);
    const current=await w.source.snapshot(eventId,[{identity:'v1',locators:['record']}]);
    expect(current.find(r=>r.id===recordId)!.evidence.currentSourceVersion).toBe(true);
    expect(current.find(r=>r.id===second)!.evidence.currentSourceVersion).toBe(false);
    await expect(p.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      await tx.$executeRaw`UPDATE published_record_source_observation SET observed_at=now() WHERE source_key=${sourceKey}`;
    })).rejects.toThrow();
  });
  it('visits every event with a durable cursor despite intermittent owner scheduling',async()=>{
    const ids:string[]=[];
    for(let i=0;i<11;i++) {
      const id=eventId+'-cursor-'+String(i).padStart(2,'0');ids.push(id);
      await p.$executeRaw`INSERT INTO committee_hearing(id,geographic_jurisdiction,legislative_session,chamber,committee_name,title,date,visibility)
        VALUES(${id},'FL','2098','House','Synthetic committee','Cursor qualification','2098-01-02','public')`;
      await w.reconcile(ctx,id,{});
    }
    const snapshot=jest.spyOn(w.source,'snapshot');
    // Date or minute parity has no role in choosing the next event.
    for(let i=0;i<3;i++) await w.maintain(ctx);
    const visited=new Set(snapshot.mock.calls.map(c=>c[0]));
    expect(ids.every(id=>visited.has(id))).toBe(true);
    snapshot.mockRestore();
  });
  it('reserves an explicit daily brief once under concurrent draft occurrences and rechecks folder access',async()=>{
    const folder=await runtime.reports.folders.create(ctx,{name:'Daily brief qualification',clientId,jurisdiction:'FL',defaultSession:'2098'});
    const run=await w.reconcile(ctx,eventId,{sourceSelections:[{identity:'v1',locators:['record']}]});
    const brief=await w.generateBrief(ctx,eventId,run.id,{clientId,folderIds:[folder.id]});
    await w.approveBrief(ctx,eventId,brief.id,{contentHash:brief.contentHash,attestSupported:true});
    const approved=await w.brief(ctx,eventId,brief.id);
    const refs=[{eventId,briefId:brief.id,contentHash:brief.contentHash,sourceHash:brief.payload.sourceHash,version:brief.version,approvedAt:approved.approvedAt!.toISOString()}];
    const report=await runtime.reports.save(ctx,{name:'Daily brief qualification',folderIds:[folder.id],jurisdiction:'FL',sessionKey:'2098',settings:{committees:'off',actions:'five_days',summary:true}});
    const sub=await runtime.subscriptions.save(ctx,{reportId:report.id,mode:'draft',timezone:'UTC',localMinutes:720,subject:'Synthetic daily',recordBriefs:refs});
    expect(sub.recordBriefs).toEqual(refs);
    const now=new Date();
    const make=async(key:string,selected:unknown)=>p.legiWatchReportOccurrence.create({data:{tenantId,subscriptionId:sub.id,subscriptionVersion:sub.version,
      occurrenceKey:key,intendedAt:now,windowStart:new Date(now.getTime()-86400000),windowEnd:now,
      configuration:{ownerClerkId:actor,reportId:report.id,reportVersion:report.version,timezone:'UTC',subject:'Synthetic daily',introduction:'',recipients:[],mode:'draft',manual:true,recordBriefs:selected} as never}});
    const a=await make('race-a',refs),b=await make('race-b',refs);
    await Promise.all([runtime.subscriptions.generateOccurrence(tenantId,a.id,now),runtime.subscriptions.generateOccurrence(tenantId,b.id,now)]);
    const results=await p.legiWatchReportOccurrence.findMany({where:{id:{in:[a.id,b.id]}}});
    expect(results.map(r=>r.error)).toEqual([null,null]);
    expect(results.filter(r=>r.state==='draft')).toHaveLength(1);
    expect(results.filter(r=>r.state==='no_change')).toHaveLength(1);
    const composition=results.find(r=>r.state==='draft')!.composition as Record<string,unknown>;
    expect(composition.recordBriefs).toEqual(refs);
    expect(composition.plainText).toContain('CAPIRO BRIEF BASED ON PUBLISHED RECORDS');
    const none=await make('unselected',[]);
    await runtime.subscriptions.generateOccurrence(tenantId,none.id,now);
    expect((await p.legiWatchReportOccurrence.findUniqueOrThrow({where:{id:none.id}})).state).toBe('no_change');
    await p.$executeRaw`UPDATE intel_legiwatch_folder SET archived=true,version=version+1 WHERE tenant_id=${tenantId} AND id=${folder.id}`;
    await expect(w.brief(ctx,eventId,brief.id)).rejects.toThrow();
    const history=await runtime.subscriptions.history(ctx,sub.id);
    expect(history.find(r=>r.id===results.find(r=>r.state==='draft')!.id)!.composition).toBeNull();
    expect(await p.legiWatchDelivery.count({where:{tenantId,subscriptionId:sub.id}})).toBe(0);
  });
});
