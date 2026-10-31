import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FeatureFlagService } from '../src/feature-flags/feature-flag.service.js';
import { HearingSessionService } from '../src/hearing/hearing-session.service.js';
import { RecordingPermissionService } from '../src/hearing/recording/recording-permission.service.js';
import { HearingRecordingService } from '../src/hearing/recording/recording.service.js';
import { RecordingAssemblyWorker } from '../src/hearing/recording/recording-assembly.worker.js';
import type { RecordingStorageService } from '../src/hearing/recording/recording-storage.service.js';
import {
  LiveHearingAudioSourceDto,
  LiveHearingSourceTypeDto,
} from '../src/hearing/dto/session.dto.js';
import {
  floridaLiveCandidate,
  floridaLiveSchedule,
} from '../../api/src/hearing-discovery/adapters/florida-live-schedule.js';
import { classifyObservedCandidate } from '../../api/src/hearing-discovery/stream-candidate.repository.js';
import { etCalendarDay } from '../../api/src/hearing-discovery/hearing-time.js';
import type { LegislativeObservation } from '../../api/src/hearing-discovery/legislative-calendar.js';
import { selectBrowserSource } from '../../api/src/live-hearings/live-hearings-browser-source.js';
import { assessStrictSchedulePolicy } from '../../api/src/live-hearings/live-hearings-phase7-schedule.guard.js';

if (
  process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable' ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
)
  throw Error('Local disposable PostgreSQL required');

describe('explicit public browser permission under the application role', () => {
  jest.setTimeout(30_000);
  const p = new PrismaService({ transactionOptions: { maxWait: 10000, timeout: 10000 } });
  const tenant = randomUUID(),
    foreignTenant = randomUUID(),
    user = randomUUID();
  const actor = `browser-permission-${randomUUID()}`;
  let hearing: string, candidate: string, session: string, source: string;
  const asApp = <T>(run: (tx: any) => Promise<T>, scope = tenant, identity = actor) =>
    p.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      await tx.$executeRaw`SELECT set_config('app.current_tenant',${scope},true),set_config('app.hearing_actor',${identity},true),set_config('app.bypass_rls','off',true)`;
      return run(tx);
    });
  const eligible = () =>
    asApp(
      (tx) =>
        tx.$queryRaw`SELECT public.public_hearing_browser_recording_eligible(${session}) AS eligible`,
    );
  const enable = (scope = tenant, identity = actor) =>
    asApp(
      (tx) => tx.$queryRaw`SELECT public.enable_public_hearing_browser_recording(${session}) AS id`,
      scope,
      identity,
    );
  beforeAll(async () => {
    for (const id of [tenant, foreignTenant])
      await p.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${id}::uuid,${'browser-permission-' + id},'Owned browser permission fixture')`;
    await p.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${user}::uuid,${actor},${actor + '@example.invalid'})`;
    await p.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${user}::uuid,'standard_user','active')`;
    await p.featureFlag.create({
      data: { tenantId: tenant, feature: 'legiwatch_hearing_recording_v1', enabled: true },
    });
  });
  beforeEach(async () => {
    hearing = 'browser-permission-' + randomUUID();
    candidate = randomUUID();
    source = 'https://www.flsenate.gov/Media/VideoPlayer/' + randomUUID();
    await p.$executeRaw`INSERT INTO committee_hearing(id,committee_name,chamber,title,date,event_status,visibility,geographic_jurisdiction,url)
      VALUES(${hearing},'Owned committee','Senate','Synthetic public event',now(),'scheduled','public','FL',${source})`;
    await p.$executeRaw`INSERT INTO hearing_stream_candidate(id,hearing_id,provider,official_page_url,capture_policy,resolution_state)
      VALUES(${candidate},${hearing},'florida-senate',${source},'BROWSER_CAPTURE_ONLY','READY')`;
    const created = await p.liveHearingSession.create({
      data: {
        tenantId: tenant,
        createdBy: actor,
        title: 'Owned browser permission fixture',
        sourceType: 'hearing',
        audioSource: 'browser_mic',
        sourceUrl: source,
        hearingId: hearing,
        recordingPolicy: 'transcript_only',
        consentStatus: 'not_required',
        issueIds: [],
        billIds: [],
        programElementIds: [],
        agencyIds: [],
      },
    });
    session = created.id;
  });
  afterEach(async () => {
    await p.hearingRecordingPart.deleteMany({ where: { tenantId: tenant } });
    await p.hearingRecordingEpoch.deleteMany({ where: { tenantId: tenant } });
    await p.hearingRecording.deleteMany({ where: { tenantId: tenant } });
    await p.hearingMediaPermission.deleteMany({ where: { tenantId: tenant, hearingId: hearing } });
    await p.liveHearingSession.deleteMany({ where: { tenantId: tenant, id: session } });
    await p.$executeRaw`DELETE FROM hearing_stream_candidate WHERE id=${candidate}`;
    await p.$executeRaw`DELETE FROM committee_hearing WHERE id=${hearing}`;
    await p.$executeRaw`DELETE FROM committee_hearing WHERE id=${'parent-' + hearing}`;
    await p.featureFlag.updateMany({ where: { tenantId: tenant }, data: { enabled: true } });
    await p.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenant}::uuid AND user_id=${user}::uuid`;
  });
  afterAll(async () => {
    await p.$disconnect();
  });

  async function recordFloridaLivePage() {
    // Source payload uses the verified public schedule shape with synthetic
    // event identifiers. No network, publisher media or browser consent is simulated.
    const now = new Date(),
      startsAt = new Date(now.getTime() - 600000),
      endsAt = new Date(now.getTime() + 3600000);
    const streams = floridaLiveSchedule({
      success: true,
      data: [
        {
          title: 'Live Streams',
          schedule: [
            {
              uuid: 'recOwnedBrowserFixture',
              title: 'Senate Rules',
              start_time_utc: startsAt.toISOString(),
              end_time_utc: endsAt.toISOString(),
              url: 'https://cdnapisec.kaltura.com/p/2593311/sp/259331100/playManifest/entryId/1_ownedfixture/format/url/protocol/https',
            },
          ],
        },
      ],
    });
    const observation: LegislativeObservation = {
      jurisdiction: 'FL',
      session: '2026',
      chamber: 'senate',
      officialIdentity: 'owned-live-recording',
      bodySourceKey: 'fl:senate:RC',
      bodyName: 'Rules',
      stateCommitteeId: null,
      eventType: 'committee',
      sourceUrl: 'https://www.flsenate.gov/Committees/Show/RC/MeetingNotice/123',
      publishedAt: null,
      fields: {
        title: 'Owned Rules fixture',
        status: 'scheduled',
        visibility: 'public',
        time: {
          date: etCalendarDay(startsAt).toISOString().slice(0, 10),
          rawTime: startsAt.toISOString(),
          timezone: 'America/New_York',
          precision: 'instant',
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
      },
      completeFields: ['title', 'status', 'time'],
      completeness: 'complete',
      issues: [],
    };
    const observed = floridaLiveCandidate(observation, streams, now)!;
    expect(observed).not.toBeNull();
    const classified = classifyObservedCandidate(observed);
    expect(classified.capturePolicy).toBe('BROWSER_CAPTURE_ONLY');
    expect(observed.mediaUrl).toBeNull();
    expect(
      assessStrictSchedulePolicy({ eventStatus: 'scheduled', visibility: 'public' }, [
        { ...classified, resolutionState: 'NOT_CHECKED' },
      ]),
    ).toMatchObject({ allowed: false, state: 'BROWSER_ONLY' });
    const selected = selectBrowserSource({
      hearingUrl: observation.sourceUrl,
      candidates: [{ ...observed, ...classified }],
    })!;
    expect(selected.sourceUrl).toBe(streams[0]!.watchUrl);
    source = selected.sourceUrl;
    await p.$executeRaw`UPDATE hearing_stream_candidate SET provider=${classified.provider},official_page_url=${source},capture_policy=${classified.capturePolicy},expires_at=${endsAt} WHERE id=${candidate}`;
    // Exercise the exact canonical-url branch as well as the candidate branch:
    // making the page h.url must never hide its expiring channel binding.
    await p.$executeRaw`UPDATE committee_hearing SET url=${source} WHERE id=${hearing}`;
    await p.liveHearingSession.delete({ where: { id: session } });
    const appPrisma = {
      withTenant: (scope: string, work: (tx: any) => Promise<unknown>) => asApp(work, scope),
      withSystem: (work: (tx: any) => Promise<unknown>) => asApp(work),
    } as PrismaService;
    expect(await asApp((tx) => tx.$queryRaw`SELECT current_user AS role`)).toEqual([
      { role: 'capiro_app' },
    ]);
    const sessions = new HearingSessionService(appPrisma);
    const created = await sessions.create(tenant, actor, {
      title: 'Owned live browser fixture',
      sourceType: LiveHearingSourceTypeDto.hearing,
      audioSource: LiveHearingAudioSourceDto.browser_mic,
      sourceUrl: source,
      hearingId: hearing,
    });
    session = created.id;
    expect(created.recordingPolicy).toBe('transcript_only');
    const objects = new Map<string, Buffer>();
    const storage = {
      enabled: true,
      assertReady: () => undefined,
      put: async (key: string, bytes: Buffer | Readable) => {
        if (Buffer.isBuffer(bytes)) objects.set(key, Buffer.from(bytes));
        else {
          const chunks: Buffer[] = [];
          for await (const chunk of bytes) chunks.push(Buffer.from(chunk));
          objects.set(key, Buffer.concat(chunks));
        }
      },
      read: async (key: string) => Readable.from([objects.get(key)!]),
      playbackUrl: async (key: string) => {
        expect(objects.has(key)).toBe(true);
        return 'https://private.example/owned-short-lived-playback';
      },
    } as RecordingStorageService;
    const permissions = new RecordingPermissionService(
      appPrisma,
      new FeatureFlagService(appPrisma, new ConfigService()),
      storage,
    );
    const recording = new HearingRecordingService(appPrisma, sessions, permissions, storage);
    expect(await recording.capability(tenant, session, actor)).toMatchObject({
      available: true,
      retentionDays: 30,
    });
    expect(
      await p.hearingMediaPermission.count({ where: { tenantId: tenant, hearingId: hearing } }),
    ).toBe(0);
    expect(await recording.enable(tenant, session, actor)).toEqual({
      recordingPolicy: 'audio_and_transcript',
    });
    const grant = await p.hearingMediaPermission.findFirstOrThrow({
      where: { tenantId: tenant, hearingId: hearing },
    });
    expect(grant.expiresAt.getTime()).toBeGreaterThan(endsAt.getTime());
    const claim = await sessions.claimCapture(tenant, session);
    expect(claim).not.toBeNull();
    const capture = await recording.begin(
      tenant,
      session,
      actor,
      claim!.startedAt,
      'audio/webm;codecs=opus',
    );
    const bytes = execFileSync(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=0.2',
        '-c:a',
        'libopus',
        '-f',
        'webm',
        'pipe:1',
      ],
      { windowsHide: true },
    );
    const frame = Buffer.alloc(16 + bytes.length);
    frame.write('LWA4');
    frame.writeUInt32BE(0, 4);
    frame.writeDoubleBE(200, 8);
    bytes.copy(frame, 16);
    await recording.append(capture, frame);
    await recording.seal(capture, 0, undefined, false, false);
    await sessions.releaseCapture(tenant, session, capture.captureToken, 'ended');
    expect(await new RecordingAssemblyWorker(appPrisma, storage).runOne(capture.recordingId)).toBe(
      true,
    );
    expect((await recording.manifest(tenant, session, actor)).recording?.epochs[0]).toMatchObject({
      state: 'ready',
      playable: true,
    });
    return { sessions, recording, capture, grant };
  }

  it('retains decoded browser audio after the live binding ends while denying new and renewed capture', async () => {
    const { sessions, recording, capture } = await recordFloridaLivePage();
    await p.$executeRaw`UPDATE hearing_stream_candidate SET expires_at=now()-interval '1 second' WHERE id=${candidate}`;
    await expect(sessions.claimCapture(tenant, session)).rejects.toThrow(
      'BROWSER_SOURCE_BINDING_EXPIRED',
    );
    await expect(sessions.heartbeatCapture(tenant, session, capture.captureToken)).rejects.toThrow(
      'BROWSER_SOURCE_BINDING_EXPIRED',
    );
    await expect(
      recording.begin(tenant, session, actor, capture.captureToken, 'audio/webm;codecs=opus'),
    ).rejects.toThrow('BROWSER_SOURCE_BINDING_EXPIRED');
    expect((await recording.manifest(tenant, session, actor)).recording?.playbackAvailability).toBe(
      'available',
    );
    await expect(
      recording.playback(tenant, session, actor, capture.epochId),
    ).resolves.toHaveProperty('url');
  });

  it.each(['revoked', 'expired'])(
    'still denies retained Florida live playback when its original permission is %s',
    async (reason) => {
      const { recording, capture, grant } = await recordFloridaLivePage();
      await p.$executeRaw`UPDATE hearing_stream_candidate SET expires_at=now()-interval '1 second' WHERE id=${candidate}`;
      await p.hearingMediaPermission.update({
        where: { id: grant.id },
        data:
          reason === 'revoked'
            ? { revokedAt: new Date() }
            : {
                reviewedAt: new Date(Date.now() - 172800000),
                expiresAt: new Date(Date.now() - 86400000),
              },
      });
      expect(
        (await recording.manifest(tenant, session, actor)).recording?.playbackAvailability,
      ).toBe('permission_unavailable');
      await expect(recording.playback(tenant, session, actor, capture.epochId)).rejects.toThrow(
        'unavailable',
      );
    },
  );

  it.each(['US', 'FL'])(
    'does not let a current retention grant or canonical URL bypass an expired %s source binding',
    async (jurisdiction) => {
      const page = jurisdiction === 'US' ? 'https://www.senate.gov/hearings/owned-fixture' : source;
      await p.$executeRaw`UPDATE committee_hearing SET geographic_jurisdiction=${jurisdiction},url=${page} WHERE id=${hearing}`;
      await p.$executeRaw`UPDATE hearing_stream_candidate SET official_page_url=${page},expires_at=now()+interval '1 hour' WHERE id=${candidate}`;
      await p.liveHearingSession.update({ where: { id: session }, data: { sourceUrl: page } });
      await enable();
      const appPrisma = {
        withTenant: (scope: string, work: (tx: any) => Promise<unknown>) => asApp(work, scope),
      } as PrismaService;
      const sessions = new HearingSessionService(appPrisma);
      const claim = await sessions.claimCapture(tenant, session);
      expect(claim).not.toBeNull();
      await p.$executeRaw`UPDATE hearing_stream_candidate SET expires_at=now()-interval '1 second' WHERE id=${candidate}`;
      await expect(sessions.assertCaptureSourceAllowed(tenant, hearing, page)).rejects.toThrow(
        'BROWSER_SOURCE_BINDING_EXPIRED',
      );
      await expect(sessions.assertCaptureSourceAllowed(tenant, hearing, null)).rejects.toThrow(
        'BROWSER_SOURCE_BINDING_EXPIRED',
      );
      await expect(sessions.heartbeatCapture(tenant, session, claim!.startedAt)).rejects.toThrow(
        'BROWSER_SOURCE_BINDING_EXPIRED',
      );
      expect(
        await p.hearingMediaPermission.count({
          where: {
            tenantId: tenant,
            hearingId: hearing,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        }),
      ).toBe(1);
    },
  );

  it('offers capability without writing and creates one idempotent browser-only grant on explicit enable', async () => {
    expect(await eligible()).toEqual([{ eligible: true }]);
    expect(
      await p.hearingMediaPermission.count({ where: { tenantId: tenant, hearingId: hearing } }),
    ).toBe(0);
    const [first, second] = await Promise.all([enable(), enable()]);
    expect(first).toEqual(second);
    const grants = await p.hearingMediaPermission.findMany({
      where: { tenantId: tenant, hearingId: hearing },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      mode: 'browser',
      sourceUrl: source,
      hearingId: hearing,
      reviewedBy: actor,
      operations: ['capture', 'transcription', 'retention'],
      retentionDays: 30,
    });
  });

  it('keeps the thirty-day retention grant independent of the live channel binding window', async () => {
    const expiry = new Date(Date.now() + 3600000);
    await p.$executeRaw`UPDATE hearing_stream_candidate SET expires_at=${expiry} WHERE id=${candidate}`;
    await enable();
    const grant = await p.hearingMediaPermission.findFirstOrThrow({
      where: { tenantId: tenant, hearingId: hearing },
    });
    expect(grant.expiresAt.getTime()).toBeGreaterThan(expiry.getTime());
    expect(grant.expiresAt.getTime() - grant.reviewedAt.getTime()).toBeCloseTo(30 * 86400000, -3);
  });

  it.each(['LICENSE_REQUIRED', 'BLOCKED', 'REVIEW_REQUIRED'])(
    'denies source policy %s',
    async (policy) => {
      await p.$executeRaw`UPDATE hearing_stream_candidate SET capture_policy=${policy} WHERE id=${candidate}`;
      expect(await eligible()).toEqual([{ eligible: false }]);
      await expect(enable()).rejects.toMatchObject({ meta: { code: '42501' } });
    },
  );

  it('denies foreign tenants and another actor', async () => {
    await expect(enable(foreignTenant)).rejects.toMatchObject({ meta: { code: '42501' } });
    await expect(enable(tenant, 'another-actor')).rejects.toMatchObject({
      meta: { code: '42501' },
    });
  });

  it.each([
    'http://www.flsenate.gov/watch',
    'https://user:pw@www.flsenate.gov/watch',
    'https://www.flsenate.gov/live.m3u8',
    'https://www.flsenate.gov/watch?token=temporary',
  ])(
    'rejects an unstable source even if a stored candidate claims an approved policy: %s',
    async (url) => {
      await p.$executeRaw`UPDATE hearing_stream_candidate SET official_page_url=${url} WHERE id=${candidate}`;
      await p.liveHearingSession.update({ where: { id: session }, data: { sourceUrl: url } });
      expect(await eligible()).toEqual([{ eligible: false }]);
      await expect(enable()).rejects.toMatchObject({ meta: { code: '42501' } });
    },
  );

  it.each([
    'private',
    'canceled',
    'alias',
    'unsupported',
    'expired-source',
    'missing-source',
    'changed-url',
    'private-session',
    'no-storage',
    'started',
    'membership',
    'feature',
  ])('denies %s at both capability and writer', async (reason) => {
    if (reason === 'private')
      await p.$executeRaw`UPDATE committee_hearing SET visibility='private' WHERE id=${hearing}`;
    if (reason === 'canceled')
      await p.$executeRaw`UPDATE committee_hearing SET event_status='canceled' WHERE id=${hearing}`;
    if (reason === 'alias') {
      await p.$executeRaw`INSERT INTO committee_hearing(id,committee_name,chamber,title,date,event_status,visibility,geographic_jurisdiction,url)
        VALUES(${'parent-' + hearing},'Owned committee','Senate','Canonical synthetic event',now(),'scheduled','public','FL',${source})`;
      await p.$executeRaw`UPDATE committee_hearing SET canonical_hearing_id=${'parent-' + hearing},
        alias_evidence='{"source":"owned-test"}'::jsonb,aliased_at=now() WHERE id=${hearing}`;
    }
    if (reason === 'unsupported')
      await p.$executeRaw`UPDATE committee_hearing SET geographic_jurisdiction='CA' WHERE id=${hearing}`;
    if (reason === 'expired-source')
      await p.$executeRaw`UPDATE hearing_stream_candidate SET expires_at=now()-interval '1 second' WHERE id=${candidate}`;
    if (reason === 'missing-source')
      await p.$executeRaw`DELETE FROM hearing_stream_candidate WHERE id=${candidate}`;
    if (reason === 'changed-url')
      await p.liveHearingSession.update({
        where: { id: session },
        data: { sourceUrl: 'https://unrelated.example/event' },
      });
    if (reason === 'private-session')
      await p.liveHearingSession.update({
        where: { id: session },
        data: { sourceType: 'meeting' },
      });
    if (reason === 'no-storage')
      await p.liveHearingSession.update({
        where: { id: session },
        data: { recordingPolicy: 'no_storage' },
      });
    if (reason === 'started')
      await p.liveHearingSession.update({
        where: { id: session },
        data: { startedAt: new Date() },
      });
    if (reason === 'membership')
      await p.$executeRaw`UPDATE tenant_memberships SET status='invited' WHERE tenant_id=${tenant}::uuid AND user_id=${user}::uuid`;
    if (reason === 'feature')
      await p.featureFlag.updateMany({ where: { tenantId: tenant }, data: { enabled: false } });
    expect(await eligible()).toEqual([{ eligible: false }]);
    await expect(enable()).rejects.toMatchObject({ meta: { code: '42501' } });
  });

  it.each(['revoked', 'expired'])('does not replace a %s permission', async (reason) => {
    await enable();
    await p.hearingMediaPermission.updateMany({
      where: { tenantId: tenant, hearingId: hearing },
      data:
        reason === 'revoked'
          ? { revokedAt: new Date() }
          : {
              reviewedAt: new Date(Date.now() - 2 * 86400000),
              expiresAt: new Date(Date.now() - 86400000),
            },
    });
    expect(await eligible()).toEqual([{ eligible: false }]);
    await expect(enable()).rejects.toMatchObject({ meta: { code: '42501' } });
    expect(
      await p.hearingMediaPermission.count({ where: { tenantId: tenant, hearingId: hearing } }),
    ).toBe(1);
  });

  it('keeps raw permission insertion and operation expansion forbidden to capiro_app', async () => {
    await expect(
      asApp(
        (
          tx,
        ) => tx.$executeRaw`INSERT INTO intel_hearing_media_permission(id,tenant_id,source_url,mode,operations,evidence,reviewed_by,expires_at,retention_days)
      VALUES(${randomUUID()},${tenant},${source},'server',ARRAY['capture'],'forged','application',now()+interval '1 day',1)`,
      ),
    ).rejects.toMatchObject({ meta: { code: '42501' } });
    await enable();
    await expect(
      asApp(
        (tx) =>
          tx.$executeRaw`UPDATE intel_hearing_media_permission SET operations=ARRAY['capture','distribution'] WHERE tenant_id=${tenant}`,
      ),
    ).rejects.toMatchObject({ meta: { code: '42501' } });
  });
});
