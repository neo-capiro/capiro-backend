import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { HearingSessionService } from '../src/hearing/hearing-session.service.js';
import {
  HearingRecordingService,
  type RecordingCapture,
} from '../src/hearing/recording/recording.service.js';
import { RecordingAssemblyWorker } from '../src/hearing/recording/recording-assembly.worker.js';
import type { RecordingPermissionService } from '../src/hearing/recording/recording-permission.service.js';
import type { RecordingStorageService } from '../src/hearing/recording/recording-storage.service.js';
import { ConfigService } from '@nestjs/config';
import { HearingCryptoService } from '../src/hearing/hearing-crypto.service.js';
import { SegmentCommitService } from '../src/hearing/segment-commit.service.js';
import { HearingAnalysisService } from '../src/hearing/recording/hearing-analysis.service.js';
import type { OrchestratorClient } from '../src/hearing/orchestrator.client.js';
import { TranscriptionRecoveryWorker } from '../src/hearing/recording/transcription-recovery.worker.js';

// The full API+Intel migration chains must already exist on a disposable DB.
if (process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable') {
  throw new Error(
    'Set LEGIWATCH_RECORDING_TEST_DATABASE=disposable for this isolated PostgreSQL suite',
  );
}
const database = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1'].includes(database.hostname))
  throw new Error('Recording fixtures require local disposable PostgreSQL');

describe('recording durability and access on PostgreSQL', () => {
  jest.setTimeout(30_000);
  const p = new PrismaService({ transactionOptions: { maxWait: 10_000, timeout: 10_000 } }),
    sessions = new HearingSessionService(p);
  const tenantId = randomUUID(),
    userId = `recording_${randomUUID()}`,
    objects = new Map<string, Buffer>();
  let grant: any, capture: RecordingCapture, sessionId: string;
  const storage = {
    enabled: true,
    assertReady: () => undefined,
    put: jest.fn(async (key: string, body: Buffer | Readable) => {
      let bytes: Buffer;
      if (Buffer.isBuffer(body)) bytes = Buffer.from(body);
      else {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        bytes = Buffer.concat(chunks);
      }
      if (objects.has(key) && !objects.get(key)!.equals(bytes))
        throw new Error('immutable conflict');
      objects.set(key, bytes);
    }),
    read: jest.fn(async (key: string) => {
      const body = objects.get(key);
      if (!body) throw new Error('missing');
      return Readable.from([body]);
    }),
    playbackUrl: jest.fn(async () => 'https://private.example/short-lived-test'),
    purgeRecording: jest.fn(async (tenant: string, recording: string) => {
      for (const key of objects.keys())
        if (key.startsWith(`hearing-audio/${tenant}/${recording}/`)) objects.delete(key);
    }),
  } as unknown as RecordingStorageService;
  const permission = { require: async () => grant } as unknown as RecordingPermissionService;
  const service = () => new HearingRecordingService(p, sessions, permission, storage);
  const frame = (sequence: number, endMs: number, bytes: Buffer) => {
    const buffer = Buffer.alloc(16 + bytes.length);
    buffer.write('LWA4');
    buffer.writeUInt32BE(sequence, 4);
    buffer.writeDoubleBE(endMs, 8);
    bytes.copy(buffer, 16);
    return buffer;
  };
  const header = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  beforeAll(async () => {
    const internalUser = randomUUID();
    await p.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenantId}::uuid,${'recording-' + tenantId},'Recording fixtures')`;
    await p.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${internalUser}::uuid,${userId},${userId + '@example.invalid'})`;
    await p.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenantId}::uuid,${internalUser}::uuid,'standard_user','active')`;
    await p.featureFlag.create({
      data: { tenantId, feature: 'legiwatch_hearing_recording_v1', enabled: true },
    });
  });

  beforeEach(async () => {
    grant = await p.hearingMediaPermission.create({
      data: {
        tenantId,
        sourceUrl: `https://owned.example/${randomUUID()}`,
        hearingId: null,
        mode: 'browser',
        operations: ['capture', 'transcription', 'retention', 'analysis'],
        evidence: 'Synthetic owned test fixture',
        reviewedBy: userId,
        retentionDays: 7,
        expiresAt: new Date(Date.now() + 30 * 86400_000),
      },
    });
    const session = await p.liveHearingSession.create({
      data: {
        tenantId,
        createdBy: userId,
        title: 'Synthetic private recording',
        sourceType: 'meeting',
        audioSource: 'browser_mic',
        sourceUrl: grant.sourceUrl,
        recordingPolicy: 'audio_and_transcript',
        consentStatus: 'confirmed',
        issueIds: [],
        billIds: [],
        programElementIds: [],
        agencyIds: [],
      },
    });
    sessionId = session.id;
    const claim = await sessions.claimCapture(tenantId, sessionId);
    if (!claim) throw new Error('test capture was not claimed');
    capture = await service().begin(
      tenantId,
      sessionId,
      userId,
      claim.startedAt,
      'audio/webm;codecs=opus',
    );
  });
  afterAll(async () => {
    const ids = (await p.hearingRecordingEpoch.findMany({ where: { tenantId } })).map(
      (row) => row.id,
    );
    await p.hearingRecordingPart.deleteMany({ where: { tenantId, epochId: { in: ids } } });
    await p.hearingRecordingEpoch.deleteMany({ where: { tenantId } });
    await p.hearingRecording.deleteMany({ where: { tenantId } });
    await p.hearingMediaPermission.deleteMany({ where: { tenantId } });
    await p.liveHearingSession.deleteMany({ where: { tenantId } });
    await p.$disconnect();
  });

  it('survives service restart, deduplicates identical bytes, and rejects conflicts and reordered parts', async () => {
    await service().append(capture, frame(0, 1000, header));
    const duplicate = await service().append(capture, frame(0, 1000, header));
    expect(duplicate).toMatchObject({
      duplicate: true,
      durableBytes: header.length,
      durableEndMs: 1000,
    });
    await expect(service().append(capture, frame(0, 1000, Buffer.from('changed')))).rejects.toThrow(
      'Conflicting',
    );
    await expect(service().append(capture, frame(2, 2000, Buffer.from('next')))).rejects.toThrow(
      'out of order',
    );
    const reopened = await service().manifest(tenantId, sessionId, userId);
    expect(reopened.recording?.epochs[0]).toMatchObject({
      durableSequence: 0,
      durableBytes: header.length,
      playable: false,
    });
  });

  it('never acknowledges storage failure; retries a recovered immutable object', async () => {
    expect(await sessions.activateCapture(tenantId, sessionId, capture.captureToken)).toBe(true);
    (storage.put as jest.Mock).mockImplementationOnce(async (key: string, bytes: Buffer) => {
      objects.set(key, Buffer.from(bytes));
      throw new Error('storage reply lost');
    });
    await expect(service().append(capture, frame(0, 1000, header))).rejects.toThrow('reply lost');
    expect(
      await p.hearingRecordingPart.count({ where: { tenantId, epochId: capture.epochId } }),
    ).toBe(0);
    expect(await sessions.activateCapture(tenantId, sessionId, capture.captureToken)).toBe(true);
    expect(
      await sessions.activateCapture(
        tenantId,
        sessionId,
        new Date(capture.captureToken.getTime() - 1),
      ),
    ).toBe(false);
    expect(await service().append(capture, frame(0, 1000, header))).toMatchObject({
      sequence: 0,
      duplicate: false,
    });
    expect(
      await p.hearingRecordingPart.count({ where: { tenantId, epochId: capture.epochId } }),
    ).toBe(1);
  });

  it('rejects a stale capture token and source revocation before accepting another part', async () => {
    await p.liveHearingSession.update({
      where: { id: sessionId },
      data: { startedAt: new Date(capture.captureToken.getTime() + 1) },
    });
    await expect(service().append(capture, frame(0, 1000, header))).rejects.toThrow('lease');
    await p.liveHearingSession.update({
      where: { id: sessionId },
      data: { startedAt: capture.captureToken },
    });
    await p.hearingMediaPermission.update({
      where: { id: grant.id },
      data: { revokedAt: new Date() },
    });
    await expect(service().append(capture, frame(0, 1000, header))).rejects.toThrow('permission');
  });

  it('does not disclose private media to a same-tenant colleague or another tenant', async () => {
    await expect(service().manifest(tenantId, sessionId, 'different-user')).rejects.toThrow(
      'not found',
    );
    await expect(
      service().playback(randomUUID(), sessionId, userId, capture.epochId),
    ).rejects.toThrow('not found');
    const lowRole = `p4_${randomUUID().replaceAll('-', '')}`;
    await p.$executeRawUnsafe(`CREATE ROLE ${lowRole} NOLOGIN`);
    try {
      await p.$executeRawUnsafe(
        `GRANT SELECT ON intel_live_hearing_session,intel_hearing_recording,intel_hearing_recording_epoch,intel_hearing_recording_part TO ${lowRole}`,
      );
      const readAs = (actor: string) =>
        p.withTenant(tenantId, async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${lowRole}`);
          await tx.$executeRaw`SELECT set_config('app.hearing_actor',${actor},true)`;
          return tx.hearingRecording.findMany({ where: { tenantId, sessionId } });
        });
      expect(await readAs('different-user')).toHaveLength(0);
      expect(await readAs(userId)).toHaveLength(1);
    } finally {
      await p.$executeRawUnsafe(`DROP OWNED BY ${lowRole}`);
      await p.$executeRawUnsafe(`DROP ROLE ${lowRole}`);
    }
  });
  it('withdraws active capture and playback when membership, feature or retention permission changes', async () => {
    await p.hearingRecordingEpoch.update({
      where: { id: capture.epochId },
      data: {
        state: 'ready',
        artifactKey: 'hearing-audio/test/recording/epoch/file.webm',
        decodedDurationMs: 1000,
      },
    });
    await expect(
      service().playback(tenantId, sessionId, userId, capture.epochId),
    ).resolves.toHaveProperty('url');
    await p.hearingMediaPermission.update({
      where: { id: grant.id },
      data: { revokedAt: new Date() },
    });
    await expect(service().playback(tenantId, sessionId, userId, capture.epochId)).rejects.toThrow(
      'unavailable',
    );
    await p.hearingMediaPermission.update({ where: { id: grant.id }, data: { revokedAt: null } });
    await p.featureFlag.updateMany({
      where: { tenantId, feature: 'legiwatch_hearing_recording_v1' },
      data: { enabled: false },
    });
    try {
      await expect(service().manifest(tenantId, sessionId, userId)).rejects.toThrow('unavailable');
    } finally {
      await p.featureFlag.updateMany({
        where: { tenantId, feature: 'legiwatch_hearing_recording_v1' },
        data: { enabled: true },
      });
    }
    await p.$executeRaw`UPDATE tenant_memberships SET status='removed' WHERE tenant_id=${tenantId}::uuid`;
    try {
      await expect(
        service().playback(tenantId, sessionId, userId, capture.epochId),
      ).rejects.toThrow('unavailable');
      await expect(service().append(capture, frame(0, 1000, header))).rejects.toThrow(
        'unavailable',
      );
    } finally {
      await p.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid`;
    }
  });

  it('persists partial transcript coverage while durable audio keeps advancing', async () => {
    await service().append(capture, frame(0, 1000, header));
    await service().markTranscriptPartial(capture);
    await service().append(capture, frame(1, 2000, Buffer.from('next-media-fragment')));
    const manifest = await service().manifest(tenantId, sessionId, userId);
    expect(manifest.recording).toMatchObject({ state: 'recording', transcriptState: 'partial' });
    expect(manifest.recording?.epochs[0]).toMatchObject({
      state: 'recording',
      durableSequence: 1,
      durableEndMs: 2000,
      transcriptState: 'partial',
      transcriptRecoveryState: 'pending',
    });
  });

  it('labels an interrupted tail and creates a separate recording attempt', async () => {
    await service().append(capture, frame(0, 1000, header));
    await service().seal(capture, undefined, 'browser_closed', false, true);
    await sessions.releaseCapture(tenantId, sessionId, capture.captureToken, 'ended');
    const nextClaim = await sessions.claimCapture(tenantId, sessionId);
    expect(nextClaim).toBeTruthy();
    const next = await service().begin(
      tenantId,
      sessionId,
      userId,
      nextClaim!.startedAt,
      'audio/webm;codecs=opus',
    );
    expect(next.epochId).not.toBe(capture.epochId);
    expect(next.startMs).toBeGreaterThanOrEqual(1000);
    const manifest = await service().manifest(tenantId, sessionId, userId);
    expect(manifest.recording?.epochs).toHaveLength(2);
    expect(manifest.recording?.epochs[0]).toMatchObject({
      complete: false,
      reason: 'browser_closed',
    });
  });

  it('assembles actual WebM audio, verifies decoding and only then allows reopened playback', async () => {
    const bytes = execFileSync(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1.5',
        '-c:a',
        'libopus',
        '-f',
        'webm',
        'pipe:1',
      ],
      { windowsHide: true },
    );
    await service().append(capture, frame(0, 1500, bytes));
    await service().seal(capture, 0, undefined, false, false);
    await sessions.releaseCapture(tenantId, sessionId, capture.captureToken, 'ended');
    // Other tests' synthetic header-only epochs are intentionally not decodable.
    await p.hearingRecordingEpoch.updateMany({
      where: { tenantId, id: { not: capture.epochId } },
      data: { state: 'failed' },
    });
    expect(await new RecordingAssemblyWorker(p, storage).runOne(capture.recordingId)).toBe(true);
    const manifest = await service().manifest(tenantId, sessionId, userId);
    expect(manifest.recording?.epochs[0]).toMatchObject({
      state: 'ready',
      playable: true,
      complete: true,
    });
    expect(manifest.recording?.epochs[0]?.decodedDurationMs).toBeGreaterThanOrEqual(1450);
    expect(await service().playback(tenantId, sessionId, userId, capture.epochId)).toHaveProperty(
      'url',
    );
    await p.hearingRecording.update({
      where: { id: capture.recordingId },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(service().playback(tenantId, sessionId, userId, capture.epochId)).rejects.toThrow(
      'unavailable',
    );
  }, 30_000);

  it('retries analysis after a provider outage and commits derived evidence once across competing workers', async () => {
    const crypto = new HearingCryptoService(
      new ConfigService({ HEARING_ENCRYPTION_KEY: '1'.repeat(64) }),
    );
    const commit = new SegmentCommitService(p, crypto);
    const segment = { startMs: 0, endMs: 1000, text: 'Synthetic testimony about transportation.' };
    const saved = await commit.commitRawFinal({
      tenantId,
      sessionId,
      recordingPolicy: 'audio_and_transcript',
      segment,
      forceEncrypt: true,
      analysisActor: userId,
    });
    const extract = jest
      .fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValue({
        entityMentions: [],
        issueTags: [],
        summaryCard: {
          cardType: 'observation',
          title: 'Transportation testimony',
          body: segment.text,
        },
      });
    const analysis = () =>
      new HearingAnalysisService(p, crypto, commit, { extract } as unknown as OrchestratorClient);
    expect(await analysis().runOne(saved.id!)).toBe(true);
    expect(await p.transcriptSegment.findFirst({ where: { id: saved.id! } })).toMatchObject({
      analysisState: 'pending',
      textPlain: null,
    });
    expect(await p.liveSummaryCard.count({ where: { tenantId, segmentId: saved.id! } })).toBe(0);
    await p.transcriptSegment.update({
      where: { id: saved.id! },
      data: { analysisNextAttempt: null },
    });
    expect(
      (await Promise.all([analysis().runOne(saved.id!), analysis().runOne(saved.id!)])).sort(),
    ).toEqual([false, true]);
    expect(await p.transcriptSegment.findFirst({ where: { id: saved.id! } })).toMatchObject({
      analysisState: 'ready',
      analysisAttempts: 2,
    });
    expect(await p.liveSummaryCard.count({ where: { tenantId, segmentId: saved.id! } })).toBe(1);
    expect(await analysis().runOne(saved.id!)).toBe(false);
    expect(
      await p.hearingRecording.findFirst({ where: { id: capture.recordingId } }),
    ).toMatchObject({ analysisState: 'ready' });
  });

  it('repairs saved media after an outage once across competing workers, preserving existing finals', async () => {
    const previous = process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED;
    process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED = 'true';
    try {
      const bytes = execFileSync(
        'ffmpeg',
        [
          '-nostdin',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1.5',
          '-c:a',
          'libopus',
          '-f',
          'webm',
          'pipe:1',
        ],
        { windowsHide: true },
      );
      await service().append(capture, frame(0, 1500, bytes));
      await service().seal(capture, 0, undefined, true, false);
      await sessions.releaseCapture(tenantId, sessionId, capture.captureToken, 'ended');
      await new RecordingAssemblyWorker(p, storage).runOne(capture.recordingId);
      const crypto = new HearingCryptoService(
          new ConfigService({ HEARING_ENCRYPTION_KEY: '1'.repeat(64) }),
        ),
        commit = new SegmentCommitService(p, crypto);
      const original = await commit.commitRawFinal({
        tenantId,
        sessionId,
        recordingPolicy: 'audio_and_transcript',
        forceEncrypt: true,
        segment: { startMs: 100, endMs: 400, text: 'Existing final' },
        analysisActor: userId,
      });
      const provider = jest
        .fn()
        .mockRejectedValueOnce(new Error('provider temporarily unavailable'))
        .mockResolvedValue([
          { word: 'existing', start: 0.1, end: 0.4 },
          { word: 'recovered', start: 0.7, end: 1.1 },
        ]);
      const worker = () => new TranscriptionRecoveryWorker(p, storage, crypto, provider);
      await worker().seed(capture.epochId);
      expect(await worker().runOne(capture.epochId)).toBe(true);
      expect(await p.transcriptSegment.count({ where: { tenantId, sessionId } })).toBe(1);
      await p.withSystem(
        (tx) =>
          tx.$executeRaw`UPDATE intel_hearing_transcription_recovery SET next_attempt=NULL WHERE epoch_id=${capture.epochId}`,
      );
      expect(
        (
          await Promise.all([worker().runOne(capture.epochId), worker().runOne(capture.epochId)])
        ).sort(),
      ).toEqual([false, true]);
      const rows = await p.transcriptSegment.findMany({
        where: { tenantId, sessionId },
        orderBy: { startMs: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe(original.id);
      expect(rows[1]).toMatchObject({
        startMs: 700,
        endMs: 1100,
        source: 'deepgram_recovery',
        analysisState: 'pending',
        textPlain: null,
      });
      expect(crypto.decrypt(rows[1] as any)).toBe('recovered');
      expect(
        (await service().manifest(tenantId, sessionId, userId)).recording?.epochs[0],
      ).toMatchObject({ transcriptState: 'finalized', transcriptRecoveryState: 'ready' });
      expect(await worker().runOne(capture.epochId)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED;
      else process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED = previous;
    }
  });

  it('does not commit recovered words when source permission is revoked during transcription', async () => {
    const previous = process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED;
    process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED = 'true';
    try {
      const bytes = execFileSync(
        'ffmpeg',
        [
          '-nostdin',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1.5',
          '-c:a',
          'libopus',
          '-f',
          'webm',
          'pipe:1',
        ],
        { windowsHide: true },
      );
      await service().append(capture, frame(0, 1500, bytes));
      await service().seal(capture, 0, undefined, true, false);
      await sessions.releaseCapture(tenantId, sessionId, capture.captureToken, 'ended');
      await new RecordingAssemblyWorker(p, storage).runOne(capture.recordingId);
      const provider = jest.fn(async () => {
        await p.hearingMediaPermission.update({
          where: { id: grant.id },
          data: { revokedAt: new Date() },
        });
        return [{ word: 'revoked', start: 0.1, end: 0.4 }];
      });
      const worker = new TranscriptionRecoveryWorker(
        p,
        storage,
        new HearingCryptoService(new ConfigService({ HEARING_ENCRYPTION_KEY: '1'.repeat(64) })),
        provider,
      );
      await worker.seed(capture.epochId);
      await worker.runOne(capture.epochId);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(await p.transcriptSegment.count({ where: { tenantId, sessionId } })).toBe(0);
      expect(
        (await service().manifest(tenantId, sessionId, userId)).recording?.transcriptState,
      ).toBe('partial');
    } finally {
      if (previous === undefined) delete process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED;
      else process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED = previous;
    }
  });

  it('enforces no_storage even when a persistence caller passes a conflicting policy', async () => {
    const session = await p.liveHearingSession.create({
      data: {
        tenantId,
        createdBy: userId,
        title: 'Ephemeral fixture',
        sourceType: 'meeting',
        audioSource: 'browser_mic',
        recordingPolicy: 'no_storage',
        consentStatus: 'confirmed',
        issueIds: [],
        billIds: [],
        agencyIds: [],
        programElementIds: [],
      },
    });
    const commit = new SegmentCommitService(p, new HearingCryptoService(new ConfigService()));
    await expect(
      commit.commitRawFinal({
        tenantId,
        sessionId: session.id,
        recordingPolicy: 'transcript_only',
        segment: { startMs: 0, endMs: 1000, text: 'Must not persist' },
        forceEncrypt: false,
      }),
    ).rejects.toThrow();
    expect(await p.transcriptSegment.count({ where: { tenantId, sessionId: session.id } })).toBe(0);
  });

  it('denies expired playback immediately and purges orphaned objects after bounded writes settle', async () => {
    await service().append(capture, frame(0, 1000, header));
    objects.set(
      `hearing-audio/${tenantId}/${capture.recordingId}/${capture.epochId}/orphan`,
      Buffer.from('orphan'),
    );
    await p.hearingRecording.update({
      where: { id: capture.recordingId },
      data: {
        originAt: new Date(Date.now() - 86400_000),
        expiresAt: new Date(Date.now() - 130_000),
      },
    });
    await new RecordingAssemblyWorker(p, storage).purgeExpired();
    expect([...objects.keys()].some((key) => key.includes(capture.recordingId))).toBe(false);
    expect(
      await p.hearingRecording.findFirst({ where: { id: capture.recordingId } }),
    ).toMatchObject({ state: 'expired' });
  });
});
