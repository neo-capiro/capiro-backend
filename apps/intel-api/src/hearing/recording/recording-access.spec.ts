import { NotFoundException } from '@nestjs/common';
import { HearingRecordingService } from './recording.service.js';

// Storage is injected below; access tests never initialize an AWS client.
jest.mock('./recording-storage.service.js', () => ({ RecordingStorageService: jest.fn() }));

describe('retained hearing audio status and access', () => {
  const tenantId = 'tenant';
  const userId = 'user';
  const sessionId = 'session';

  function setup() {
    const session = {
      recordingPolicy: 'audio_and_transcript',
      sourceUrl: 'https://owned.example/hearing',
      hearingId: null,
    };
    const recording = {
      id: 'recording',
      permissionId: 'permission',
      state: 'ready',
      expiresAt: new Date('2099-01-01'),
      originAt: new Date('2026-09-01'),
      transcriptState: 'finalized',
      analysisState: 'ready',
      epochs: [
        {
          id: 'epoch',
          state: 'ready',
          artifactKey: 'private/audio.webm',
          startMs: 0,
          durableEndMs: 1000,
          durableBytes: 5000n,
          durableSequence: 1,
          complete: true,
          decodedDurationMs: 1000,
          reason: null,
        },
      ],
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ id: userId }]),
      hearingRecording: { findFirst: jest.fn().mockResolvedValue(recording) },
      hearingRecordingEpoch: {
        findFirst: jest.fn().mockResolvedValue({ ...recording.epochs[0], recording }),
      },
      hearingMediaPermission: { findFirst: jest.fn().mockResolvedValue({ id: 'permission' }) },
    };
    const prisma = { withTenant: jest.fn(async (_tenant, work) => work(tx)) };
    const sessions = { getAccessible: jest.fn().mockResolvedValue(session) };
    const permissions = { find: jest.fn().mockResolvedValue({ retentionDays: 30 }) };
    const storage = { playbackUrl: jest.fn().mockResolvedValue('https://private.example/signed') };
    const service = new HearingRecordingService(
      prisma as never,
      sessions as never,
      permissions as never,
      storage as never,
    );
    return { service, tx, sessions, permissions, storage, recording };
  }

  it('keeps inaccessible sessions non-enumerating before checking recording capability', async () => {
    const { service, sessions, tx } = setup();
    sessions.getAccessible.mockRejectedValue(
      new NotFoundException('Live hearing session not found'),
    );
    await expect(service.capability(tenantId, sessionId, userId)).rejects.toThrow(
      'session not found',
    );
    await expect(service.manifest(tenantId, sessionId, userId)).rejects.toThrow(
      'session not found',
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.hearingRecording.findFirst).not.toHaveBeenCalled();
  });

  it('offers actionable capability status without granting recording access after membership or feature withdrawal', async () => {
    const { service, tx, permissions, storage } = setup();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(service.capability(tenantId, sessionId, userId)).resolves.toMatchObject({
      available: false,
      code: 'RECORDING_ACCESS_UNAVAILABLE',
      retentionDays: null,
    });
    for (const operation of [
      () => service.manifest(tenantId, sessionId, userId),
      () => service.playback(tenantId, sessionId, userId, 'epoch'),
    ]) {
      try {
        await operation();
        throw new Error('Recording access unexpectedly granted');
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).getResponse()).toMatchObject({
          code: 'RECORDING_ACCESS_UNAVAILABLE',
        });
      }
    }
    expect(permissions.find).not.toHaveBeenCalled();
    expect(tx.hearingRecording.findFirst).not.toHaveBeenCalled();
    expect(tx.hearingRecordingEpoch.findFirst).not.toHaveBeenCalled();
    expect(storage.playbackUrl).not.toHaveBeenCalled();
  });

  it('keeps infrastructure failures distinguishable from access denials', async () => {
    const { service, tx } = setup();
    tx.$queryRaw.mockRejectedValue(new Error('database unavailable'));
    await expect(service.capability(tenantId, sessionId, userId)).rejects.toThrow(
      'database unavailable',
    );
  });

  it('withdraws manifest play controls and signing together when source permission is no longer current', async () => {
    const { service, tx, storage } = setup();
    tx.hearingMediaPermission.findFirst.mockResolvedValue(null);
    await expect(service.manifest(tenantId, sessionId, userId)).resolves.toMatchObject({
      recording: { playbackAvailability: 'permission_unavailable', epochs: [{ playable: false }] },
    });
    await expect(service.playback(tenantId, sessionId, userId, 'epoch')).rejects.toThrow(
      'unavailable',
    );
    expect(storage.playbackUrl).not.toHaveBeenCalled();
    expect(tx.hearingMediaPermission.findFirst).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        tenantId,
        id: 'permission',
        sourceUrl: 'https://owned.example/hearing',
        hearingId: null,
        mode: 'browser',
        revokedAt: null,
        operations: { has: 'retention' },
        expiresAt: { gt: expect.any(Date) },
      }),
    });
  });

  it('reports expired retention separately from source permission and never signs expired media', async () => {
    const { service, recording, storage } = setup();
    recording.expiresAt = new Date('2000-01-01');
    await expect(service.manifest(tenantId, sessionId, userId)).resolves.toMatchObject({
      recording: {
        state: 'expired',
        playbackAvailability: 'expired',
        epochs: [{ playable: false, state: 'expired' }],
      },
    });
    await expect(service.playback(tenantId, sessionId, userId, 'epoch')).rejects.toThrow(
      'unavailable',
    );
    expect(storage.playbackUrl).not.toHaveBeenCalled();
  });

  it('returns playable coverage and a short-lived URL for an accessible retained recording', async () => {
    const { service, storage } = setup();
    await expect(service.manifest(tenantId, sessionId, userId)).resolves.toMatchObject({
      recording: {
        playbackAvailability: 'available',
        epochs: [{ playable: true, durableBytes: 5000 }],
      },
    });
    await expect(service.playback(tenantId, sessionId, userId, 'epoch')).resolves.toMatchObject({
      url: 'https://private.example/signed',
      epochId: 'epoch',
      startMs: 0,
      durationMs: 1000,
    });
    expect(storage.playbackUrl).toHaveBeenCalledWith('private/audio.webm', 60);
  });
});
