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
  if (assessment.state === 'CLOSED_SESSION') {
    return {
      code: 'CLOSED_PROCEEDING',
      message: assessment.message,
    };
  }
  if (assessment.scheduled) {
    // Idempotent, not an error — the caller re-applies the configuration.
    return null;
  }
  if (!assessment.canRequest) {
    return { code: assessment.reasonCode, message: assessment.message };
  }
  if (!assessment.availableModes.includes(requestedMode)) {
    return {
      code: 'ATTENDANCE_MODE_NOT_AVAILABLE',
      message:
        requestedMode === 'automatic'
          ? 'Unattended server capture is not permitted for this proceeding.'
          : 'Browser attendance is not available for this proceeding.',
    };
  }
  return null;
}
