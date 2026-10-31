import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';

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

  it('caps grant expiry at the source lifetime', async () => {
    const expiry = new Date(Date.now() + 3600000);
    await p.$executeRaw`UPDATE hearing_stream_candidate SET expires_at=${expiry} WHERE id=${candidate}`;
    await enable();
    const grant = await p.hearingMediaPermission.findFirstOrThrow({
      where: { tenantId: tenant, hearingId: hearing },
    });
    expect(grant.expiresAt.getTime()).toBeLessThanOrEqual(expiry.getTime());
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
