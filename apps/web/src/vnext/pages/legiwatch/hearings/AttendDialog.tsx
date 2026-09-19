/**
 * LegiWatch V2 Wave 1 (W1-2) — the Attend dialog.
 *
 * DISTINCT from Follow. This dialog asks Capiro to capture and transcribe a
 * proceeding, so it is about capture capability, consent and scheduling — never
 * about notifications.
 *
 * Two INDEPENDENT capture actions live here, not an exclusive either/or:
 *   - Server attendance ("Capiro attends automatically") schedules the
 *     canonical server capture. It runs on Capiro's infrastructure and does not
 *     need this browser open.
 *   - Browser attendance opens a private browser room that shares the tab's
 *     audio. It stays available as a fallback even while server capture is
 *     scheduled or running, and scheduling server capture never removes it.
 *
 * Every state shown here comes from the server's own attendance assessment, the
 * same derivation the server enforces on the way in. The dialog never renders
 * "Attend live" or automatic capture for a closed, private, classified or
 * executive session, and it never claims a capture is active when only a
 * session was created.
 */
import { useRef, useState } from 'react';
import {
  useAttendance,
  useCancelAttendance,
  useOpenBrowserRoom,
  useRequestAttendance,
  w1Error,
  type AttendanceAssessment,
  type AttendanceState,
} from '../lib/wave1-api.js';
import { LwModal } from '../overlays/LwModal.js';
import { LwPill } from '../lib/primitives.js';

/** The user-facing label for each honest state. */
export const ATTENDANCE_LABEL: Record<AttendanceState, string> = {
  AUTOMATIC_AVAILABLE: 'Automatic attendance available',
  AUTOMATIC_PENDING_PREFLIGHT: 'Automatic attendance available',
  BROWSER_ONLY: 'Browser attendance required',
  NO_PUBLIC_STREAM: 'No public stream',
  CLOSED_SESSION: 'Closed session',
  NOT_ELIGIBLE: 'Capture not eligible',
  SCHEDULED: 'Scheduled',
  CAPTURING: 'Capturing',
  PROCESSING: 'Processing',
  COMPLETE: 'Ready',
  FAILED: 'Failed',
};

const ACTION_COPY = {
  automatic: {
    label: 'Capiro attends automatically',
    hint: 'Capiro connects to the official stream on the server and produces the canonical transcript. Nothing needs to stay open in your browser.',
  },
  browser: {
    label: 'Open browser attendance',
    hint: 'Open the official stream and share its tab audio in a private hearing room. Keep that tab and your device awake while Capiro transcribes it.',
  },
} as const;

/** The live capture lifecycle states in which the server is actively working. */
const ACTIVE_SERVER_STATES: ReadonlySet<AttendanceState> = new Set([
  'SCHEDULED',
  'CAPTURING',
  'PROCESSING',
]);

export function AttendDialog({
  hearingId,
  hearingTitle,
  onClose,
}: {
  hearingId: string;
  hearingTitle: string;
  onClose: () => void;
}) {
  const attendance = useAttendance(hearingId);
  const request = useRequestAttendance(hearingId);
  const cancel = useCancelAttendance(hearingId);
  const browserRoom = useOpenBrowserRoom(hearingId);

  const state: AttendanceAssessment | undefined = attendance.data;
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const submitInFlight = useRef(false);

  // Per-mode independent capability. The legacy availableModes array is the
  // fallback when the server predates the per-mode flags; the explicit flags
  // win when present so a mode stays offerable while the OTHER is active.
  const automaticAvailable =
    state?.automaticAvailable ?? (state?.availableModes ?? []).includes('automatic') ?? false;
  const browserAvailable =
    state?.browserAvailable ?? (state?.availableModes ?? []).includes('browser') ?? false;
  const serverActive = Boolean(state && ACTIVE_SERVER_STATES.has(state.state));
  // This tenant may ADD its own server demand even while a canonical capture
  // (possibly another workspace's) is active — the backend joins the shared
  // canonical capture, never a second recorder. The action is suppressed only
  // when THIS workspace has already scheduled (then it is "manage", not
  // "schedule"). The global canRequest veto is intentionally not used.
  const canScheduleAutomatic = automaticAvailable && !state?.scheduled;
  const busy = request.isPending || cancel.isPending || browserRoom.pending;
  // Browser capture always records a consent attestation, so the checkbox must
  // be required whenever the browser action is offered — never auto-attest an
  // unseen confirmation just because the server flagged consentRequired=false
  // for the automatic mode.
  const needsBrowserConsent = browserAvailable;

  const onScheduleServer = async () => {
    if (!canScheduleAutomatic || busy || submitInFlight.current) return;
    submitInFlight.current = true;
    setError(null);
    setConfirm(null);
    try {
      await request.mutateAsync({ mode: 'automatic', consentAcknowledged: consent });
      setConfirm(
        'Server attendance scheduled. Capiro will capture the official stream automatically — you can close this dialog. Browser attendance below stays available as a fallback.',
      );
    } catch (err) {
      // Keep the dialog open on policy, network or preflight failure.
      setError(w1Error(err));
    } finally {
      submitInFlight.current = false;
    }
  };

  const onOpenBrowser = async () => {
    if (!browserAvailable || busy || submitInFlight.current) return;
    submitInFlight.current = true;
    setError(null);
    setConfirm(null);
    try {
      const result = await browserRoom.open();
      if (result.outcome === 'blocked') {
        setError(result.message ?? 'Browser attendance could not be opened.');
      } else if (result.outcome === 'attached') {
        setConfirm(
          'Capiro is already capturing this proceeding on the server. You were attached to that shared capture instead of opening a duplicate browser room.',
        );
      }
      // 'opened' navigates to the new room; nothing to confirm here.
    } finally {
      submitInFlight.current = false;
    }
  };

  const onCancelAttendance = () => {
    setError(null);
    setConfirm(null);
    cancel.mutate(undefined, {
      onSuccess: () =>
        setConfirm(
          'Server attendance request cancelled. This only removed your workspace’s request — other workspaces and any browser room you opened are unaffected.',
        ),
      onError: (err) => setError(w1Error(err)),
    });
  };

  const canOpenBrowser = browserAvailable && (!needsBrowserConsent || consent) && !busy;
  const browserError = browserRoom.error;

  return (
    <LwModal
      kind="transcription"
      eyebrow="Have Capiro attend"
      title="Attendance & capture"
      subtitle={hearingTitle}
      note="Attending captures and transcribes this proceeding."
      primaryLabel="Done"
      onPrimary={onClose}
      onClose={onClose}
      width={600}
    >
      {attendance.isLoading ? (
        <p className="lw-card__meta">Checking capture capability…</p>
      ) : attendance.isError || !state ? (
        <p role="alert" className="lw-card__meta">
          Capture capability for this proceeding could not be determined.{' '}
          {attendance.error ? w1Error(attendance.error) : ''}
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <LwPill
              tone={
                state.state === 'CLOSED_SESSION' ||
                state.state === 'NOT_ELIGIBLE' ||
                state.state === 'FAILED' ||
                state.state === 'NO_PUBLIC_STREAM'
                  ? 'gray'
                  : 'brand'
              }
              size="22"
            >
              {ATTENDANCE_LABEL[state.state]}
            </LwPill>
            <span className="lw-card__meta lw-mono" style={{ fontSize: 11 }}>
              {state.reasonCode}
            </span>
          </div>

          {/* The server's own explanation — never a guess assembled here. */}
          <p style={{ margin: '12px 0 0', fontSize: 14 }}>{state.message}</p>

          {state.scheduled ? (
            <div
              style={{
                marginTop: 16,
                padding: '10px 12px',
                border: '1px solid var(--lw-line, #d8dbe2)',
                borderRadius: 10,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <LwPill tone={state.state === 'FAILED' ? 'gray' : 'brand'} size="22">
                  {state.state === 'CAPTURING'
                    ? 'SERVER CAPTURING'
                    : state.state === 'PROCESSING'
                      ? 'SERVER PROCESSING'
                      : state.state === 'COMPLETE'
                        ? 'SERVER CAPTURE READY'
                        : state.state === 'FAILED'
                          ? 'SERVER CAPTURE FAILED'
                          : 'SERVER ATTENDANCE SCHEDULED'}
                </LwPill>
                <button
                  type="button"
                  className="lw-btn"
                  onClick={onCancelAttendance}
                  disabled={busy}
                >
                  {cancel.isPending ? 'Cancelling…' : 'Cancel server attendance'}
                </button>
              </div>
              <p className="lw-card__meta" style={{ marginTop: 8, fontSize: 12 }}>
                {state.state === 'CAPTURING'
                  ? 'Capiro is actively capturing the official stream on the server. Cancelling removes your workspace’s request; it does not end a browser room you opened.'
                  : state.state === 'PROCESSING'
                    ? 'Capiro is processing the captured stream on the server. Cancelling removes your workspace’s request; it does not end a browser room you opened.'
                    : state.state === 'COMPLETE'
                      ? 'The server capture is complete and its transcript is ready. Cancelling only removes your workspace’s durable request; it does not delete the capture or a browser room you opened.'
                      : state.state === 'FAILED'
                        ? 'The server capture failed and is not retryable right now. Browser attendance below remains available as a fallback. Cancelling removes your workspace’s request.'
                        : 'Server attendance is scheduled but not yet capturing. Cancelling removes your workspace’s request; it does not end a browser room you opened.'}
              </p>
            </div>
          ) : null}

          {/* Two independent capture actions. Neither hides the other. */}
          <div style={{ display: 'grid', gap: 14, marginTop: 18 }}>
            {canScheduleAutomatic ? (
              <section aria-label="Server attendance">
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{ACTION_COPY.automatic.label}</div>
                    <p className="lw-card__meta" style={{ margin: '4px 0 0', fontSize: 12 }}>
                      {ACTION_COPY.automatic.hint}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="lw-btn lw-btn--primary"
                    onClick={() => void onScheduleServer()}
                    disabled={!canScheduleAutomatic || busy}
                    title={!state.canRequest ? state.message : undefined}
                  >
                    {request.isPending ? 'Scheduling…' : 'Schedule server attendance'}
                  </button>
                </div>
              </section>
            ) : null}

            {browserAvailable ? (
              <section aria-label="Browser attendance">
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{ACTION_COPY.browser.label}</div>
                    <p className="lw-card__meta" style={{ margin: '4px 0 0', fontSize: 12 }}>
                      {ACTION_COPY.browser.hint}
                      {serverActive && state.state === 'CAPTURING'
                        ? ' Server capture is already running — this stays available as a fallback.'
                        : serverActive
                          ? ' Server capture is scheduled — this stays available as a fallback.'
                          : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="lw-btn"
                    onClick={() => void onOpenBrowser()}
                    disabled={!canOpenBrowser}
                    title={
                      needsBrowserConsent && !consent
                        ? 'Consent is required to open browser attendance.'
                        : undefined
                    }
                  >
                    {browserRoom.pending ? 'Opening…' : 'Open browser attendance'}
                  </button>
                </div>
                {needsBrowserConsent ? (
                  <label
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                      marginTop: 10,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span style={{ fontSize: 13 }}>
                      I confirm this proceeding is public and that recording it through my browser
                      is permitted.
                    </span>
                  </label>
                ) : null}
              </section>
            ) : null}

            {!canScheduleAutomatic && !browserAvailable && !state.scheduled ? (
              <p className="lw-card__meta" style={{ margin: 0 }}>
                There is no attendance option for this proceeding.
              </p>
            ) : null}
          </div>

          {confirm ? (
            <p role="status" className="lw-card__meta" style={{ marginTop: 12 }}>
              {confirm}
            </p>
          ) : null}
          {error || browserError ? (
            <p
              role="alert"
              className="lw-card__meta"
              style={{ marginTop: 12, color: 'var(--lw-danger, #b42318)' }}
            >
              {error ?? browserError}
            </p>
          ) : null}
        </>
      )}
    </LwModal>
  );
}
