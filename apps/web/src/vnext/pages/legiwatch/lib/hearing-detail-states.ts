/**
 * Pure helpers for the canonical hearing-detail route (PR B / LW-QA-003).
 * Extracted so the full state matrix can be asserted without mounting React.
 *
 * Closed-session rule (LW-QA-002, re-verified 2026-09-03):
 *   CLOSED / PRIVATE = verified negative → closed session copy
 *   UNKNOWN / missing = unverified → capture fails closed, but NEVER labeled closed
 */
import type { CanonicalHearingEvent } from '../../../../pages/radar/live-hearings/live-hearings.types.js';

export type DetailAccessClass = 'closed' | 'public' | 'unverified';

export function classifyPublicAccess(
  publicAccessStatus: string | null | undefined,
): DetailAccessClass {
  const access = (publicAccessStatus ?? 'UNKNOWN').toUpperCase();
  if (access === 'CLOSED' || access === 'PRIVATE') return 'closed';
  if (access === 'PUBLIC') return 'public';
  return 'unverified';
}

export function isClosedSession(publicAccessStatus: string | null | undefined): boolean {
  return classifyPublicAccess(publicAccessStatus) === 'closed';
}

export function accessPillLabel(publicAccessStatus: string | null | undefined): string {
  const cls = classifyPublicAccess(publicAccessStatus);
  if (cls === 'closed') return 'CLOSED SESSION';
  if (cls === 'public') return 'PUBLIC';
  return 'ACCESS UNVERIFIED';
}

/** Source availability is distinct from a completed or authorized recording. */
export function streamStatusLabel(state: string | null | undefined): string {
  const labels: Record<string, string> = {
    NOT_CHECKED: 'Not yet checked',
    WAITING_FOR_STREAM: 'Waiting for stream',
    READY: 'Stream ready',
    READY_FOR_SERVER_CAPTURE: 'Stream ready',
    LIVE: 'Live',
    ENDED: 'Ended',
    ARCHIVED: 'Archived',
    NO_PUBLIC_STREAM: 'No public stream',
    BROWSER_ONLY: 'Browser recording only',
    BROWSER_CAPTURE_ONLY: 'Browser recording only',
    POLICY_BLOCKED: 'Stream access restricted',
    SOURCE_ERROR: 'Stream unavailable',
    CANCELED: 'Canceled',
    CANCELLED: 'Canceled',
  };
  return labels[state?.trim().toUpperCase() || 'NOT_CHECKED'] ?? 'Status unavailable';
}

type EventForAvailability = Partial<
  Pick<CanonicalHearingEvent, 'eventStatus' | 'publicAccessStatus' | 'capture'>
>;

/** Honest transcript/intelligence availability copy per event + capture state. */
export function transcriptAvailability(
  e: EventForAvailability,
): { available: boolean; note: string; state: string } {
  const status = (e.eventStatus ?? '').toUpperCase();
  if (isClosedSession(e.publicAccessStatus)) {
    return {
      available: false,
      state: 'closed',
      note: 'Closed session — no public stream, therefore no public transcript.',
    };
  }
  // UNKNOWN access is unverified — still no public transcript claim, but never
  // the closed-session copy (LW-QA-002).
  if (classifyPublicAccess(e.publicAccessStatus) === 'unverified') {
    return {
      available: false,
      state: 'access-unverified',
      note: 'Public access is unverified — no public transcript is available until access is confirmed.',
    };
  }
  const captureStatus = (e.capture?.status ?? '').toUpperCase();
  if (captureStatus === 'FAILED') {
    return {
      available: true,
      state: 'capture-failed',
      note: `Capture failed${e.capture?.failureReason ? `: ${e.capture.failureReason}` : ''}. Any transcript recorded before the failure remains available below.`,
    };
  }
  if (
    captureStatus === 'CAPTURING' ||
    captureStatus === 'RECORDING' ||
    captureStatus === 'RECOVERING' ||
    captureStatus === 'READY' ||
    captureStatus === 'PREPARING' ||
    captureStatus === 'WAITING_FOR_STREAM' ||
    captureStatus === 'SCHEDULED'
  ) {
    return {
      available: true,
      state: 'capture-in-progress',
      note: 'Capture is in progress. Transcript segments appear as processing completes.',
    };
  }
  // A canonical capture can run before an official calendar's status catches
  // up. Its recorded/live segments must not disappear behind stale SCHEDULED
  // metadata. Calendar status alone does not establish whether it occurred.
  if (!captureStatus || captureStatus === 'NOT_SCHEDULED') {
    if (status === 'SCHEDULED' || status === 'POSTPONED') {
      return {
        available: false,
        state: 'not-yet-occurred',
        note: 'No automatic-capture transcript is available. Check the published notice for the latest proceeding status and saved sessions for any recorded content.',
      };
    }
    if (status === 'CANCELED' || status === 'CANCELLED') {
      return {
        available: false,
        state: 'canceled',
        note: 'This proceeding was canceled and has no capture record.',
      };
    }
  }
  if (status === 'COMPLETED' && (!captureStatus || captureStatus === 'NOT_SCHEDULED')) {
    return {
      available: false,
      state: 'completed-without-capture',
      note: 'Completed without an automatic capture transcript. Check saved hearing sessions for browser transcripts.',
    };
  }
  if (status === 'COMPLETED' && (captureStatus === 'COMPLETE' || captureStatus === 'COMPLETE_WITH_GAPS' || captureStatus === 'ENDED')) {
    return {
      available: true,
      state: 'transcript-ready',
      note: 'Transcript from the canonical capture record.',
    };
  }
  // Default: allow the transcript endpoint to speak for itself (loading/empty).
  return {
    available: true,
    state: 'transcript-ready',
    note: 'Transcript from the canonical capture record.',
  };
}

/**
 * Navigation target for a calendar chip / list row / committee-room row /
 * My Sessions history row. Live stays on the room route; everything else goes
 * to canonical detail by id. NEVER title-fuzzy.
 */
export function hearingNavigationTarget(
  e: Pick<CanonicalHearingEvent, 'id' | 'eventStatus'>,
): { kind: 'live-room' } | { kind: 'detail'; hearingId: string } {
  // Match HearingsTab.openHearing: only lowercase in_progress is live.
  if ((e.eventStatus ?? '') === 'in_progress') return { kind: 'live-room' };
  return { kind: 'detail', hearingId: e.id };
}

/**
 * Transcript speaker as shown to the user: the resolved name, else a 1-based
 * ordinal for a raw diarization index ("0" → "Speaker 1"), else the label.
 */
export function speakerDisplay(segment: {
  speakerName?: string | null;
  speakerLabel?: string | null;
}): string | null {
  const name = segment.speakerName?.trim();
  if (name) return name;
  const label = segment.speakerLabel?.trim();
  if (!label) return null;
  return /^\d+$/.test(label) ? `Speaker ${Number(label) + 1}` : label;
}
