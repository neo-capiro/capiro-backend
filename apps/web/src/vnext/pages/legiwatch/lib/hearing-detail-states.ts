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

type EventForAvailability = Partial<
  Pick<CanonicalHearingEvent, 'eventStatus' | 'publicAccessStatus' | 'capture'>
>;

/** Honest transcript/intelligence availability copy per event + capture state. */
export function transcriptAvailability(
  e: EventForAvailability,
): { available: boolean; note: string; state: string } {
  const status = (e.eventStatus ?? '').toUpperCase();
  if (status === 'SCHEDULED' || status === 'POSTPONED') {
    return {
      available: false,
      state: 'not-yet-occurred',
      note: 'This proceeding has not occurred yet. The transcript appears here once the gavel sounds and processing completes.',
    };
  }
  if (status === 'CANCELED') {
    return {
      available: false,
      state: 'canceled',
      note: 'This proceeding was canceled — no transcript exists.',
    };
  }
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
  if (captureStatus === 'FAILED' || e.capture?.failureReason) {
    return {
      available: false,
      state: 'capture-failed',
      note: `Capture failed${e.capture?.failureReason ? `: ${e.capture.failureReason}` : ''} — no transcript was produced.`,
    };
  }
  if (
    captureStatus === 'CAPTURING' ||
    captureStatus === 'READY' ||
    captureStatus === 'PREPARING' ||
    captureStatus === 'WAITING_FOR_STREAM' ||
    captureStatus === 'SCHEDULED'
  ) {
    return {
      available: false,
      state: 'capture-in-progress',
      note: 'Capture is in progress. Transcript segments appear as processing completes.',
    };
  }
  if (status === 'COMPLETED' && (!captureStatus || captureStatus === 'NOT_SCHEDULED')) {
    return {
      available: false,
      state: 'completed-without-capture',
      note: 'Completed, but no capture was requested — Capiro has no transcript for this proceeding.',
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
