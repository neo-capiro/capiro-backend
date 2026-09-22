/**
 * Canonical hearing detail route — `/legiwatch/hearings/:hearingId` (PR B,
 * LW-QA-003/004). The vNext module previously offered NO detail path: calendar
 * chips opened only a capture-setup modal, list/history rows were inert, and
 * completed hearings were unreachable.
 *
 * This route composes the SAME canonical contracts the legacy surface uses —
 * canonical event, transcript, intelligence — with the shared date/time
 * contract (LW-QA-001) and the closed-session capability model (LW-QA-002).
 * Global transcript/intelligence data render bare; tenant relevance renders
 * only the calling user's subscription state (never another tenant's).
 *
 * Every outcome state is honest (§8): not-occurred / no-public-stream /
 * capture-not-requested / capture-failed / processing / no-intelligence.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  useCanonicalHearingEvent,
  usePublicHearingTranscript,
  useHearingIntelligence,
  type PublicTranscriptSegment,
  type HearingIntelligenceItem,
} from '../lib/canonical-hearings.js';
import {
  formatHearingDay,
  formatHearingTime,
  momentOfCanonicalEvent,
} from '../lib/hearing-datetime.js';
import {
  accessPillLabel,
  isClosedSession,
  speakerDisplay,
  transcriptAvailability,
} from '../lib/hearing-detail-states.js';
import { LwPill, LwButton, LwSkeleton } from '../lib/primitives.js';
import { OfficialHearingLinks } from './OfficialHearingLinks.js';
import { LwStateUnavailable } from '../states/SystemStates.js';
// Wave 1 surfaces. Each owns one workstream and reads a real Wave 1 endpoint.
import { FollowDialog } from './FollowDialog.js';
import { AttendDialog, ATTENDANCE_LABEL } from './AttendDialog.js';
import { ClientRelevancePanel } from './ClientRelevancePanel.js';
import { HearingActions, type ActionRefs } from './HearingActions.js';
import { SavedHearingSessions } from './SavedHearingSessions.js';
import { SpeakerName } from './SpeakerName.js';
import {
  useAttendance,
  useFollowConfig,
  useHearingUpdates,
  useRenameSpeaker,
} from '../lib/wave1-api.js';
import { useHearingWakeLock } from '../../../../lib/use-hearing-wake-lock.js';
import { PreparationPanel } from './PreparationPanel.js';
import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';
import { PublicHearingAudioPanel } from '../../../../pages/intelligence/PublicHearingAudioPanel.js';
import { PublicHearingReviewPanel } from '../../../../pages/intelligence/PublicHearingReviewPanel.js';
import { HearingPublishedRecordsPanel } from '../../../../pages/intelligence/HearingPublishedRecordsPanel.js';

const INTEL_LABEL: Record<string, string> = {
  QUESTION: 'Question',
  COMMITMENT: 'Commitment',
  DEADLINE: 'Deadline',
  FUNDING_AMOUNT: 'Funding',
  BILL_REFERENCE: 'Bill',
  PROGRAM_ELEMENT_REFERENCE: 'Program element',
  AGENCY_REFERENCE: 'Agency',
  POLICY_POSITION: 'Position',
  KEY_QUOTE: 'Quote',
  MENTION: 'Mention',
};

const DETAIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'live-capture', label: 'Live & Capture' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'client-relevance', label: 'Client Relevance' },
  { id: 'sources-documents', label: 'Sources & Documents' },
] as const;

type DetailTabId = (typeof DETAIL_TABS)[number]['id'];

function msToClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function HearingDetailRoute() {
  const { hearingId = '' } = useParams<{ hearingId: string }>();
  const navigate = useNavigate();
  const { hash, state: navigationState } = useLocation();
  const goBack = () => {
    const target = navigationState?.legiwatchReturnTo;
    navigate(
      typeof target === 'string' && /^\/(?:legiwatch(?:[/?#]|$)|bills\/|directory\/state-committees\/)/.test(target)
        ? target
        : '/legiwatch?tab=hearings',
      { state: { legiwatchScrollY: navigationState?.legiwatchScrollY } },
    );
  };
  const [searchParams, setSearchParams] = useSearchParams();
  const event = useCanonicalHearingEvent(hearingId);
  const transcript = usePublicHearingTranscript(hearingId);
  const intelligence = useHearingIntelligence(hearingId);
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [segmentToReveal, setSegmentToReveal] = useState<string | null>(null);
  const retainedAudio = useIntelFeatureEnabled('legiwatch_hearing_recording_v1');
  const [audioSeek, setAudioSeek] = useState<{ positionMs: number; request: number }>();
  const lastHashJump = useRef('');
  const captureStatus = event.data?.capture?.status?.toUpperCase();
  useHearingWakeLock(
    ['LIVE', 'IN_PROGRESS'].includes(event.data?.eventStatus?.toUpperCase() ?? '') ||
      ['PREPARING', 'RECORDING', 'CAPTURING', 'RECOVERING'].includes(captureStatus ?? ''),
  );

  // Wave 1 tenant state. Both are read here so the header controls show the
  // real persisted state rather than a local guess.
  const follow = useFollowConfig(hearingId);
  const attendance = useAttendance(hearingId);
  const renameSpeaker = useRenameSpeaker(hearingId);
  const [dialog, setDialog] = useState<'follow' | 'attend' | null>(null);
  const [pendingAction, setPendingAction] = useState<{ action: string; refs: ActionRefs } | null>(
    null,
  );

  // The client lens lives in the URL so it persists across navigation and can
  // be shared. It changes the tenant ANALYSIS only, never the public record.
  // `state` is forwarded on every search-param write so the location state
  // that carries the Back target (legiwatchReturnTo / legiwatchScrollY)
  // survives tab and client-lens changes — setSearchParams without it drops
  // the state and Back falls all the way out to the default hearings tab.
  const clientId = searchParams.get('client') ?? '';
  const setClientId = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams);
      if (next) params.set('client', next);
      else params.delete('client');
      setSearchParams(params, { replace: true, state: navigationState });
    },
    [searchParams, setSearchParams, navigationState],
  );

  // Active detail tab — URL-driven so deep links and back/forward work. The
  // query string is user-controlled: an unknown value must fall back to
  // Overview, never cast into a tab id that leaves every panel blank.
  const requestedTab = searchParams.get('detailTab');
  const activeTab: DetailTabId = DETAIL_TABS.some((tab) => tab.id === requestedTab)
    ? (requestedTab as DetailTabId)
    : 'overview';
  const setActiveTab = useCallback(
    (tab: DetailTabId) => {
      // Functional updater keeps this callback's identity stable across the
      // search-param writes it performs — the #public-audio reveal effect
      // depends on it and must not re-run (and cancel its pending scroll)
      // just because the URL changed.
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (tab === 'overview') params.delete('detailTab');
          else params.set('detailTab', tab);
          return params;
        },
        { replace: true, state: navigationState },
      );
    },
    [setSearchParams, navigationState],
  );

  // Shared evidence-playback entry point: a seek request AND the Live &
  // Capture tab reveal, so the existing player instance is on screen when the
  // seek lands. Every "Play audio" control (transcript rows, review
  // publication evidence) goes through this one callback.
  const playEvidence = useCallback(
    (positionMs: number) => {
      setAudioSeek((previous) => ({ positionMs, request: (previous?.request ?? 0) + 1 }));
      setActiveTab('live-capture');
    },
    [setActiveTab],
  );

  const segments = useMemo(
    () => transcript.data?.pages.flatMap((p) => p.items) ?? [],
    [transcript.data],
  );

  const visibleSegments = useMemo(() => {
    const q = transcriptQuery.trim().toLowerCase();
    if (!q) return segments;
    return segments.filter(
      (s: PublicTranscriptSegment) =>
        s.text.toLowerCase().includes(q) || (speakerDisplay(s) ?? '').toLowerCase().includes(q),
    );
  }, [segments, transcriptQuery]);

  // §9 click-to-jump, hoisted above the early returns: a hook must run on every
  // render, and the loading/error branches below return early.
  const jumpToSegment = useCallback((segmentId: string | undefined) => {
    if (!segmentId) return;
    setTranscriptQuery('');
    setSegmentToReveal(segmentId);
    setActiveTab('transcript');
  }, [setActiveTab]);

  // W1-3: an archive transcript hit deep-links here as `#seg-<segmentId>`.
  // The jump waits for the transcript page containing the segment to land —
  // scrolling before it renders would silently do nothing.
  useEffect(() => {
    const target = `${hearingId}${hash}`;
    if (!hash.startsWith('#seg-')) {
      lastHashJump.current = '';
      return;
    }
    if (lastHashJump.current === target) return;
    let segmentId: string;
    try {
      segmentId = decodeURIComponent(hash.slice('#seg-'.length));
    } catch {
      return; // A malformed incoming fragment must not crash the entire room.
    }
    if (!segmentId || !segments.some((seg) => seg.id === segmentId)) return;
    lastHashJump.current = target;
    jumpToSegment(segmentId);
  }, [hearingId, hash, segments, jumpToSegment]);

  // Incoming `#public-audio` deep link: reveal the Live & Capture tab (where
  // the retained-audio player lives), then scroll to the player once it is
  // actually rendered. The reveal is PENDING until the anchor exists: on a
  // cold load the event query has not resolved yet (the early loading return
  // above means no panel — and no anchor — is in the DOM), and the tab write
  // itself drops the fragment from the URL (useSearchParams does not carry
  // the hash). So the target is consumed from the hash once, then every
  // render re-checks for the anchor until the scroll lands. A later manual
  // tab switch is NOT overridden — this effect never writes the tab again
  // after the first reveal.
  const audioReveal = useRef<{ target: string; revealed: boolean; scrolled: boolean }>({
    target: '',
    revealed: false,
    scrolled: false,
  });
  useEffect(() => {
    if (hash === '#public-audio') {
      const target = `${hearingId}${hash}`;
      if (audioReveal.current.target !== target) {
        audioReveal.current = { target, revealed: false, scrolled: false };
      }
    } else if (audioReveal.current.scrolled || !audioReveal.current.target) {
      // Fully done (or nothing pending) — reset so a FUTURE #public-audio
      // navigation on the same page reveals again.
      audioReveal.current = { target: '', revealed: false, scrolled: false };
    }
    const pending = audioReveal.current;
    if (!pending.target) return;
    if (!pending.revealed) {
      pending.revealed = true;
      setActiveTab('live-capture');
      return; // the tab write re-renders; the scroll attempt happens below it
    }
    if (pending.scrolled) return;
    const anchor = document.getElementById('public-audio');
    if (!anchor) return; // event still loading — try again on the next render
    pending.scrolled = true;
    anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Deliberately NOT depending on activeTab: the reveal fires once when the
    // fragment arrives, not on every tab the user picks afterwards.
  });

  useEffect(() => {
    if (!segmentToReveal) return;
    const el = document.getElementById(`lw-seg-${segmentToReveal}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.background = 'color-mix(in srgb, var(--lw-brand-dot) 12%, transparent)';
    const timeout = window.setTimeout(() => {
      el.style.background = '';
      setSegmentToReveal(null);
    }, 2200);
    return () => {
      window.clearTimeout(timeout);
      el.style.background = '';
    };
  }, [segmentToReveal, visibleSegments]);

  if (event.isLoading) {
    return (
      <div className="lw-body">
        <div className="lw-card" style={{ padding: 18 }}>
          <LwSkeleton height={40} />
          <div style={{ height: 12 }} />
          <LwSkeleton height={160} delay={2} />
          <div style={{ height: 12 }} />
          <LwSkeleton height={120} delay={3} />
        </div>
      </div>
    );
  }

  if (event.isError || !event.data) {
    return (
      <div className="lw-body">
        <LwStateUnavailable
          source="Hearing detail"
          reason="This proceeding could not be loaded from the canonical calendar."
          onRetry={() => void event.refetch()}
        />
        <div style={{ marginTop: 12 }}>
          <LwButton onClick={goBack}>← Back to LegiWatch</LwButton>
        </div>
      </div>
    );
  }

  const e = event.data;
  const moment = momentOfCanonicalEvent(e);
  // LW-QA-002: only VERIFIED closed/private is a closed session. UNKNOWN is
  // unverified — capture fails closed, but the product never claims closed.
  const closed = isClosedSession(e.publicAccessStatus);
  const accessLabel = accessPillLabel(e.publicAccessStatus);
  const availability = transcriptAvailability(e);
  const intel = intelligence.data ?? [];
  // §8: extraction pending must never render as "no intelligence extracted".
  // The route's status arrives on the envelope (useHearingIntelligence).
  const intelProcessing =
    intelligence.data?.status === 'PROCESSING' ||
    intelligence.data?.status === 'DEGRADED' ||
    (intelligence.data?.jobs?.public?.pending ?? 0) +
      (intelligence.data?.jobs?.tenant?.pending ?? 0) >
      0;
  const committeeCode = e.subcommittee?.systemCode ?? e.committee?.systemCode ?? null;
  const committeeTarget = e.stateCommitteeId
    ? `/directory/state-committees/${encodeURIComponent(e.stateCommitteeId)}`
    : committeeCode
      ? `/legiwatch/committees/${encodeURIComponent(committeeCode)}`
      : null;

  return (
    <div className="lw-body lw-detail" aria-label={`Hearing detail: ${e.title}`}>
      <button type="button" className="lw-backlink" onClick={goBack}>
        ← Back to LegiWatch
      </button>

      {/* White title band — reference hearing-overview.png */}
      <div className="lw-detail__head">
        <div className="lw-detail__pills">
          <LwPill tone={closed ? 'gray' : accessLabel === 'PUBLIC' ? 'brand' : 'gray'} size="22">
            {accessLabel}
          </LwPill>
          <LwPill tone="gray" size="22">
            {(e.eventStatus ?? '').toUpperCase()}
          </LwPill>
          {e.capture ? (
            <LwPill tone="gray" size="22">
              CAPTURE {e.capture.status.toUpperCase()}
            </LwPill>
          ) : null}
        </div>
        <h1 className="lw-detail__title">{e.title}</h1>
        <div className="lw-detail__when">
          {formatHearingDay(moment)} · {formatHearingTime(moment)}
        </div>
      </div>

      {/* 42px tab strip — reference hearing-overview.png. Panels below stay
          mounted and are hidden with the `hidden` attribute so player
          position, review drafts, folder selections and transcript filters
          survive a tab switch; `hidden` (display:none) also keeps inactive
          panels out of the accessibility tree. */}
      <div className="lw-detail__tabs" role="tablist" aria-label="Hearing detail sections">
        {DETAIL_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`lw-detail-panel-${tab.id}`}
            id={`lw-detail-tab-${tab.id}`}
            className={`lw-detail__tab${activeTab === tab.id ? ' is-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Overview tab ── */}
      <div
        className="lw-detail__overview"
        role="tabpanel"
        id="lw-detail-panel-overview"
        aria-label="Overview panel"
        hidden={activeTab !== 'overview'}
        style={activeTab !== 'overview' ? { display: 'none' } : undefined}
      >
          <div className="lw-detail__main">
            {/* Facts card */}
            <section className="lw-card lw-detail__card" aria-label="Hearing facts">
              <h2 className="lw-detail__section-title">Details</h2>
              <dl className="lw-detail__facts">
                <dt>Committee</dt>
                <dd>
                  {committeeTarget ? (
                    <button
                      type="button"
                      className="lw-backlink"
                      style={{ padding: 0 }}
                      onClick={() => navigate(committeeTarget)}
                    >
                      {e.subcommittee?.name ?? e.committee?.name ?? '—'}
                    </button>
                  ) : (
                    (e.committee?.name ?? '—')
                  )}
                </dd>
                <dt>Chamber</dt>
                <dd>{e.chamber ?? '—'}</dd>
                <dt>Location</dt>
                <dd>{e.location ?? '—'}</dd>
                <OfficialHearingLinks
                  officialPageUrl={e.officialPageUrl}
                  officialPlaybackUrl={e.officialPlaybackUrl}
                  officialPlaybackKind={e.officialPlaybackKind}
                  eventStatus={e.eventStatus}
                />
                <dt>Stream status</dt>
                <dd>{e.streamState ?? 'NOT_CHECKED'}</dd>
                <dt>Witnesses</dt>
                <dd>
                  {e.witnesses?.length ? e.witnesses.map((w) => w.name).join(', ') : 'None listed'}
                </dd>
              </dl>
            </section>

            {/* Linked legislation */}
            {e.agenda?.some((item) => item.bill) ? (
              <section className="lw-card lw-detail__card" aria-label="Research linked legislation">
                <h2 className="lw-detail__section-title">Research linked legislation</h2>
                {e.agenda
                  .filter((item) => item.bill)
                  .map((item) => (
                    <LwButton
                      key={item.key}
                      onClick={() => {
                        const query = new URLSearchParams(searchParams);
                        query.set('tab', 'research');
                        query.set('researchView', 'bills');
                        query.set('jurisdiction', item.bill!.jurisdiction);
                        query.set('session', item.bill!.session);
                        query.set('bill', item.bill!.id);
                        navigate('/legiwatch?' + query);
                      }}
                    >
                      {item.title} · Research source versions
                    </LwButton>
                  ))}
              </section>
            ) : null}

            {/* Preparation */}
            <PreparationPanel
              event={e}
              clientId={clientId || undefined}
              folderId={searchParams.get('folder') ?? undefined}
            />
          </div>

          <div className="lw-detail__sidebar">
            {/* Use the resolved event ID so the saved-session response matches
                the hook's identity check when this URL contains an alias. */}
            <SavedHearingSessions hearingId={e.id} />
          </div>
      </div>

      {/* ── Live & Capture tab ── */}
      <div
        className="lw-detail__tabpanel"
        role="tabpanel"
        id="lw-detail-panel-live-capture"
        aria-label="Live and capture panel"
        hidden={activeTab !== 'live-capture'}
        style={activeTab !== 'live-capture' ? { display: 'none' } : undefined}
      >
          <section className="lw-card lw-detail__card" aria-label="Live and capture">
            <div className="lw-card__head">
              <h2 className="lw-card__title">Live & Capture</h2>
              {closed ? (
                <span className="lw-card__meta">Closed session — no public stream</span>
              ) : accessLabel === 'ACCESS UNVERIFIED' ? (
                <span className="lw-card__meta">
                  Public access unverified — capture unavailable until confirmed.
                </span>
              ) : e.capture ? (
                <span className="lw-card__meta">
                  {e.capture.status}
                  {e.capture.failureReason ? ` · ${e.capture.failureReason}` : ''}
                  {e.capture.gapSeconds ? ` · ${Math.round(e.capture.gapSeconds / 60)} min gaps` : ''}
                </span>
              ) : (
                <span className="lw-card__meta">No automatic capture requested</span>
              )}
            </div>
            {/* W1-1 / W1-2. Follow and Attend are DIFFERENT products and are two
                separate controls: following notifies, attending captures. The
                Attend control renders only when the server says a mode is actually
                available, so a closed session has no attendance affordance at all. */}
            <p className="lw-card__meta" style={{ marginTop: 10, fontSize: 12 }}>
              Follow sends updates about this hearing. Record hearing asks Capiro to capture and
              transcribe it; these are separate actions.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              <LwButton
                variant={follow.data?.following ? undefined : 'primary'}
                onClick={() => setDialog('follow')}
              >
                {follow.data?.following ? 'Edit follow' : 'Follow'}
              </LwButton>

              {attendance.data?.scheduled ? (
                <LwButton onClick={() => setDialog('attend')}>Scheduled · manage</LwButton>
              ) : attendance.data &&
                // Per-mode independent capability: a mode stays offerable while
                // the OTHER is active, so the entrypoint reads the explicit
                // flags (with the legacy aggregate as fallback), never the
                // global canRequest veto that hides browser replay on a
                // completed/in-progress public proceeding.
                ((attendance.data.automaticAvailable ?? attendance.data.canRequest) ||
                  (attendance.data.browserAvailable ??
                    (attendance.data.availableModes ?? []).includes('browser'))) ? (
                <LwButton variant="primary" onClick={() => setDialog('attend')}>
                  Record hearing
                </LwButton>
              ) : attendance.data ? (
                // No control, but the state is still stated rather than hidden.
                <span className="lw-card__meta" style={{ alignSelf: 'center' }}>
                  {ATTENDANCE_LABEL[attendance.data.state]} — {attendance.data.message}
                </span>
              ) : attendance.isLoading ? (
                <span className="lw-card__meta" style={{ alignSelf: 'center' }}>
                  Checking capture capability…
                </span>
              ) : (
                <span role="alert" className="lw-card__meta" style={{ alignSelf: 'center' }}>
                  Capture capability could not be determined for this proceeding.
                </span>
              )}
            </div>

            {follow.data?.following ? (
              <p className="lw-card__meta" style={{ marginTop: 8, fontSize: 12 }}>
                Following for{' '}
                {follow.data.clients.length
                  ? follow.data.clients.map((c) => c.name ?? c.id).join(', ')
                  : 'no clients yet'}
                . Following does not request attendance.
              </p>
            ) : null}
          </section>

          <HearingPublishedRecordsPanel eventId={hearingId} clientId={clientId || undefined} />
          {retainedAudio && !closed ? (
            // `public-audio` is the incoming deep-link anchor; the wrapper owns
            // the id so the player itself needs no modification.
            <div id="public-audio">
              <PublicHearingAudioPanel hearingId={hearingId} seek={audioSeek} />
            </div>
          ) : null}
          {!closed ? (
            <PublicHearingReviewPanel
              hearingId={hearingId}
              clientId={clientId || undefined}
              playEvidence={playEvidence}
            />
          ) : null}
      </div>

      {/* ── Transcript tab ── */}
      <div
        className="lw-detail__tabpanel"
        role="tabpanel"
        id="lw-detail-panel-transcript"
        aria-label="Transcript panel"
        hidden={activeTab !== 'transcript'}
        style={activeTab !== 'transcript' ? { display: 'none' } : undefined}
      >
          <section className="lw-card lw-detail__card" aria-label="Transcript">
            <div className="lw-card__head">
              <h2 className="lw-card__title">Transcript</h2>
              <span className="lw-card__meta">{segments.length} segments from automatic capture</span>
            </div>
            {!availability.available ? (
              <p style={{ color: 'var(--lw-meta)', fontSize: 13 }}>{availability.note}</p>
            ) : (
              <>
                <div className="lw-search" style={{ margin: '8px 0 12px' }}>
                  <span aria-hidden="true" style={{ color: 'var(--lw-meta)' }}>
                    ⌕
                  </span>
                  <input
                    aria-label="Search transcript"
                    placeholder="Search transcript text or speaker"
                    value={transcriptQuery}
                    onChange={(ev) => setTranscriptQuery(ev.target.value)}
                  />
                </div>
                {availability.state !== 'transcript-ready' ? (
                  <p style={{ color: 'var(--lw-meta)', fontSize: 13 }}>{availability.note}</p>
                ) : null}
                {transcript.isError ? (
                  <LwStateUnavailable
                    source="Transcript"
                    reason={
                      segments.length
                        ? 'Transcript updates are temporarily unavailable. Recorded segments remain below.'
                        : 'Transcript segments could not be loaded.'
                    }
                    onRetry={() => void transcript.refetch()}
                  />
                ) : null}
                {transcript.isLoading ? (
                  <LwSkeleton height={120} />
                ) : visibleSegments.length === 0 && !transcript.isError ? (
                  <p style={{ color: 'var(--lw-meta)', fontSize: 13 }}>
                    {segments.length === 0
                      ? 'No transcript segments recorded.'
                      : 'No segments match this search.'}
                  </p>
                ) : visibleSegments.length > 0 ? (
                  <ol
                    style={{
                      listStyle: 'none',
                      margin: 0,
                      padding: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    {visibleSegments.map((s: PublicTranscriptSegment) => (
                      <li
                        key={s.id}
                        id={`lw-seg-${s.id}`}
                        style={{
                          borderLeft: s.gapBefore ? '2px solid var(--lw-faint)' : undefined,
                          paddingLeft: 10,
                          transition: 'background 0.4s',
                        }}
                      >
                        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                          <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                            {msToClock(s.startMs)}
                          </span>
                          {retainedAudio ? (
                            <button
                              type="button"
                              className="lw-backlink"
                              onClick={() => playEvidence(s.startMs)}
                            >
                              Play audio
                            </button>
                          ) : null}
                          <SpeakerName
                            segment={s}
                            onRename={(label, displayName) =>
                              renameSpeaker.mutateAsync({ label, displayName })
                            }
                          />
                          {s.gapBefore ? (
                            <span style={{ fontSize: 11, color: 'var(--lw-meta)' }}>· gap</span>
                          ) : null}
                        </div>
                        <p style={{ margin: '2px 0 0', fontSize: 14 }}>{s.text}</p>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </>
            )}
          </section>
      </div>

      {/* ── Intelligence tab ── */}
      <div
        className="lw-detail__tabpanel"
        role="tabpanel"
        id="lw-detail-panel-intelligence"
        aria-label="Intelligence panel"
        hidden={activeTab !== 'intelligence'}
        style={activeTab !== 'intelligence' ? { display: 'none' } : undefined}
      >
          <section className="lw-card lw-detail__card" aria-label="Intelligence">
            <div className="lw-card__head">
              <h2 className="lw-card__title">Intelligence</h2>
              <span className="lw-card__meta">{intel.length} items</span>
            </div>
            {intelligence.isError ? (
              <LwStateUnavailable
                source="Intelligence"
                reason={
                  intel.length
                    ? 'Intelligence updates are temporarily unavailable. The last received findings remain below.'
                    : 'Intelligence could not be loaded.'
                }
                onRetry={() => void intelligence.refetch()}
              />
            ) : null}
            {intelligence.data?.status === 'FAILED' ? (
              <p role="alert" style={{ color: 'var(--lw-meta)', fontSize: 13 }}>
                Intelligence extraction failed.
                {segments.length > 0 ? ' The transcript remains available for review.' : ''}
              </p>
            ) : intelligence.data?.status === 'DEGRADED' ? (
              <p role="status" style={{ color: 'var(--lw-meta)', fontSize: 13 }}>
                Some intelligence extraction jobs failed. Findings may be incomplete while processing
                continues.
              </p>
            ) : null}
            {intelligence.isLoading ? (
              <LwSkeleton height={100} />
            ) : intel.length === 0 &&
              !intelligence.isError &&
              intelligence.data?.status !== 'FAILED' ? (
              <p style={{ color: 'var(--lw-meta)', fontSize: 13 }}>
                {intelProcessing
                  ? 'Intelligence extraction is in progress — findings appear here as segments are processed.'
                  : availability.available
                    ? 'No intelligence was extracted for this proceeding.'
                    : 'No automatic-capture transcript is available here. Saved sessions above may contain transcript and intelligence.'}
              </p>
            ) : intel.length > 0 ? (
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                {intel.map((item: HearingIntelligenceItem) => (
                  <li
                    key={item.id}
                    style={{ borderLeft: '2px solid var(--lw-brand-dot)', paddingLeft: 10 }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <LwPill tone="brand" size="22">
                        {INTEL_LABEL[item.insightType] ?? item.insightType}
                      </LwPill>
                      <strong style={{ fontSize: 14 }}>{item.title}</strong>
                      {item.preliminary ? (
                        <span style={{ fontSize: 11, color: 'var(--lw-meta)' }}>preliminary</span>
                      ) : null}
                    </div>
                    <p style={{ margin: '4px 0 0', fontSize: 13 }}>{item.summary}</p>
                    {item.evidenceText ? (
                      item.segmentId ? (
                        // §9: the evidence quote is a control — clicking jumps to and
                        // highlights the supporting transcript segment.
                        <button
                          type="button"
                          className="lw-backlink"
                          style={{ display: 'block', padding: 0, textAlign: 'left', margin: '6px 0 0' }}
                          onClick={() => jumpToSegment(item.segmentId)}
                          aria-label={`Jump to transcript evidence at ${item.startMs != null ? msToClock(item.startMs) : 'recorded position'}`}
                        >
                          <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                            Evidence: “{item.evidenceText.slice(0, 200)}”
                            {item.startMs != null ? ` @ ${msToClock(item.startMs)}` : ''}
                            {item.speakerName ? ` — ${item.speakerName}` : ''}
                          </span>
                        </button>
                      ) : (
                        <p
                          className="lw-mono"
                          style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--lw-meta)' }}
                        >
                          Evidence: “{item.evidenceText.slice(0, 200)}”
                          {item.startMs != null ? ` @ ${msToClock(item.startMs)}` : ''}
                          {item.speakerName ? ` — ${item.speakerName}` : ''}
                        </p>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
      </div>

      {/* ── Client Relevance tab ── */}
      <div
        className="lw-detail__tabpanel"
        role="tabpanel"
        id="lw-detail-panel-client-relevance"
        aria-label="Client relevance panel"
        hidden={activeTab !== 'client-relevance'}
        style={activeTab !== 'client-relevance' ? { display: 'none' } : undefined}
      >
          <ClientRelevancePanel
            hearingId={hearingId}
            clientId={clientId}
            onSelectClient={setClientId}
            onJumpToSegment={jumpToSegment}
            onAction={(action, refs) => setPendingAction({ action, refs })}
          />
      </div>

      {/* ── Sources & Documents tab ── */}
      <div
        className="lw-detail__tabpanel"
        role="tabpanel"
        id="lw-detail-panel-sources-documents"
        aria-label="Sources and documents panel"
        hidden={activeTab !== 'sources-documents'}
        style={activeTab !== 'sources-documents' ? { display: 'none' } : undefined}
      >
          <SourcesAndDocumentsSection hearingId={hearingId} />
      </div>

      {/* Actions — always mounted so pendingAction state and dialogs survive tab switches */}
      <HearingActions
        hearingId={hearingId}
        hearingTitle={e.title}
        clientId={clientId}
        hasTranscript={availability.available && segments.length > 0}
        canSaveMoment={availability.available && segments.length > 0}
        pendingAction={pendingAction}
        onPendingHandled={() => setPendingAction(null)}
      />

      {dialog === 'follow' ? (
        <FollowDialog
          hearingId={hearingId}
          hearingTitle={e.title}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'attend' ? (
        <AttendDialog
          hearingId={hearingId}
          hearingTitle={e.title}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

/** The real "what changed" timeline (`committee_site_update` rows). The
 * canonical official source link is rendered once in the overview facts. */
function SourcesAndDocumentsSection({ hearingId }: { hearingId: string }) {
  const updates = useHearingUpdates(hearingId);
  return (
    <section className="lw-card lw-detail__card" aria-label="Sources and documents">
      <div className="lw-card__head">
        <h2 className="lw-card__title">Sources & Documents</h2>
      </div>
      <h3 className="lw-sect__title" style={{ marginTop: 16 }}>
        What changed
      </h3>
      {updates.isLoading ? (
        <LwSkeleton height={60} />
      ) : updates.isError ? (
        <LwStateUnavailable
          source="Update history"
          reason="The update history did not respond."
          onRetry={() => updates.refetch()}
        />
      ) : !updates.data?.updates.length ? (
        <p className="lw-state__body" style={{ maxWidth: 'none' }}>
          No official changes recorded for this proceeding yet.
        </p>
      ) : (
        <ul
          style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {updates.data.updates.slice(0, 8).map((u) => (
            <li key={u.id} style={{ fontSize: 13 }}>
              <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                {new Date(u.firstSeenAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>{' '}
              {u.title}
              {u.previousValue && u.newValue ? ` — ${u.previousValue} → ${u.newValue}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
