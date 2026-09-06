/**
 * LegiWatch V2 Wave 1 (W1-2) — the Attend dialog.
 *
 * DISTINCT from Follow. This dialog asks Capiro to capture and transcribe a
 * proceeding, so it is about capture capability, consent and scheduling — never
 * about notifications.
 *
 * Every state shown here comes from the server's own attendance assessment, the
 * same derivation the server enforces on the way in. The dialog therefore
 * cannot offer a mode the server would refuse, and it never renders "Attend
 * live" or automatic capture for a closed, private, classified or executive
 * session.
 */
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateHearing } from '../../../../lib/hearing-watch-api.js';
import { usePhase7BrowserJoin } from '../../../../pages/radar/live-hearings/live-hearings-phase7-api.js';
import { LwModal } from '../overlays/LwModal.js';
import { LwPill } from '../lib/primitives.js';
import {
  useAttendance,
  useCancelAttendance,
  useRequestAttendance,
  w1Error,
  type AttendanceAssessment,
  type AttendanceState,
} from '../lib/wave1-api.js';

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

const MODE_COPY: Record<
  'automatic' | 'browser',
  { label: string; hint: string }
> = {
  automatic: {
    label: 'Capiro attends automatically',
    hint: 'Capiro connects to the official stream and produces the canonical transcript. Nothing is required from you.',
  },
  browser: {
    label: 'Browser attendance',
    hint: 'Open the official stream and start sharing its tab audio in the hearing room. Keep your browser and the stream open while Capiro transcribes it.',
  },
};

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
  const browserJoin = usePhase7BrowserJoin();
  const createBrowserSession = useCreateHearing();
  const navigate = useNavigate();

  const state: AttendanceAssessment | undefined = attendance.data;
  const modes = state?.availableModes ?? [];
  const [mode, setMode] = useState<'automatic' | 'browser' | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitInFlight = useRef(false);

  const effectiveMode = mode && modes.includes(mode) ? mode : modes[0] ?? null;
  const busy = request.isPending || cancel.isPending || browserJoin.isPending || createBrowserSession.isPending;
  const needsConsent = effectiveMode === 'browser' || Boolean(state?.consentRequired);

  const onSubmit = async () => {
    if (!effectiveMode || !state?.canRequest || busy || submitInFlight.current || (needsConsent && !consent)) return;
    submitInFlight.current = true;
    setError(null);
    try {
      await request.mutateAsync({ mode: effectiveMode, consentAcknowledged: consent });
      if (effectiveMode === 'browser') {
        // Recording intent alone does not create a browser session. Reuse the
        // shipped canonical join guard so a server capture that started while
        // this dialog was open attaches to the shared transcript instead.
        const plan = await browserJoin.mutateAsync(hearingId);
        if (plan.mode === 'BLOCKED') throw new Error(plan.message);
        if (plan.mode === 'BROWSER_CAPTURE') {
          const session = await createBrowserSession.mutateAsync({
            title: plan.title,
            sourceType: plan.sourceType,
            audioSource: plan.audioSource,
            recordingPolicy: plan.recordingPolicy,
            sourceUrl: plan.sourceUrl,
            hearingId: plan.hearingId,
            committeeId: plan.committeeId,
            consentAttestation: 'I confirm this proceeding is public and recording it through my browser is permitted.',
          });
          if (!session?.id) throw new Error('The browser hearing room could not be created. Please retry.');
          navigate(`/intelligence/hearing-watch/${encodeURIComponent(session.id)}`);
        }
      }
      onClose();
    } catch (err) {
      // Keep the modal open on policy, network or room-creation failure.
      setError(w1Error(err));
    } finally {
      submitInFlight.current = false;
    }
  };

  const onCancelAttendance = () => {
    setError(null);
    cancel.mutate(undefined, {
      onSuccess: () => onClose(),
      onError: (err) => setError(w1Error(err)),
    });
  };

  const canSubmit =
    Boolean(state?.canRequest) &&
    Boolean(effectiveMode) &&
    (!needsConsent || consent) &&
    !busy;

  return (
    <LwModal
      kind="transcription"
      eyebrow="Have Capiro attend"
      title="Attendance & capture"
      subtitle={hearingTitle}
      note="Attending captures and transcribes this proceeding."
      primaryLabel={busy ? 'Working…' : state?.scheduled ? 'Scheduled' : effectiveMode === 'browser' ? 'Open browser attendance' : 'Schedule attendance'}
      onPrimary={() => void onSubmit()}
      primaryDisabled={!canSubmit}
      primaryTitle={
        state && !state.canRequest ? state.message : !consent && needsConsent ? 'Consent is required for this attendance mode.' : undefined
      }
      onClose={onClose}
      width={560}
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
            <div style={{ marginTop: 18 }}>
              <button type="button" className="lw-btn" onClick={onCancelAttendance} disabled={busy}>
                {cancel.isPending ? 'Cancelling…' : 'Cancel attendance'}
              </button>
              <p className="lw-card__meta" style={{ marginTop: 8, fontSize: 12 }}>
                Cancelling removes your workspace’s request. Other workspaces attending this
                proceeding are unaffected.
              </p>
            </div>
          ) : modes.length === 0 ? (
            // No affordance at all — this is the closed / ineligible path.
            <p className="lw-card__meta" style={{ marginTop: 14 }}>
              There is no attendance option for this proceeding.
            </p>
          ) : (
            <>
              <fieldset style={{ border: 0, margin: '18px 0 0', padding: 0 }}>
                <legend className="lw-eyebrow" style={{ marginBottom: 8 }}>
                  How Capiro attends
                </legend>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {modes.map((m) => (
                    <li key={m}>
                      <label
                        style={{
                          display: 'flex',
                          gap: 8,
                          alignItems: 'flex-start',
                          padding: '6px 0',
                        }}
                      >
                        <input
                          type="radio"
                          name="lw-attend-mode"
                          checked={effectiveMode === m}
                          onChange={() => setMode(m)}
                        />
                        <span>
                          <span style={{ display: 'block' }}>{MODE_COPY[m].label}</span>
                          <span className="lw-card__meta" style={{ fontSize: 12 }}>
                            {MODE_COPY[m].hint}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>

              {needsConsent ? (
                <label
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    marginTop: 14,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  <span style={{ fontSize: 13 }}>
                    I confirm this proceeding is public and that recording it through my browser is
                    permitted.
                  </span>
                </label>
              ) : null}
            </>
          )}

          {error ? (
            <p
              role="alert"
              className="lw-card__meta"
              style={{ marginTop: 12, color: 'var(--lw-danger, #b42318)' }}
            >
              {error}
            </p>
          ) : null}
        </>
      )}
    </LwModal>
  );
}
