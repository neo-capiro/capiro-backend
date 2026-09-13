import {
  decodeRecordingFrame,
  assertPartOrder,
  locateRecordingMoment,
  permissionAllowsRecording,
} from './recording-domain.js';

describe('retained audio contract', () => {
  it('validates the wire clock and preserves the exact container bytes', () => {
    const frame = Buffer.alloc(20);
    frame.write('LWA4');
    frame.writeUInt32BE(3, 4);
    frame.writeDoubleBE(1201, 8);
    frame.set([0x1a, 0x45, 0xdf, 0xa3], 16);
    const part = decodeRecordingFrame(frame);
    expect(part.sequence).toBe(3);
    expect(part.endMs).toBe(1201);
    expect([...part.bytes]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    frame.writeDoubleBE(NaN, 8);
    expect(() => decodeRecordingFrame(frame)).toThrow();
  });

  it('rejects reordered parts and a backwards clock, allowing split fragments at the same time', () => {
    const checkpoint = { durableSequence: 3, durableEndMs: 13_000, startMs: 10_000 };
    expect(() => assertPartOrder(checkpoint, { sequence: 4, endMs: 3000 })).not.toThrow();
    expect(() => assertPartOrder(checkpoint, { sequence: 5, endMs: 3000 })).toThrow();
    expect(() => assertPartOrder(checkpoint, { sequence: 4, endMs: 2999 })).toThrow();
  });

  it('does not move an evidence seek across an interruption or past decoded coverage', () => {
    const epochs = [
      {
        id: 'first',
        startMs: 0,
        durableEndMs: 1000,
        decodedDurationMs: 900,
        state: 'ready',
        complete: false,
      },
      {
        id: 'second',
        startMs: 5000,
        durableEndMs: 6000,
        decodedDurationMs: 1000,
        state: 'ready',
        complete: true,
      },
    ];
    expect(locateRecordingMoment(epochs, 5500)).toEqual({ epochId: 'second', offsetMs: 500 });
    for (const time of [-1, 950, 2000, 6000, NaN])
      expect(locateRecordingMoment(epochs, time)).toBeNull();
  });

  it('requires operation-specific, current permission for this exact event and source', () => {
    const source = { sourceUrl: 'https://owned.example/hearing', hearingId: 'event-1' };
    const grant = {
      ...source,
      mode: 'browser',
      operations: ['capture', 'transcription', 'retention', 'analysis'],
      expiresAt: new Date('2030-01-01'),
      revokedAt: null,
      retentionDays: 7,
    };
    const now = new Date('2026-09-12');
    expect(permissionAllowsRecording(grant, source, now)).toBe(true);
    expect(permissionAllowsRecording(grant, { ...source, hearingId: 'event-2' }, now)).toBe(false);
    expect(permissionAllowsRecording({ ...grant, operations: ['view'] }, source, now)).toBe(false);
    expect(permissionAllowsRecording({ ...grant, revokedAt: now }, source, now)).toBe(false);
    expect(permissionAllowsRecording({ ...grant, retentionDays: 0 }, source, now)).toBe(false);
    expect(permissionAllowsRecording({ ...grant, expiresAt: now }, source, now)).toBe(false);
  });
});
