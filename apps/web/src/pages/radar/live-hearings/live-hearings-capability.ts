import type {
  CanonicalHearingEvent,
  HearingCapturePolicy,
  HearingPublicAccessStatus,
} from './live-hearings.types.js';

export interface HearingActionCapability {
  allowed: boolean;
  reason?: string;
  mode: 'SERVER' | 'BROWSER' | 'NONE';
}

const TERMINAL_EVENT_STATUSES = new Set(['CANCELED', 'COMPLETED']);
const CLOSED_ACCESS = new Set(['CLOSED', 'CLASSIFIED']);
const NO_STREAM_ACCESS = new Set(['NOT_STREAMED']);
const SERVER_BLOCKING_STREAM_STATES = new Set([
  'NO_PUBLIC_STREAM',
  'BROWSER_ONLY',
  'POLICY_BLOCKED',
  'SOURCE_ERROR',
]);
const ACTIVE_CAPTURE_STATES = new Set([
  'SCHEDULED',
  'PREPARING',
  'WAITING_FOR_BROADCAST',
  'RECORDING',
  'RECOVERING',
]);

export function normalizeEnum(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function safeOfficialHttpUrl(value?: string | null): string | undefined {
  const input = value?.trim();
  if (!input) return undefined;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function capturePolicyLabel(policy?: HearingCapturePolicy): string {
  switch (normalizeEnum(policy)) {
    case 'SERVER_CAPTURE_ALLOWED':
      return 'Automatic capture approved';
    case 'BROWSER_CAPTURE_ONLY':
      return 'Browser recording only';
    case 'LICENSE_REQUIRED':
      return 'License required';
    case 'BLOCKED':
      return 'Capture blocked';
    case 'REVIEW_REQUIRED':
      return 'Source review required';
    default:
      return 'Capture eligibility pending';
  }
}

function accessBlockReason(access: HearingPublicAccessStatus): string | undefined {
  const normalized = normalizeEnum(access);
  if (normalized === 'CLOSED') return 'This proceeding is closed to the public.';
  if (normalized === 'CLASSIFIED') return 'This proceeding is classified.';
  if (normalized === 'NOT_STREAMED') return 'The committee has not provided a public stream.';
  return undefined;
}

export function serverCaptureCapability(event: CanonicalHearingEvent): HearingActionCapability {
  const status = normalizeEnum(event.eventStatus);
  const access = normalizeEnum(event.publicAccessStatus);
  const policy = normalizeEnum(event.capturePolicy ?? event.capture?.capturePolicy);
  const streamState = normalizeEnum(event.streamState ?? event.capture?.streamState);
  const captureStatus = normalizeEnum(event.capture?.status);

  const accessReason = accessBlockReason(event.publicAccessStatus);
  if (accessReason) return { allowed: false, mode: 'NONE', reason: accessReason };
  if (status === 'CANCELED') {
    return { allowed: false, mode: 'NONE', reason: 'This proceeding was canceled.' };
  }
  if (status === 'COMPLETED' || streamState === 'ENDED') {
    return { allowed: false, mode: 'NONE', reason: 'The live proceeding has ended.' };
  }
  if (ACTIVE_CAPTURE_STATES.has(captureStatus)) {
    return { allowed: true, mode: 'SERVER', reason: 'Automatic capture is already scheduled.' };
  }
  if (policy !== 'SERVER_CAPTURE_ALLOWED') {
    const reason =
      policy === 'BROWSER_CAPTURE_ONLY'
        ? 'This source can be transcribed only while a user shares the official broadcast tab.'
        : policy === 'LICENSE_REQUIRED'
          ? 'Unattended capture requires an approved source license.'
          : policy === 'BLOCKED'
            ? 'This source is blocked by capture policy.'
            : policy === 'REVIEW_REQUIRED'
              ? 'This source must be reviewed before unattended capture can be enabled.'
              : 'Automatic capture eligibility has not been confirmed.';
    return { allowed: false, mode: policy === 'BROWSER_CAPTURE_ONLY' ? 'BROWSER' : 'NONE', reason };
  }
  if (SERVER_BLOCKING_STREAM_STATES.has(streamState)) {
    const reason =
      streamState === 'NO_PUBLIC_STREAM'
        ? 'No public stream is available.'
        : streamState === 'BROWSER_ONLY'
          ? 'This source is available only through browser-assisted recording.'
          : streamState === 'POLICY_BLOCKED'
            ? 'The resolved source is blocked by capture policy.'
            : 'The official stream could not be resolved.';
    return { allowed: false, mode: streamState === 'BROWSER_ONLY' ? 'BROWSER' : 'NONE', reason };
  }
  if (access && access !== 'PUBLIC' && access !== 'UNKNOWN') {
    return { allowed: false, mode: 'NONE', reason: 'Public access has not been confirmed.' };
  }
  return { allowed: true, mode: 'SERVER' };
}

export function browserCaptureCapability(event: CanonicalHearingEvent): HearingActionCapability {
  const status = normalizeEnum(event.eventStatus);
  const accessReason = accessBlockReason(event.publicAccessStatus);
  if (accessReason) return { allowed: false, mode: 'NONE', reason: accessReason };
  if (status === 'CANCELED') {
    return { allowed: false, mode: 'NONE', reason: 'This proceeding was canceled.' };
  }
  if (!safeOfficialHttpUrl(event.officialPageUrl)) {
    return {
      allowed: false,
      mode: 'NONE',
      reason: 'The official committee broadcast page has not been published.',
    };
  }
  return { allowed: true, mode: 'BROWSER' };
}

export function isLiveEvent(event: CanonicalHearingEvent, _now = new Date()): boolean {
  const eventStatus = normalizeEnum(event.eventStatus);
  const streamState = normalizeEnum(event.streamState);
  const captureStatus = normalizeEnum(event.capture?.status);
  if (TERMINAL_EVENT_STATUSES.has(eventStatus)) return false;
  if (event.actualEnd) return false;
  if (eventStatus === 'LIVE' || streamState === 'LIVE' || captureStatus === 'RECORDING') return true;
  // A scheduled clock time is not proof that a committee actually started.
  // Congressional votes and committee business frequently delay proceedings;
  // only an explicit actual-start signal may supplement the live state.
  return Boolean(event.actualStart);
}

export function captureStatusLabel(event: CanonicalHearingEvent): string {
  const status = normalizeEnum(event.capture?.status);
  const labels: Record<string, string> = {
    NOT_SCHEDULED: 'Not scheduled',
    SCHEDULED: 'Scheduled',
    PREPARING: 'Preparing',
    WAITING_FOR_BROADCAST: 'Waiting for broadcast',
    RECORDING: 'Recording',
    RECOVERING: 'Recovering',
    COMPLETE: 'Complete',
    COMPLETE_WITH_GAPS: 'Complete with gaps',
    FAILED: 'Capture failed',
    CANCELED: 'Canceled',
  };
  return labels[status] ?? capturePolicyLabel(event.capturePolicy);
}
