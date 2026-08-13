/**
 * Transcription setup modal (§7.13, A.10). Names the proceeding, then a mode
 * switch — Unattended recording (default) or Attend live — then the resolved
 * capability, then the selectable capture paths, then consent.
 *
 * Honest capability (§1.10): under Unattended the modal states the job
 * contract and browser capture is offered but DISABLED with the reason (it
 * needs an open tab — unattended runs only on a `direct` stream). Because
 * there is no server capture-job queue (GAPS LW-G2), the Unattended primary
 * action is itself disabled with the reason named; Attend live (browser-tab
 * capture) is the honest path that can actually succeed.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useCreateHearing,
  type UpcomingHearing,
  type useResolveStream,
} from '../../../../lib/hearing-watch-api.js';
import type { HearingCapability } from '../lib/types.js';
import { LwModal } from './LwModal.js';
import { LwPill, LwSeg } from '../lib/primitives.js';

type Mode = 'unattended' | 'attend';
type CapturePath = 'direct' | 'browser' | 'upload';

export function TranscriptionSetupModal({
  hearing,
  capability,
  resolveStream,
  onClose,
}: {
  hearing: UpcomingHearing;
  capability: HearingCapability;
  resolveStream: ReturnType<typeof useResolveStream>;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const create = useCreateHearing();
  const [mode, setMode] = useState<Mode>('unattended');
  const [path, setPath] = useState<CapturePath>(capability === 'direct' ? 'direct' : 'browser');
  const [consent, setConsent] = useState(false);

  const when = useMemo(() => {
    const d = new Date(hearing.scheduledAt);
    return `${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} ET`;
  }, [hearing.scheduledAt]);

  // The primary action follows the mode. Unattended has no backend queue
  // (LW-G2) → disabled with the reason. Attend live starts browser capture.
  const primaryLabel = mode === 'unattended' ? 'Schedule recording' : 'Start capture';
  const primaryDisabled =
    !consent ||
    create.isPending ||
    (mode === 'unattended') || // LW-G2 — no capture-job queue
    (mode === 'attend' && capability === 'unavailable');
  const primaryTitle =
    mode === 'unattended'
      ? 'Unattended recording is not available on this backend yet (no capture-job queue).'
      : capability === 'unavailable'
        ? 'No recordable source is available for this proceeding.'
        : !consent
          ? 'Confirm consent to record and transcribe.'
          : undefined;

  const start = async () => {
    if (mode !== 'attend') return;
    const session = await create.mutateAsync({
      title: hearing.title,
      sourceType: 'committee',
      audioSource: 'browser_tab',
      recordingPolicy: 'record_and_transcribe',
      sourceUrl: hearing.url ?? undefined,
      consentAttestation: 'user_confirmed',
      hearingId: hearing.id,
      committeeId: hearing.committee ?? undefined,
    });
    onClose();
    navigate(`/intelligence/hearing-watch/${session.id}`);
  };

  return (
    <LwModal
      kind="transcription"
      eyebrow="Hearing capture"
      title="Set up transcription"
      subtitle="Stream capability is resolved before setup, so every path offered here can actually succeed."
      note="Capability is resolved at setup; a queued recording is one that can actually run."
      primaryLabel={primaryLabel}
      onPrimary={() => void start()}
      primaryDisabled={primaryDisabled}
      primaryTitle={primaryTitle}
      onClose={onClose}
    >
      {/* 1. proceeding */}
      <div className="lw-block">
        <div className="lw-block__label">Proceeding</div>
        <div className="lw-block__title">{hearing.title}</div>
        <div className="lw-block__when">{hearing.committee} · {when}</div>
      </div>

      {/* 2. mode switch */}
      <LwSeg
        ariaLabel="Capture mode"
        options={[
          { id: 'unattended' as Mode, label: 'Unattended recording' },
          { id: 'attend' as Mode, label: 'Attend live' },
        ]}
        value={mode}
        onChange={setMode}
      />

      {/* 3. capability */}
      <div className="lw-block lw-block--ring">
        <div className="lw-block__label">Resolved capability</div>
        <div className="lw-block__head" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {capability === 'unavailable' ? 'No recordable source' : capability === 'pending' ? 'Resolving…' : 'Stream available'}
          <LwPill tone={capability === 'unavailable' ? 'gray' : capability === 'pending' ? 'warning' : 'success'} size="26">
            {capability === 'direct' || capability === 'browser' ? 'AVAILABLE' : capability.toUpperCase()}
          </LwPill>
        </div>
        <div className="lw-block__body">
          {capability === 'direct'
            ? 'An official committee stream was resolved; Capiro can capture it directly.'
            : capability === 'browser'
              ? 'No direct stream — capture runs from an open browser tab playing the committee page.'
              : capability === 'pending'
                ? 'Capability is still being resolved. Setup is offered once it resolves.'
                : 'No recordable source could be resolved for this proceeding. You can upload a recording instead.'}
        </div>
      </div>

      {/* 4. capture paths */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <CaptureOption
          title="Direct stream capture"
          desc="Capiro connects to the official stream and records server-side."
          tag="DIRECT"
          selected={path === 'direct'}
          disabled={capability !== 'direct'}
          onSelect={() => setPath('direct')}
        />
        <CaptureOption
          title="Browser tab capture"
          desc="Capture runs from an open browser tab playing the proceeding."
          tag="TAB REQUIRED"
          selected={path === 'browser'}
          disabled={mode === 'unattended' || capability === 'unavailable'}
          disabledReason={mode === 'unattended' ? 'Browser capture cannot run unattended — it needs an open tab.' : undefined}
          onSelect={() => setPath('browser')}
        />
        <CaptureOption
          title="Upload a recording"
          desc="Provide your own audio or video file to transcribe after the fact."
          tag="MANUAL"
          selected={path === 'upload'}
          disabled={false}
          onSelect={() => setPath('upload')}
        />
      </div>

      {/* 5. unattended job contract */}
      {mode === 'unattended' ? (
        <div className="lw-block lw-block--ink lw-on-ink">
          <div className="lw-block__label">Unattended schedule</div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
            <Kv k="STARTS" v={`Five minutes before the gavel — ${when}`} />
            <Kv k="STOPS" v="At adjournment, or 30 minutes after the noticed end time" />
            <Kv k="DELIVERS" v="Transcript, matched moments and client impact into My Sessions" />
            <Kv k="NOTIFIES" v="You · in-app and email when the recap is ready" />
          </div>
          <div className="lw-block__body" style={{ marginTop: 12 }}>
            Unattended recording is queued against the official stream. It is not available on this
            backend yet (no capture-job queue) — attend live to capture now.
          </div>
        </div>
      ) : null}

      {/* 6. consent */}
      <label className="lw-block lw-block--ring lw-check" style={{ display: 'flex', gap: 12, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          <span className="lw-block__label">Consent</span>
          <span className="lw-block__body" style={{ display: 'block' }}>
            I confirm we are authorized to record and transcribe this proceeding, and that capture
            complies with the committee's terms and applicable law.
          </span>
        </span>
      </label>
    </LwModal>
  );
}

function CaptureOption({
  title,
  desc,
  tag,
  selected,
  disabled,
  disabledReason,
  onSelect,
}: {
  title: string;
  desc: string;
  tag: string;
  selected: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`lw-radio${selected ? ' is-selected' : ''}`}
      disabled={disabled}
      onClick={onSelect}
      title={disabled ? disabledReason ?? 'Not available for this proceeding.' : undefined}
      aria-pressed={selected}
    >
      <span className="lw-radio__ring" aria-hidden="true">
        {selected ? <span className="lw-radio__fill" /> : null}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="lw-radio__title">{title}</span>
        <span className="lw-radio__desc" style={{ display: 'block' }}>
          {desc}
          {disabled && disabledReason ? ` ${disabledReason}` : ''}
        </span>
      </span>
      <span className="lw-radio__tag lw-pill lw-pill--gray lw-pill--26">{tag}</span>
    </button>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="lw-kvrow">
      <span className="lw-kvrow__k">{k}</span>
      <span className="lw-kvrow__v">{v}</span>
    </div>
  );
}
