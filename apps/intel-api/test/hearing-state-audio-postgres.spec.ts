import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PublicHearingCaptureStore } from '../src/hearing/capture/public-hearing-capture.store.js';
import { PublicHearingAudioStore } from '../src/hearing/capture/public-hearing-audio.store.js';
import { PublicHearingAudioAccessService } from '../src/hearing/capture/public-hearing-audio-access.service.js';
import { approvedPublicCapture } from '../src/hearing/capture/public-capture-permission.js';
import { stateAnalysisTenants } from '../src/hearing/intelligence/state-hearing-intelligence-access.js';

if (
  process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable' ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
)
  throw Error('Local disposable PostgreSQL required');

describe('explicit state audio permission and current demand on PostgreSQL', () => {
  jest.setTimeout(30_000);
  const p = new PrismaService(),
    store = new PublicHearingCaptureStore(p);
  const tenants = [randomUUID(), randomUUID()],
    users = [randomUUID(), randomUUID()],
    actors = users.map((id) => 'state-audio-' + id);
  const hearingId = 'state-audio-' + randomUUID(),
    sourceUrl = 'https://owned.example/' + hearingId;
  const objects = new Map<string, Buffer>();
  const storage = {
    assertReady: () => undefined,
    put: jest.fn(async (key: string, bytes: Buffer) => {
      objects.set(key, bytes);
    }),
    playbackUrl: jest.fn(async () => 'https://private.example/temporary'),
  } as any;
  const audio = new PublicHearingAudioStore(p, storage);
  const access = new PublicHearingAudioAccessService(
    p,
    { isEnabled: async () => true } as any,
    storage,
  );
  let captureId: string, attempt: NonNullable<Awaited<ReturnType<typeof audio.begin>>>;
  const previous = new Map<string, string | undefined>();
  beforeAll(async () => {
    for (const key of [
      'LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED',
      'HEARING_PUBLIC_AUDIO_STORAGE_ENABLED',
    ]) {
      previous.set(key, process.env[key]);
      process.env[key] = 'true';
    }
    await p.$executeRaw`INSERT INTO committee_hearing(id,committee_name,chamber,title,date,event_status,visibility,geographic_jurisdiction,legislative_session,url)
      VALUES(${hearingId},'Owned committee','Senate','Synthetic permission fixture',now(),'in_progress','public','FL','2099',${sourceUrl})`;
    for (const [index, tenantId] of tenants.entries()) {
      await p.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenantId}::uuid,${'state-audio-' + tenantId},'Owned state audio fixture')`;
      await p.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${users[index]}::uuid,${actors[index]},${actors[index] + '@example.invalid'})`;
      await p.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenantId}::uuid,${users[index]}::uuid,'standard_user','active')`;
      await p.$executeRaw`INSERT INTO hearing_subscription(tenant_id,user_id,hearing_id,attendance_mode,scheduled_by_user)
        VALUES(${tenantId}::uuid,${users[index]},${hearingId},'automatic',true)`;
      await p.featureFlag.create({
        data: { tenantId, feature: 'legiwatch_hearing_recording_v1', enabled: true },
      });
      await p.hearingMediaPermission.create({
        data: {
          tenantId,
          hearingId,
          sourceUrl,
          mode: 'server',
          operations: ['capture', 'transcription', 'retention'],
          reviewedBy: actors[index]!,
          evidence: 'Owned synthetic test only',
          retentionDays: 1,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
    }
  });
  afterAll(async () => {
    // Preserve unrelated fixtures and active qualification runs.
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await p.$disconnect();
  });
  it('counts real API user UUIDs, creates one global capture, and preserves the other tenant after cancellation', async () => {
    expect((await store.getDemand(hearingId)).activeSubscriptionCount).toBe(2);
    const [one, two] = await Promise.all(
      [1, 2].map(() =>
        store.ensureCapture({ hearingId, idempotencyKey: hearingId, now: new Date() }),
      ),
    );
    expect(one!.id).toBe(two!.id);
    captureId = one!.id;
    await p.$executeRaw`UPDATE hearing_subscription SET scheduled_by_user=false WHERE hearing_id=${hearingId} AND tenant_id=${tenants[0]}::uuid`;
    expect((await store.getDemand(hearingId)).activeSubscriptionCount).toBe(1);
    expect(await store.getHearing(hearingId)).not.toBeNull();
    await p.$executeRaw`UPDATE hearing_subscription SET scheduled_by_user=true WHERE hearing_id=${hearingId} AND tenant_id=${tenants[0]}::uuid`;
  });
  it('blocks browser/follow-only rows, wrong-event grants and runtime-disabled state demand', async () => {
    await p.$executeRaw`UPDATE hearing_subscription SET attendance_mode='browser' WHERE hearing_id=${hearingId}`;
    expect(await approvedPublicCapture(p, hearingId)).toHaveLength(0);
    await p.$executeRaw`UPDATE hearing_subscription SET attendance_mode='automatic' WHERE hearing_id=${hearingId}`;
    expect(await approvedPublicCapture(p, hearingId + '-other')).toHaveLength(0);
    process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = 'false';
    expect(await store.getHearing(hearingId)).toBeNull();
    expect((await store.getDemand(hearingId)).activeSubscriptionCount).toBe(0);
    process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = 'true';
  });
  it('requires a separate current analysis grant for state intelligence', async () => {
    expect(await stateAnalysisTenants(p, hearingId)).toEqual([]);
    await p.hearingMediaPermission.updateMany({
      where: { hearingId },
      data: { operations: ['capture', 'transcription', 'retention', 'analysis'] },
    });
    expect((await stateAnalysisTenants(p, hearingId)).sort()).toEqual([...tenants].sort());
    process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = 'false';
    expect(await stateAnalysisTenants(p, hearingId)).toEqual([]);
    process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = 'true';
  });
  it('retries the same bounded audio part after storage failure and commits only one checkpoint', async () => {
    const lease = await store.tryAcquireLease({
      captureId,
      ownerId: 'fixture',
      now: new Date(),
      leaseDurationMs: 120000,
    });
    attempt = (await audio.begin({
      captureId,
      hearingId,
      lease: lease.lease!,
      timelineOffsetMs: 0,
      sampleRate: 16000,
      channels: 1,
    }))!;
    storage.put.mockRejectedValueOnce(
      Object.assign(new Error('transient storage interruption'), { name: 'AbortError' }),
    );
    await audio.append(attempt, Buffer.alloc(160000));
    expect(storage.put).toHaveBeenCalledTimes(2);
    expect(storage.put.mock.calls[0][0]).toBe(storage.put.mock.calls[1][0]);
    const rows = await p.$queryRaw<
      Array<{ count: number }>
    >`SELECT count(*)::int AS count FROM intel_public_hearing_audio_part WHERE epoch_id=${attempt.id}`;
    expect(rows[0]?.count).toBe(1);
    expect(attempt.sequence).toBe(1);
  });
  it('requires current member/source authorization for playback and never crosses an unsaved gap', async () => {
    const ctx = { tenantId: tenants[0]!, clerkUserId: actors[0]! };
    const manifest = await access.manifest(ctx, hearingId);
    expect(manifest.epochs).toHaveLength(1);
    expect(await access.playback(ctx, hearingId, attempt.id, attempt.startMs + 1000)).toMatchObject(
      { startMs: attempt.startMs, endMs: attempt.startMs + 5000 },
    );
    await expect(
      access.playback(ctx, hearingId, attempt.id, attempt.startMs + 6000),
    ).rejects.toThrow('unavailable');
    await expect(access.manifest({ ...ctx, clerkUserId: actors[1]! }, hearingId)).rejects.toThrow(
      'unavailable',
    );
    await p.hearingMediaPermission.updateMany({
      where: { tenantId: tenants[0] },
      data: { revokedAt: new Date() },
    });
    await expect(access.manifest(ctx, hearingId)).rejects.toThrow('unavailable');
    // With state capture enabled, demand counts automatic subscriptions like
    // federal hearings (#1748), so both subscribers still count. Source
    // authorization is the grant set: only the unrevoked tenant remains.
    expect((await store.getDemand(hearingId)).activeSubscriptionCount).toBe(2);
    expect([
      ...new Set((await approvedPublicCapture(p, hearingId)).map((grant) => grant.tenantId)),
    ]).toEqual([tenants[1]]);
  });
  it('refuses further media after the final source grant is revoked', async () => {
    await p.hearingMediaPermission.updateMany({
      where: { tenantId: tenants[1] },
      data: { revokedAt: new Date() },
    });
    await expect(audio.append(attempt, Buffer.alloc(160000))).rejects.toThrow('WITHDRAWN');
    await expect(store.assertCaptureAllowed(hearingId)).rejects.toThrow('WITHDRAWN');
    expect(attempt.sequence).toBe(1);
  });
});
