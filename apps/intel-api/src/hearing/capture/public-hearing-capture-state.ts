export const PUBLIC_HEARING_CAPTURE_STATUSES = [
  'SCHEDULED',
  'PREPARING',
  'WAITING_FOR_STREAM',
  'READY',
  'CAPTURING',
  'RECOVERING',
  'FINALIZING',
  'COMPLETE',
  'COMPLETE_WITH_GAPS',
  'FAILED',
  'CANCELED',
  'BLOCKED',
] as const;
export type PublicHearingCaptureStatus = (typeof PUBLIC_HEARING_CAPTURE_STATUSES)[number];

export interface CaptureStateSnapshot {
  status: PublicHearingCaptureStatus;
  version: number;
  updatedAt: Date;
  failureCode?: string;
  failureDetail?: string;
}

export interface CaptureLease {
  ownerId: string;
  acquiredAt: Date;
  expiresAt: Date;
  fencingToken: number;
}

export interface CaptureGap {
  startMs: number;
  endMs: number;
  reason:
    | 'MEDIA_DISCONNECT'
    | 'DEEPGRAM_DISCONNECT'
    | 'WORKER_RESTART'
    | 'BUFFER_OVERFLOW'
    | 'SOURCE_SWITCH'
    | 'UNKNOWN';
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<PublicHearingCaptureStatus, ReadonlySet<PublicHearingCaptureStatus>>
> = Object.freeze({
  SCHEDULED: new Set<PublicHearingCaptureStatus>(['PREPARING', 'CANCELED', 'BLOCKED', 'FAILED']),
  PREPARING: new Set<PublicHearingCaptureStatus>(['WAITING_FOR_STREAM', 'READY', 'CANCELED', 'BLOCKED', 'FAILED']),
  WAITING_FOR_STREAM: new Set<PublicHearingCaptureStatus>(['PREPARING', 'READY', 'CANCELED', 'BLOCKED', 'FAILED']),
  READY: new Set<PublicHearingCaptureStatus>(['CAPTURING', 'PREPARING', 'CANCELED', 'BLOCKED', 'FAILED']),
  CAPTURING: new Set<PublicHearingCaptureStatus>(['RECOVERING', 'FINALIZING', 'CANCELED', 'FAILED']),
  RECOVERING: new Set<PublicHearingCaptureStatus>([
    'PREPARING',
    'CAPTURING',
    'FINALIZING',
    'FAILED',
    'CANCELED',
    'BLOCKED',
  ]),
  FINALIZING: new Set<PublicHearingCaptureStatus>(['COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED']),
  COMPLETE: new Set<PublicHearingCaptureStatus>(),
  COMPLETE_WITH_GAPS: new Set<PublicHearingCaptureStatus>(),
  FAILED: new Set<PublicHearingCaptureStatus>(),
  CANCELED: new Set<PublicHearingCaptureStatus>(),
  BLOCKED: new Set<PublicHearingCaptureStatus>(),
});

export function canTransitionCapture(
  from: PublicHearingCaptureStatus,
  to: PublicHearingCaptureStatus,
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].has(to);
}

export function transitionCapture(
  snapshot: CaptureStateSnapshot,
  to: PublicHearingCaptureStatus,
  now: Date,
  failure?: { code: string; detail?: string },
): CaptureStateSnapshot {
  if (!canTransitionCapture(snapshot.status, to)) {
    throw new Error(`Illegal public hearing capture transition ${snapshot.status} -> ${to}`);
  }
  const terminalFailure = to === 'FAILED';
  const boundedFailureCode = terminalFailure ? bound(failure?.code ?? '', 120) : undefined;
  if (terminalFailure && !boundedFailureCode) {
    throw new Error('FAILED capture transitions require a bounded failure code');
  }
  if (!Number.isFinite(now.getTime())) throw new Error('Capture transition time must be valid');
  return {
    status: to,
    version: snapshot.version + (snapshot.status === to ? 0 : 1),
    updatedAt: new Date(now),
    ...(terminalFailure
      ? {
          failureCode: boundedFailureCode!,
          failureDetail: failure?.detail ? bound(failure.detail, 1_000) : undefined,
        }
      : {}),
  };
}

/**
 * Stable database/idempotency key. A unique constraint on hearing_id remains the
 * final authority; this key lets queues collapse duplicate schedule messages.
 */
export function publicCaptureIdempotencyKey(hearingId: string): string {
  const normalized = hearingId.trim().toLowerCase();
  if (!normalized) throw new Error('hearingId is required');
  return `public-hearing-capture:v1:${normalized}`;
}

export function canAcquireCaptureLease(
  current: CaptureLease | null | undefined,
  contenderId: string,
  now: Date,
): boolean {
  if (!contenderId.trim() || !Number.isFinite(now.getTime())) return false;
  if (!current) return true;
  return current.expiresAt.getTime() <= now.getTime();
}

/**
 * Acquire only an absent or expired lease. Even the same worker id must renew an
 * active lease with its fencing token; reacquiring without a token would let a
 * restarted process impersonate the previous owner. Every expired acquisition
 * receives a new fencing token.
 */
export function acquireCaptureLease(
  current: CaptureLease | null | undefined,
  contenderId: string,
  now: Date,
  leaseDurationMs: number,
): CaptureLease {
  const ownerId = contenderId.trim();
  if (!ownerId) throw new Error('Capture lease owner id is required');
  if (!Number.isFinite(now.getTime())) throw new Error('Capture lease time must be valid');
  if (!canAcquireCaptureLease(current, ownerId, now)) {
    throw new Error(`Capture lease is held by ${current!.ownerId}`);
  }
  const duration = positiveDuration(leaseDurationMs);
  return {
    ownerId,
    acquiredAt: new Date(now),
    expiresAt: new Date(now.getTime() + duration),
    fencingToken: Math.max(0, current?.fencingToken ?? 0) + 1,
  };
}

export function renewCaptureLease(
  current: CaptureLease,
  ownerId: string,
  fencingToken: number,
  now: Date,
  leaseDurationMs: number,
): CaptureLease {
  if (!Number.isFinite(now.getTime())) throw new Error('Capture lease time must be valid');
  if (current.ownerId !== ownerId.trim() || current.fencingToken !== fencingToken) {
    throw new Error('Capture lease renewal rejected: owner or fencing token mismatch');
  }
  if (current.expiresAt.getTime() <= now.getTime()) {
    throw new Error('Capture lease renewal rejected: lease already expired');
  }
  return {
    ...current,
    expiresAt: new Date(now.getTime() + positiveDuration(leaseDurationMs)),
  };
}

export function releaseCaptureLease(
  current: CaptureLease,
  ownerId: string,
  fencingToken: number,
): null {
  if (current.ownerId !== ownerId.trim() || current.fencingToken !== fencingToken) {
    throw new Error('Capture lease release rejected: owner or fencing token mismatch');
  }
  return null;
}

export function mergeCaptureGaps(gaps: CaptureGap[], next: CaptureGap): CaptureGap[] {
  const normalized = normalizeGap(next);
  const sorted = [...gaps.map(normalizeGap), normalized].sort(
    (left, right) => left.startMs - right.startMs,
  );
  const merged: CaptureGap[] = [];
  for (const gap of sorted) {
    const previous = merged.at(-1);
    if (previous && gap.startMs <= previous.endMs && gap.reason === previous.reason) {
      previous.endMs = Math.max(previous.endMs, gap.endMs);
    } else {
      merged.push({ ...gap });
    }
  }
  return merged;
}

export function captureGapDurationMs(gaps: CaptureGap[]): number {
  return mergeAllGapsIgnoringReason(gaps).reduce(
    (total, gap) => total + Math.max(0, gap.endMs - gap.startMs),
    0,
  );
}

export function completionStatusForCapture(input: {
  capturedMs: number;
  gaps: CaptureGap[];
  terminalError?: boolean;
}): PublicHearingCaptureStatus {
  if (input.terminalError || input.capturedMs <= 0) return 'FAILED';
  return captureGapDurationMs(input.gaps) > 0 ? 'COMPLETE_WITH_GAPS' : 'COMPLETE';
}

export function isTerminalCaptureStatus(status: PublicHearingCaptureStatus): boolean {
  return (
    status === 'COMPLETE' ||
    status === 'COMPLETE_WITH_GAPS' ||
    status === 'FAILED' ||
    status === 'CANCELED' ||
    status === 'BLOCKED'
  );
}

function normalizeGap(gap: CaptureGap): CaptureGap {
  if (!Number.isFinite(gap.startMs) || !Number.isFinite(gap.endMs)) {
    throw new Error('Capture gap timestamps must be finite');
  }
  const startMs = Math.max(0, Math.floor(Math.min(gap.startMs, gap.endMs)));
  const endMs = Math.max(startMs, Math.ceil(Math.max(gap.startMs, gap.endMs)));
  return { ...gap, startMs, endMs };
}

function mergeAllGapsIgnoringReason(gaps: CaptureGap[]): Array<Pick<CaptureGap, 'startMs' | 'endMs'>> {
  const sorted = gaps.map(normalizeGap).sort((left, right) => left.startMs - right.startMs);
  const merged: Array<Pick<CaptureGap, 'startMs' | 'endMs'>> = [];
  for (const gap of sorted) {
    const previous = merged.at(-1);
    if (previous && gap.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, gap.endMs);
    } else {
      merged.push({ startMs: gap.startMs, endMs: gap.endMs });
    }
  }
  return merged;
}

function positiveDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('leaseDurationMs must be positive');
  return Math.floor(value);
}

function bound(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}
