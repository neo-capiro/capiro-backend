import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { HearingSessionService } from '../src/hearing/hearing-session.service.js';
import { HearingCryptoService } from '../src/hearing/hearing-crypto.service.js';
import { HearingPublicationService } from '../src/hearing/hearing-publication.service.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { ReportService } from '../src/tracker/reports/report.service.js';
import { ReportRecipientsService } from '../src/tracker/reports/recipients.service.js';
import { PostgresPublicHearingInsightStore } from '../src/hearing/intelligence/postgres-public-hearing-insight.store.js';

if (
  process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable' ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
)
  throw Error('Local disposable PostgreSQL required');

describe('canonical server capture reviewed publications on PostgreSQL', () => {
  jest.setTimeout(30000);
  const p = new PrismaService({ transactionOptions: { maxWait: 10000, timeout: 10000 } }),
    sessions = new HearingSessionService(p);
  const tenantId = randomUUID(),
    otherTenant = randomUUID(),
    userId = randomUUID(),
    secondUser = randomUUID(),
    actor = 'review-' + randomUUID(),
    otherActor = 'review-' + randomUUID();
  const hearingId = 'review-' + randomUUID(),
    captureId = randomUUID(),
    segmentId = randomUUID(),
    interimId = randomUUID(),
    clientId = randomUUID(),
    sourceUrl = 'https://owned.example/' + hearingId;
  const ctx = { tenantId, clerkUserId: actor, role: 'org:admin' };
  const folders = new FolderTrackerService(
    p,
    new FolderSourceDataRepository(p),
    new SourceDataRepository(p),
  );
  const reports = new ReportService(folders, { isEnabled: async () => true } as any);
  const publications = new HearingPublicationService(
    reports,
    new ReportRecipientsService(reports),
    sessions,
    new HearingCryptoService(new ConfigService({ HEARING_ENCRYPTION_KEY: '1'.repeat(64) })),
  );
  let sessionId: string;
  beforeAll(async () => {
    await p.$executeRaw`INSERT INTO committee_hearing(id,committee_name,chamber,title,date,event_status,visibility,geographic_jurisdiction,legislative_session,url)
      VALUES(${hearingId},'Owned committee','Senate','Synthetic server review',now(),'completed','public','FL','2099',${sourceUrl})`;
    await p.$executeRaw`INSERT INTO public_hearing_capture(id,hearing_id,status,domain_status,gaps) VALUES(${captureId},${hearingId},'ended','COMPLETE_WITH_GAPS','[{"startMs":5000,"endMs":7000,"reason":"WORKER_RESTART"}]'::jsonb)`;
    await p.$executeRaw`INSERT INTO public_hearing_transcript_segment(id,capture_id,sequence,start_ms,end_ms,text,is_final)
      VALUES(${segmentId},${captureId},1,1000,5000,'The witness recommended bridge inspections under HB 123.',true),(${interimId},${captureId},2,7000,9000,'An unfinished interim.',false)`;
    for (const [tenant, user, clerk] of [
      [tenantId, userId, actor],
      [otherTenant, secondUser, otherActor],
    ]) {
      await p.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenant}::uuid,${'review-' + tenant},'Owned review fixture')`;
      await p.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${user}::uuid,${clerk},${clerk + '@example.invalid'})`;
      await p.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${user}::uuid,'standard_user','active')`;
      await p.featureFlag.create({
        data: { tenantId: tenant!, feature: 'legiwatch_hearing_recording_v1', enabled: true },
      });
      await p.hearingMediaPermission.create({
        data: {
          tenantId: tenant!,
          hearingId,
          sourceUrl,
          mode: 'server',
          operations: ['transcription', 'analysis', 'distribution'],
          evidence: 'Owned synthetic only',
          reviewedBy: clerk!,
          expiresAt: new Date(Date.now() + 86400000),
          retentionDays: 1,
        },
      });
    }
    await p.$executeRaw`INSERT INTO clients(id,tenant_id,name) VALUES(${clientId}::uuid,${tenantId}::uuid,'Owned review client')`;
  });
  afterAll(async () => {
    await p.$disconnect();
  });
  function draft(evidenceId = segmentId) {
    return publications.create(ctx, sessionId, {
      kind: 'hearing_recap',
      title: 'Reviewed bridge testimony',
      clientId,
      evidenceIds: [evidenceId],
      claims: [
        {
          id: 'claim-1',
          kind: 'quote',
          text: 'The witness recommended bridge inspections under HB 123.',
          evidenceIds: [evidenceId],
        },
      ],
    });
  }
  it('creates private idempotent review contexts for one shared capture without copying or recording audio', async () => {
    const first = await publications.openPublicReview(ctx, hearingId, 'hearing_recap');
    sessionId = first.sessionId;
    const again = await publications.openPublicReview(ctx, hearingId, 'live_update');
    expect(again.sessionId).toBe(sessionId);
    const other = await publications.openPublicReview(
      { tenantId: otherTenant, clerkUserId: otherActor },
      hearingId,
      'hearing_recap',
    );
    expect(other.sessionId).not.toBe(sessionId);
    expect(other.captureId).toBe(captureId);
    expect(
      (
        await p.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*) FROM public_hearing_capture WHERE hearing_id=${hearingId}`
      )[0]?.count,
    ).toBe(1n);
    expect(await p.transcriptSegment.count({ where: { sessionId } })).toBe(0);
    await expect(sessions.assertCaptureAllowed(tenantId, sessionId, actor)).rejects.toThrow(
      'CANNOT_CAPTURE',
    );
    await expect(
      p.liveHearingSession.update({ where: { id: sessionId }, data: { status: 'live' } }),
    ).rejects.toThrow('cannot start another capture');
    await expect(
      publications.candidates({ ...ctx, clerkUserId: otherActor }, sessionId, 'hearing_recap'),
    ).rejects.toThrow();
    await expect(
      publications.candidates(
        { tenantId: otherTenant, clerkUserId: otherActor },
        sessionId,
        'hearing_recap',
      ),
    ).rejects.toThrow();
  });
  it('uses original final IDs and preserves server gaps in the approved document source', async () => {
    expect(
      (await publications.candidates(ctx, sessionId, 'hearing_recap')).evidence.map(
        (e) => e.segmentId,
      ),
    ).toEqual([segmentId]);
    await expect(draft(interimId)).rejects.toThrow('FINAL_TRANSCRIPT');
    const row = await draft();
    await publications.approve(ctx, sessionId, row.id, {
      contentHash: row.contentHash,
      attestSupported: true,
    });
    const source = await publications.approvedDocument(ctx, sessionId, row.id, row.contentHash);
    if (process.env.PHASE4_DOCX_SOURCE_OUTPUT)
      writeFileSync(process.env.PHASE4_DOCX_SOURCE_OUTPUT, JSON.stringify(source, null, 2));
    expect(source.markdown).toContain(segmentId);
    expect(source.markdown).toContain('5000–7000');
    expect(source.markdown).toContain('COMPLETE_WITH_GAPS');
    expect(source.clientId).toBe(clientId);
    expect((await publications.version(ctx, sessionId, row.id)).payload.coverage.captureId).toBe(
      captureId,
    );
  });
  it('rejects changed canonical evidence before approval or export', async () => {
    const row = await draft();
    await p.$executeRaw`UPDATE public_hearing_transcript_segment SET text='Corrected transcript.',revision=revision+1 WHERE id=${segmentId}`;
    await expect(
      publications.approve(ctx, sessionId, row.id, {
        contentHash: row.contentHash,
        attestSupported: true,
      }),
    ).rejects.toThrow('EVIDENCE_CHANGED');
    await p.$executeRaw`UPDATE public_hearing_transcript_segment SET text='The witness recommended bridge inspections under HB 123.',revision=revision+1 WHERE id=${segmentId}`;
  });
  it('fences state insight replacement and rejects review reads after source permission withdrawal', async () => {
    const previous = [
      process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED,
      process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED,
    ];
    process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = 'true';
    process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED = 'true';
    try {
      const store = new PostgresPublicHearingInsightStore(p);
      expect(
        await store.replaceSegmentInsightsIfCurrent({
          segmentId,
          expectedRevision: 3,
          insights: [],
        }),
      ).toBe(true);
      await p.hearingMediaPermission.updateMany({
        where: { hearingId },
        data: { revokedAt: new Date() },
      });
      expect(
        await store.replaceSegmentInsightsIfCurrent({
          segmentId,
          expectedRevision: 3,
          insights: [],
        }),
      ).toBe(false);
      await expect(publications.candidates(ctx, sessionId, 'hearing_recap')).rejects.toThrow(
        'SOURCE_PERMISSION',
      );
    } finally {
      for (const [index, key] of [
        'LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED',
        'HEARING_PUBLIC_AUDIO_STORAGE_ENABLED',
      ].entries()) {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      }
    }
  });
});
