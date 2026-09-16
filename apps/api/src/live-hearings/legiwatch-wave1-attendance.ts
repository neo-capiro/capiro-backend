/**
 * LegiWatch V2 Wave 1 (W1-2) — attendance state.
 *
 * ONE derivation, used by both the server's request-boundary enforcement and
 * the UI's affordances. A client that bypasses the frontend controls hits the
 * same function on the way in, so the honest state and the enforced state can
 * never drift apart.
 *
 * This module is PURE. It classifies an already-loaded canonical hearing plus
 * its stream candidates and existing capture; it performs no I/O and creates
 * no capture demand.
 *
 * ── Why this wraps the Phase 7 guard instead of replacing it ──
 *
 * `assessStrictSchedulePolicy` is the shipped, fail-closed policy ceiling for
 * unattended capture, and Wave 1 must not weaken it. But its five states
 * (READY / PREFLIGHT_REQUIRED / BROWSER_ONLY / LICENSE_REQUIRED / BLOCKED)
 * answer only "may this become server-capture demand?". The product has to
 * distinguish cases the guard collapses into one BLOCKED — a closed session, a
 * cancelled event, and a public event with no capturable source are three
 * different things to a user — and has to report the states that exist only
 * AFTER demand is accepted (already scheduled, capturing, processing,
 * complete, failed).
 *
 * So the guard stays authoritative for eligibility, and this layer adds the
 * lifecycle and the reason detail on top of its verdict.
 */
import {
  assessStrictSchedulePolicy,
  type StrictScheduleAssessment,
} from './live-hearings-phase7-schedule.guard.js';
import { selectBrowserSource } from './live-hearings-browser-source.js';

/**
 * The user-facing attendance states, in the vocabulary the product speaks.
 *
 * The ordering below is the lifecycle: everything from `SCHEDULED` onward
 * describes a hearing whose demand already exists.
 */
export type AttendanceState =
  /** Unattended server capture is available and may be requested. */
  | 'AUTOMATIC_AVAILABLE'
  /** Demand may be accepted, but the official source still needs preflight. */
  | 'AUTOMATIC_PENDING_PREFLIGHT'
  /** The verified source permits browser attendance only. */
  | 'BROWSER_ONLY'
  /** Public proceeding, but no source is eligible for capture. */
  | 'NO_PUBLIC_STREAM'
  /** Verified closed / private / classified / executive session. */
  | 'CLOSED_SESSION'
  /** Not eligible for another explicit, auditable reason (license, cancelled). */
  | 'NOT_ELIGIBLE'
  /** This tenant already has attendance scheduled. */
  | 'SCHEDULED'
  /** The canonical capture is running now. */
  | 'CAPTURING'
  /** Capture ended; transcript/intelligence still being produced. */
  | 'PROCESSING'
  /** Canonical transcript is complete. */
  | 'COMPLETE'
  /** The canonical capture reached a terminal failure. */
  | 'FAILED';

export interface AttendanceHearingRow {
  id: string;
  /** 'public' | 'private' */
  visibility: string;
  /** 'scheduled' | 'postponed' | 'canceled' | 'in_progress' | 'completed' */
  eventStatus: string;
  url?: string | null;
}

export interface AttendanceCandidateRow {
  capturePolicy: string;
  resolutionState: string;
  /** Present when the caller projects it (the Wave 1 service does); used to
   *  decide browser availability via the same source selection as join. */
  officialPageUrl?: string | null;
}

export interface AttendanceCaptureRow {
  /** 'SCHEDULED' | 'CAPTURING' | 'COMPLETE' | 'COMPLETE_WITH_GAPS' | 'FAILED' | 'CANCELED' | 'BLOCKED' */
  domainStatus: string;
  failureCode?: string | null;
  terminalReasonCode?: string | null;
}

export interface AttendanceSubscriptionRow {
  scheduledByUser: boolean;
  attendanceMode: string;
  consentAcknowledgedAt?: Date | null;
}

export interface AttendanceAssessment {
  state: AttendanceState;
  /** Durable audit code. Human-readable detail supplements it, never replaces it. */
  reasonCode: string;
  message: string;
  /**
   * Whether a NEW attendance request may be accepted right now. This is the
   * request-boundary decision; it is false for every terminal/ineligible state
   * AND for a hearing this tenant has already scheduled.
   */
  canRequest: boolean;
  /** Which mechanisms the user may legitimately choose from. */
  availableModes: Array<'automatic' | 'browser'>;
  /** True when the chosen mode requires a recorded consent attestation. */
  consentRequired: boolean;
  /** Present when this tenant already has a demand row. */
  scheduled: boolean;
  /**
   * Whether the user may open a private browser capture context for this
   * hearing RIGHT NOW, independent of server state. True for any public,
   * non-canceled hearing that has a usable browser source (a candidate page or
   * the official listing url). An active/complete/failed canonical capture
   * never locks this out.
   */
  browserAvailable: boolean;
  /**
   * Whether a FRESH automatic (server) request would be accepted RIGHT NOW,
   * independent of whether the user currently has a browser session open.
   */
  automaticAvailable: boolean;
  /** The Phase 7 policy verdict this assessment is built on. */
  policy: StrictScheduleAssessment;
}

/**
 * Terminal capture states, mapped to the lifecycle vocabulary. COMPLETE and
 * COMPLETE_WITH_GAPS are both complete: gaps are surfaced separately as
 * transcript detail, and calling a gapped capture "failed" would be wrong.
 */
const CAPTURE_LIFECYCLE: Record<string, AttendanceState> = {
  SCHEDULED: 'SCHEDULED',
  CAPTURING: 'CAPTURING',
  COMPLETE: 'COMPLETE',
  COMPLETE_WITH_GAPS: 'COMPLETE',
  FAILED: 'FAILED',
  BLOCKED: 'NOT_ELIGIBLE',
  CANCELED: 'NOT_ELIGIBLE',
};

/**
 * Verified-closed detection.
 *
 * Only a VERIFIED non-public visibility is a closed session. An unverified or
 * unknown value must fail CLOSED for capture (the guard already does that) but
 * must NOT be reported to the user as "closed session" — claiming a proceeding
 * is closed when the source never said so is its own inaccuracy.
 */
export function isVerifiedClosed(visibility: string | null | undefined): boolean {
  const v = (visibility ?? '').trim().toLowerCase();
  return v === 'private' || v === 'closed' || v === 'classified' || v === 'executive';
}

/**
 * Derive the attendance state for one hearing and one tenant.
 *
 * Precedence is deliberate:
 *   1. A verified closed session is closed, whatever else is true. Nothing
 *      downstream may offer an attendance affordance for it.
 *   2. An existing canonical capture describes reality and outranks any
 *      eligibility opinion about a hearing that already ran.
 *   3. This tenant's own demand row.
 *   4. Finally, the Phase 7 eligibility verdict for a fresh request.
 */
/**
 * Independent browser/server capabilities, derived once per assessment.
 * Browser availability rides on the public source existing at all; it is never
 * denied by a server-side policy (including BLOCKED) or by an active/failed/
 * complete canonical capture.
 */
function deriveCapabilities(input: {
  hearing: AttendanceHearingRow;
  candidates: AttendanceCandidateRow[];
  capture?: AttendanceCaptureRow | null;
  policy: StrictScheduleAssessment;
}): { browserAvailable: boolean; automaticAvailable: boolean } {
  const { hearing, policy } = input;
  // Browser join requires EXACTLY public visibility — an unknown/unverified
  // value must not advertise a browser affordance join would then refuse.
  const isPublic = (hearing.visibility ?? '').trim().toLowerCase() === 'public';
  const canceled = hearing.eventStatus === 'canceled' || hearing.eventStatus === 'cancelled';
  // Reuse the same validated source selection as browserJoin so an invalid or
  // url-less candidate set cannot advertise a source join would not produce.
  const source = selectBrowserSource({
    hearingUrl: hearing.url ?? null,
    candidates: input.candidates.map((c) => ({
      provider: (c as { provider?: string }).provider ?? 'unknown',
      officialPageUrl: c.officialPageUrl ?? '',
      capturePolicy: c.capturePolicy,
    })),
  });
  const browserAvailable = isPublic && !canceled && source != null;
  // automaticAvailable truthfully means "a fresh automatic request would be
  // accepted AND acted on". Phase 7.schedule reuses the ONE existing canonical
  // capture id rather than rejecting it, so an already-ACTIVE capture is NOT a
  // duplicate recorder and must not veto another tenant's (or the same
  // tenant's idempotent) demand. But a TERMINAL canonical capture (FAILED /
  // CANCELED / BLOCKED / COMPLETE*) is different: the orchestrator returns
  // TERMINAL immediately and Phase 7 reuses the id WITHOUT a reset, so offering
  // automatic would claim a new capture that does nothing. No retry workflow
  // is added here — the browser fallback stays available instead.
  const terminalCanonical =
    input.capture != null &&
    ['FAILED', 'CANCELED', 'BLOCKED', 'COMPLETE', 'COMPLETE_WITH_GAPS'].includes(
      input.capture.domainStatus.toUpperCase(),
    );
  const automaticAvailable =
    isPublic &&
    !canceled &&
    !terminalCanonical &&
    (policy.state === 'READY' || policy.state === 'PREFLIGHT_REQUIRED');
  return { browserAvailable, automaticAvailable };
}

export function assessAttendance(input: {
  hearing: AttendanceHearingRow;
  candidates: AttendanceCandidateRow[];
  capture?: AttendanceCaptureRow | null;
  subscription?: AttendanceSubscriptionRow | null;
  /** Whether a canonical transcript exists yet (drives PROCESSING vs COMPLETE). */
  hasTranscript?: boolean;
  /** A reviewed state adapter may narrow the modes independently. */
  statePermission?: { policy: StrictScheduleAssessment; browserAllowed: boolean };
}): AttendanceAssessment {
  const policy = input.statePermission?.policy ?? assessStrictSchedulePolicy(input.hearing, input.candidates);
  const base = assessAttendanceCore({ ...input, policy });
  const capabilities = deriveCapabilities({ ...input, policy });
  // A reviewed state adapter narrows browser availability too; it is the only
  // authority that can deny the browser while still public.
  const browserAvailable =
    input.statePermission && !input.statePermission.browserAllowed
      ? false
      : capabilities.browserAvailable;
  return { ...base, browserAvailable, automaticAvailable: capabilities.automaticAvailable };
}

function assessAttendanceCore(input: {
  hearing: AttendanceHearingRow;
  candidates: AttendanceCandidateRow[];
  capture?: AttendanceCaptureRow | null;
  subscription?: AttendanceSubscriptionRow | null;
  hasTranscript?: boolean;
  statePermission?: { policy: StrictScheduleAssessment; browserAllowed: boolean };
  policy: StrictScheduleAssessment;
}): Omit<AttendanceAssessment, 'browserAvailable' | 'automaticAvailable'> {
  const { hearing, candidates, capture, subscription } = input;
  const policy = input.statePermission?.policy ?? assessStrictSchedulePolicy(hearing, candidates);
  const scheduled = Boolean(subscription?.scheduledByUser);

  // 1. Verified closed session — terminal, and never an attendance affordance.
  if (isVerifiedClosed(hearing.visibility)) {
    return {
      state: 'CLOSED_SESSION',
      reasonCode: 'CLOSED_PROCEEDING',
      message:
        'This is a closed session. Capiro does not attend or capture non-public proceedings.',
      canRequest: false,
      availableModes: [],
      consentRequired: false,
      scheduled,
      policy,
    };
  }

  // 2. An existing canonical capture is the truth about what happened.
  if (capture) {
    const lifecycle = CAPTURE_LIFECYCLE[capture.domainStatus.toUpperCase()];
    if (lifecycle === 'COMPLETE') {
      // Capture finished but the transcript has not landed yet: that is
      // PROCESSING, not COMPLETE. Reporting COMPLETE here is what makes a
      // user open a hearing and find nothing.
      const state: AttendanceState = input.hasTranscript ? 'COMPLETE' : 'PROCESSING';
      return {
        state,
        reasonCode: capture.terminalReasonCode ?? 'CAPTURE_COMPLETE',
        message:
          state === 'COMPLETE'
            ? 'The canonical transcript for this proceeding is available.'
            : 'Capture finished; the canonical transcript is still being produced.',
        canRequest: false,
        availableModes: [],
        consentRequired: false,
        scheduled,
        policy,
      };
    }
    if (lifecycle === 'FAILED') {
      return {
        state: 'FAILED',
        reasonCode: capture.failureCode ?? capture.terminalReasonCode ?? 'CAPTURE_FAILED',
        message:
          'Capture of this proceeding failed. Any partial transcript is shown with its gaps.',
        canRequest: false,
        availableModes: [],
        consentRequired: false,
        scheduled,
        policy,
      };
    }
    if (lifecycle === 'CAPTURING') {
      return {
        state: 'CAPTURING',
        reasonCode: 'CAPTURE_IN_PROGRESS',
        message: 'Capiro is capturing this proceeding now.',
        // Joining an in-flight capture is not a new request: the one canonical
        // capture already exists and this tenant either has demand or does not.
        canRequest: false,
        availableModes: [],
        consentRequired: false,
        scheduled,
        policy,
      };
    }
    if (lifecycle === 'NOT_ELIGIBLE') {
      return {
        state: 'NOT_ELIGIBLE',
        reasonCode: capture.terminalReasonCode ?? 'CAPTURE_BLOCKED',
        message: 'Capture of this proceeding was blocked or canceled.',
        canRequest: false,
        availableModes: [],
        consentRequired: false,
        scheduled,
        policy,
      };
    }
    // domainStatus SCHEDULED: a canonical capture is queued. Whether THIS
    // tenant is attending is answered by their own demand row below.
  }

  // 3. This tenant already asked. Re-requesting is a no-op, not an error.
  if (scheduled) {
    return {
      state: 'SCHEDULED',
      reasonCode: 'ATTENDANCE_ALREADY_SCHEDULED',
      message:
        subscription?.attendanceMode === 'browser'
          ? 'Browser attendance is scheduled for this proceeding.'
          : 'Capiro is scheduled to attend this proceeding.',
      canRequest: false,
      availableModes: [],
      consentRequired: false,
      scheduled: true,
      policy,
    };
  }

  // 4. A fresh request: the Phase 7 verdict decides, with the reason detail
  //    the guard's single BLOCKED state cannot express.
  switch (policy.state) {
    case 'READY':
      return {
        state: 'AUTOMATIC_AVAILABLE',
        reasonCode: policy.reasonCode,
        message: policy.message,
        canRequest: true,
        availableModes:
          input.statePermission && !input.statePermission.browserAllowed
            ? ['automatic']
            : ['automatic', 'browser'],
        consentRequired: false,
        scheduled: false,
        policy,
      };
    case 'PREFLIGHT_REQUIRED':
      return {
        state: 'AUTOMATIC_PENDING_PREFLIGHT',
        reasonCode: policy.reasonCode,
        message: policy.message,
        canRequest: true,
        availableModes:
          input.statePermission && !input.statePermission.browserAllowed
            ? ['automatic']
            : ['automatic', 'browser'],
        consentRequired: false,
        scheduled: false,
        policy,
      };
    case 'BROWSER_ONLY':
      return {
        state: 'BROWSER_ONLY',
        reasonCode: policy.reasonCode,
        message: policy.message,
        // Browser attendance is a different mode, not a downgrade of the same
        // request: the user records the tab themselves, so it needs consent
        // and it must never be presented as "Capiro will attend".
        canRequest: Boolean(hearing.url),
        availableModes: hearing.url ? ['browser'] : [],
        consentRequired: true,
        scheduled: false,
        policy,
      };
    case 'LICENSE_REQUIRED':
      return {
        state: 'NOT_ELIGIBLE',
        reasonCode: policy.reasonCode,
        message: policy.message,
        canRequest: false,
        availableModes: [],
        consentRequired: false,
        scheduled: false,
        policy,
      };
    case 'BLOCKED':
    default:
      // Separate the "public event, nothing capturable" case from the rest so
      // the UI can say which one it is.
      if (policy.reasonCode === 'NO_SERVER_CAPTURABLE_SOURCE') {
        return {
          state: 'NO_PUBLIC_STREAM',
          reasonCode: policy.reasonCode,
          message: policy.message,
          canRequest: Boolean(hearing.url),
          availableModes: hearing.url ? ['browser'] : [],
          consentRequired: true,
          scheduled: false,
          policy,
        };
      }
      return {
        state: 'NOT_ELIGIBLE',
        reasonCode: policy.reasonCode,
        message: policy.message,
        canRequest: false,
        availableModes: [],
        consentRequired: false,
        scheduled: false,
        policy,
      };
  }
}

/**
 * Request-boundary check for an incoming attendance request.
 *
 * Returns null when the request is permitted; otherwise the reason it is
 * refused. The controller turns a non-null result into a 409 so a client that
 * bypassed the UI gets the same answer the UI would have shown.
 */
export function refuseAttendanceRequest(
  assessment: AttendanceAssessment,
  requestedMode: 'automatic' | 'browser',
): { code: string; message: string } | null {
  // Closed proceedings are refused at the boundary regardless of any flag —
  // a stale scheduled row or a stray candidate never unlocks them.
  if (assessment.state === 'CLOSED_SESSION') {
    return {
      code: 'CLOSED_PROCEEDING',
      message: assessment.message,
    };
  }
  // Canceled events are refused too: scheduling must not bypass a canceled
  // event just because a row already exists. The assessment's own reasonCode
  // may say ATTENDANCE_ALREADY_SCHEDULED, so check the policy verdict — it is
  // computed from the hearing independently of the scheduled branch.
  if (assessment.reasonCode === 'EVENT_CANCELED' || assessment.policy.reasonCode === 'EVENT_CANCELED') {
    return { code: 'EVENT_CANCELED', message: 'This proceeding has been canceled.' };
  }

  // Per-mode INDEPENDENT decision. The request boundary uses the mode's own
  // capability flag, not the global canRequest/availableModes (which describe
  // only FRESH demand and would wrongly 409 a browser request after the
  // canonical capture is already active/complete).
  if (requestedMode === 'browser') {
    if (!assessment.browserAvailable) {
      return {
        code: 'ATTENDANCE_MODE_NOT_AVAILABLE',
        message: 'Browser attendance is not available for this proceeding.',
      };
    }
    return null;
  }

  // automatic
  if (assessment.scheduled && assessment.automaticAvailable) {
    // Same-mode re-request while policy still permits: idempotent re-apply.
    return null;
  }
  if (!assessment.automaticAvailable) {
    return {
      code: assessment.canRequest ? 'ATTENDANCE_MODE_NOT_AVAILABLE' : assessment.reasonCode,
      message: assessment.canRequest
        ? 'Unattended server capture is not permitted for this proceeding.'
        : assessment.message,
    };
  }
  return null;
}
