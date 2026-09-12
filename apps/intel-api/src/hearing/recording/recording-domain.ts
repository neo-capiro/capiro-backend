import { createHash } from 'node:crypto';

export const RECORDING_FRAME_HEADER_BYTES = 16;
export const RECORDING_MAX_PART_BYTES = 256 * 1024;
export const RECORDING_MAX_DURATION_MS = 12 * 60 * 60 * 1000;
export const RECORDING_REQUIRED_OPERATIONS = ['capture', 'transcription', 'retention'] as const;

/** Only transport/transaction availability failures can retry identical bytes.
 * Access, source policy, order/hash conflicts and invalid media must still stop.
 */
export function retryableRecordingFailure(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    ['AbortError', 'TimeoutError', 'RequestTimeout', 'SlowDown', 'ThrottlingException'].includes(
      value.name ?? '',
    ) ||
    [
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'P1001',
      'P1002',
      'P1008',
      'P1017',
      'P2024',
      'P2028',
      'P2034',
    ].includes(value.code ?? '') ||
    [429, 500, 502, 503, 504].includes(value.$metadata?.httpStatusCode ?? 0)
  );
}

/** LWA4 + uint32 sequence + float64 recorder elapsed milliseconds, big endian.
 * The elapsed clock is measured by the browser; it is not a blob-count clock.
 * Fragments may split a MediaRecorder blob; only their ordered epoch is media.
 */
export function decodeRecordingFrame(frame: Buffer) {
  if (
    frame.length <= RECORDING_FRAME_HEADER_BYTES ||
    frame.length > RECORDING_MAX_PART_BYTES + RECORDING_FRAME_HEADER_BYTES ||
    frame.toString('ascii', 0, 4) !== 'LWA4'
  ) {
    throw new Error('Invalid retained-audio frame');
  }
  const sequence = frame.readUInt32BE(4);
  const endMs = frame.readDoubleBE(8);
  if (
    !Number.isSafeInteger(endMs) ||
    endMs < 0 ||
    endMs > RECORDING_MAX_DURATION_MS ||
    sequence > 1_000_000
  ) {
    throw new Error('Invalid retained-audio sequence or time');
  }
  const bytes = frame.subarray(RECORDING_FRAME_HEADER_BYTES);
  return { sequence, endMs, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function assertPartOrder(
  checkpoint: { durableSequence: number; durableEndMs: number; startMs: number },
  part: { sequence: number; endMs: number },
) {
  if (part.sequence !== checkpoint.durableSequence + 1)
    throw new Error('Audio part is out of order');
  if (part.endMs < checkpoint.durableEndMs - checkpoint.startMs)
    throw new Error('Audio time moved backwards');
}

export interface PlaybackEpoch {
  id: string;
  startMs: number;
  durableEndMs: number;
  decodedDurationMs: number | null;
  state: string;
  complete: boolean;
}

/** Never seek through a gap, interpolate missing media, or invent source time. */
export function locateRecordingMoment(epochs: PlaybackEpoch[], recordingMs: number) {
  if (!Number.isFinite(recordingMs) || recordingMs < 0) return null;
  for (const epoch of epochs) {
    if (epoch.state !== 'ready' || epoch.decodedDurationMs == null) continue;
    const end = Math.min(epoch.durableEndMs, epoch.startMs + epoch.decodedDurationMs);
    if (recordingMs >= epoch.startMs && recordingMs < end) {
      return { epochId: epoch.id, offsetMs: recordingMs - epoch.startMs };
    }
  }
  return null;
}

export function permissionAllowsRecording(
  grant: {
    mode: string;
    sourceUrl: string;
    hearingId: string | null;
    operations: string[];
    expiresAt: Date;
    revokedAt: Date | null;
    retentionDays: number;
  },
  source: { sourceUrl: string | null; hearingId: string | null },
  now = new Date(),
) {
  return (
    grant.mode === 'browser' &&
    grant.sourceUrl === source.sourceUrl &&
    grant.hearingId === source.hearingId &&
    grant.revokedAt == null &&
    grant.expiresAt > now &&
    Number.isInteger(grant.retentionDays) &&
    grant.retentionDays >= 1 &&
    grant.retentionDays <= 90 &&
    RECORDING_REQUIRED_OPERATIONS.every((operation) => grant.operations.includes(operation))
  );
}
