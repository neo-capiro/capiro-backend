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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  useLwWeekCalendar,
  useCanonicalHearingEvent,
  usePublicHearingTranscript,
  useHearingIntelligence,
  serverCaptureCapability,
  browserCaptureCapability,
  type CanonicalHearingEvent,
  type PublicTranscriptSegment,
  type HearingIntelligenceItem,
} from '../lib/canonical-hearings.js';
import {
  formatHearingDay,
  formatHearingMoment,
  formatHearingTime,
  momentOfCanonicalEvent,
} from '../lib/hearing-datetime.js';
import {
  accessPillLabel,
  isClosedSession,
  transcriptAvailability,
} from '../lib/hearing-detail-states.js';
import { LwPill, LwButton, LwSkeleton } from '../lib/primitives.js';
import { LwStateUnavailable } from '../states/SystemStates.js';
// Wave 1 surfaces. Each owns one workstream and reads a real Wave 1 endpoint.
import { FollowDialog } from './FollowDialog.js';
import { AttendDialog, ATTENDANCE_LABEL } from './AttendDialog.js';
import { ClientRelevancePanel } from './ClientRelevancePanel.js';
import { HearingActions, type ActionRefs } from './HearingActions.js';
import { useAttendance, useFollowConfig, useHearingUpdates } from '../lib/wave1-api.js';

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

function msToClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function HearingDetailRoute() {
  const { hearingId = '' } = useParams<{ hearingId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const event = useCanonicalHearingEvent(hearingId);
  const transcript = usePublicHearingTranscript(hearingId);
  const intelligence = useHearingIntelligence(hearingId);
  const [transcriptQuery, setTranscriptQuery] = useState('');

  // Wave 1 tenant state. Both are read here so the header controls show the
  // real persisted state rather than a local guess.
  const follow = useFollowConfig(hearingId);
  const attendance = useAttendance(hearingId);
  const [dialog, setDialog] = useState<'follow' | 'attend' | null>(null);
  const [pendingAction, setPendingAction] = useState<
    { action: string; refs: ActionRefs } | null
  >(null);

  // The client lens lives in the URL so it persists across navigation and can
  // be shared. It changes the tenant ANALYSIS only, never the public record.
  const clientId = searchParams.get('client') ?? '';
  const setClientId = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams);
      if (next) params.set('client', next);
      else params.delete('client');
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
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
        s.text.toLowerCase().includes(q) || (s.speakerName ?? '').toLowerCase().includes(q),
    );
  }, [segments, transcriptQuery]);

  // §9 click-to-jump, hoisted above the early returns: a hook must run on every
  // render, and the loading/error branches below return early.
  const jumpToSegment = useCallback((segmentId: string | undefined) => {
    if (!segmentId) return;
    const el = document.getElementById(`lw-seg-${CSS.escape(segmentId)}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.background = 'color-mix(in srgb, var(--lw-brand-dot) 12%, transparent)';
      window.setTimeout(() => {
        el.style.background = '';
      }, 2200);
    }
  }, []);

  // W1-3: an archive transcript hit deep-links here as `#seg-<segmentId>`.
  // The jump waits for the transcript page containing the segment to land —
  // scrolling before it renders would silently do nothing.
  const hash = window.location.hash;
  useEffect(() => {
    if (!hash.startsWith('#seg-')) return;
    const segmentId = decodeURIComponent(hash.slice('#seg-'.length));
    if (!segmentId) return;
    if (!segments.some((seg: PublicTranscriptSegment) => seg.id === segmentId)) return;
    jumpToSegment(segmentId);
  }, [hash, segments, jumpToSegment]);

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
          <LwButton onClick={() => navigate('/legiwatch?tab=hearings')}>← Back to LegiWatch</LwButton>
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
    ((intelligence.data?.jobs?.public?.pending ?? 0) + (intelligence.data?.jobs?.tenant?.pending ?? 0) > 0);
  const committeeCode = e.subcommittee?.systemCode ?? e.committee?.systemCode ?? null;
  const officialUrl = e.officialPageUrl ?? null;


  return (
    <div className="lw-body lw-detail" aria-label={`Hearing detail: ${e.title}`}>
      <button type="button" className="lw-backlink" onClick={() => navigate('/legiwatch?tab=hearings')}>
        ← Back to LegiWatch
      </button>

      {/* 1. Overview */}
      <section className="lw-card" style={{ padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <LwPill tone={closed ? 'gray' : accessLabel === 'PUBLIC' ? 'brand' : 'gray'} size="22">{accessLabel}</LwPill>
          <LwPill tone="gray" size="22">{(e.eventStatus ?? '').toUpperCase()}</LwPill>
          {e.capture ? <LwPill tone="gray" size="22">CAPTURE {e.capture.status.toUpperCase()}</LwPill> : null}
        </div>
        <h1 style={{ margin: '10px 0 4px', fontSize: 22, lineHeight: 1.25 }}>{e.title}</h1>
        <div className="lw-lrow__when" style={{ fontSize: 13 }}>
          {formatHearingDay(moment)} · {formatHearingTime(moment)}
        </div>
        <dl className="lw-detail__facts" style={{ margin: '14px 0 0', display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 8, fontSize: 13 }}>
          <dt style={{ color: 'var(--lw-meta)' }}>Committee</dt>
          <dd style={{ margin: 0 }}>
            {committeeCode ? (
              <button type="button" className="lw-backlink" style={{ padding: 0 }} onClick={() => navigate(`/legiwatch/committees/${encodeURIComponent(committeeCode)}`)}>
                {e.subcommittee?.name ?? e.committee?.name ?? '—'}
              </button>
            ) : (
              e.committee?.name ?? '—'
            )}
          </dd>
          <dt style={{ color: 'var(--lw-meta)' }}>Chamber</dt>
          <dd style={{ margin: 0 }}>{e.chamber ?? '—'}</dd>
          <dt style={{ color: 'var(--lw-meta)' }}>Location</dt>
          <dd style={{ margin: 0 }}>{e.location ?? '—'}</dd>
          <dt style={{ color: 'var(--lw-meta)' }}>Official source</dt>
          <dd style={{ margin: 0 }}>
            {officialUrl ? (
              <a className="lw-backlink" href={officialUrl} target="_blank" rel="noreferrer noopener">Official event page ↗</a>
            ) : (
              '—'
            )}
          </dd>
          <dt style={{ color: 'var(--lw-meta)' }}>Stream status</dt>
          <dd style={{ margin: 0 }}>{e.streamState ?? 'NOT_CHECKED'}</dd>
          <dt style={{ color: 'var(--lw-meta)' }}>Witnesses</dt>
          <dd style={{ margin: 0 }}>{e.witnesses?.length ? e.witnesses.map((w) => w.name).join(', ') : 'None listed'}</dd>
        </dl>
      </section>

      {/* 3. Live & Capture — explicit, honest state (LEGIWATCH-V2-HANDOFF §5.4) */}
      <section className="lw-card" style={{ padding: 18 }} aria-label="Live and capture">
        <div className="lw-card__head">
          <h2 className="lw-card__title">Live & Capture</h2>
          {closed ? (
            <span className="lw-card__meta">Closed session — no public stream</span>
          ) : accessLabel === 'ACCESS UNVERIFIED' ? (
            <span className="lw-card__meta">Public access unverified — capture unavailable until confirmed.</span>
          ) : e.capture ? (
            <span className="lw-card__meta">
              {e.capture.status}
              {e.capture.failureReason ? ` · ${e.capture.failureReason}` : ''}
              {e.capture.gapSeconds ? ` · ${Math.round(e.capture.gapSeconds / 60)} min gaps` : ''}
            </span>
          ) : (
            <span className="lw-card__meta">No capture requested</span>
          )}
        </div>
        {/* W1-1 / W1-2. Follow and Attend are DIFFERENT products and are two
            separate controls: following notifies, attending captures. The
            Attend control renders only when the server says a mode is actually
            available, so a closed session has no attendance affordance at all. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <LwButton
            variant={follow.data?.following ? undefined : 'primary'}
            onClick={() => setDialog('follow')}
          >
            {follow.data?.following ? 'Edit follow' : 'Follow'}
          </LwButton>

          {attendance.data?.scheduled ? (
            <LwButton onClick={() => setDialog('attend')}>Scheduled · manage</LwButton>
          ) : attendance.data?.canRequest ? (
            <LwButton variant="primary" onClick={() => setDialog('attend')}>
              Have Capiro attend
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

      {/* 4. Transcript */}
      <section className="lw-card" style={{ padding: 18 }} aria-label="Transcript">
        <div className="lw-card__head">
          <h2 className="lw-card__title">Transcript</h2>
          <span className="lw-card__meta">{segments.length} segments</span>
        </div>
        {!availability.available ? (
          <p style={{ color: 'var(--lw-meta)', fontSize: 13 }}>{availability.note}</p>
        ) : (
          <>
            <div className="lw-search" style={{ margin: '8px 0 12px' }}>
              <span aria-hidden="true" style={{ color: 'var(--lw-meta)' }}>⌕</span>
              <input
                aria-label="Search transcript"
                placeholder="Search transcript text or speaker"
                value={transcriptQuery}
                onChange={(ev) => setTranscriptQuery(ev.target.value)}
              />
            </div>
            {transcript.isLoading ? <LwSkeleton height={120} /> : null}
            {transcript.isError ? (
              <LwStateUnavailable
                source="Transcript"
                reason="Transcript segments could not be loaded."
                onRetry={() => void transcript.refetch()}
              />
            ) : visibleSegments.length === 0 ? (
              <p style={{ color: 'var(--lw-meta)', fontSize: 13 }}>
                {segments.length === 0 ? 'No transcript segments recorded.' : 'No segments match this search.'}
              </p>
            ) : (
              <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {visibleSegments.map((s: PublicTranscriptSegment) => (
                  <li
                    key={s.id}
                    id={`lw-seg-${CSS.escape(s.id)}`}
                    style={{ borderLeft: s.gapBefore ? '2px solid var(--lw-faint)' : undefined, paddingLeft: 10, transition: 'background 0.4s' }}
                  >
                    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                      <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>{msToClock(s.startMs)}</span>
                      {s.speakerName ? <strong style={{ fontSize: 13 }}>{s.speakerName}</strong> : null}
                      {s.gapBefore ? <span style={{ fontSize: 11, color: 'var(--lw-meta)' }}>· gap</span> : null}
                    </div>
                    <p style={{ margin: '2px 0 0', fontSize: 14 }}>{s.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </section>

      {/* 5. Intelligence — grounded claims only */}
      <section className="lw-card" style={{ padding: 18 }} aria-label="Intelligence">
        <div className="lw-card__head">
          <h2 className="lw-card__title">Intelligence</h2>
          <span className="lw-card__meta">{intel.length} items</span>
        </div>
        {intel.length === 0 ? (
          <p style={{ color: 'var(--lw-meta)', fontSize: 13 }}>
            {intelProcessing
              ? 'Intelligence extraction is in progress — findings appear here as segments are processed.'
              : availability.available
                ? 'No intelligence was extracted for this proceeding.'
                : 'Intelligence requires a transcript — none is available for this proceeding.'}
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {intel.map((item: HearingIntelligenceItem) => (
              <li key={item.id} style={{ borderLeft: '2px solid var(--lw-brand-dot)', paddingLeft: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <LwPill tone="brand" size="22">{INTEL_LABEL[item.insightType] ?? item.insightType}</LwPill>
                  <strong style={{ fontSize: 14 }}>{item.title}</strong>
                  {item.preliminary ? <span style={{ fontSize: 11, color: 'var(--lw-meta)' }}>preliminary</span> : null}
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
                    <p className="lw-mono" style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--lw-meta)' }}>
                      Evidence: “{item.evidenceText.slice(0, 200)}”
                      {item.startMs != null ? ` @ ${msToClock(item.startMs)}` : ''}
                      {item.speakerName ? ` — ${item.speakerName}` : ''}
                    </p>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 6. Client relevance (W1-6) — tenant-scoped analysis over the public
          record above. Switching the lens re-runs the ANALYSIS only. */}
      <ClientRelevancePanel
        hearingId={hearingId}
        clientId={clientId}
        onSelectClient={setClientId}
        onJumpToSegment={jumpToSegment}
        onAction={(action, refs) => setPendingAction({ action, refs })}
      />

      {/* 6b. Sources & Documents (LEGIWATCH-V2-HANDOFF §5.4) */}
      <SourcesAndDocumentsSection hearingId={hearingId} officialUrl={officialUrl} />

      {/* 7. Actions (W1-7) + calendar export (W1-8). */}
      <HearingActions
        hearingId={hearingId}
        hearingTitle={e.title}
        clientId={clientId}
        canCreateBrief={availability.available}
        canSaveMoment={availability.available}
        pendingAction={pendingAction}
        onPendingHandled={() => setPendingAction(null)}
      />

      {dialog === 'follow' ? (
        <FollowDialog hearingId={hearingId} hearingTitle={e.title} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'attend' ? (
        <AttendDialog hearingId={hearingId} hearingTitle={e.title} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

/** Official event page, the real "what changed" timeline (`committee_site_update`
 *  rows for this hearing), and source confidence in plain language. There is
 *  no per-hearing document-availability model yet, so a document list beyond
 *  the official page is not fabricated — it is simply not shown. */
function SourcesAndDocumentsSection({ hearingId, officialUrl }: { hearingId: string; officialUrl: string | null }) {
  const updates = useHearingUpdates(hearingId);
  return (
    <section className="lw-card" style={{ padding: 18 }} aria-label="Sources and documents">
      <div className="lw-card__head">
        <h2 className="lw-card__title">Sources & Documents</h2>
      </div>
      <dl style={{ margin: '10px 0 0', display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 8, fontSize: 13 }}>
        <dt style={{ color: 'var(--lw-meta)' }}>Official source</dt>
        <dd style={{ margin: 0 }}>
          {officialUrl ? (
            <a className="lw-backlink" href={officialUrl} target="_blank" rel="noreferrer noopener">Official event page ↗</a>
          ) : (
            '—'
          )}
        </dd>
      </dl>

      <h3 className="lw-sect__title" style={{ marginTop: 16 }}>What changed</h3>
      {updates.isLoading ? (
        <LwSkeleton height={60} />
      ) : updates.isError ? (
        <LwStateUnavailable source="Update history" reason="The update history did not respond." onRetry={() => updates.refetch()} />
      ) : !updates.data?.updates.length ? (
        <p className="lw-state__body" style={{ maxWidth: 'none' }}>No official changes recorded for this proceeding yet.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {updates.data.updates.slice(0, 8).map((u) => (
            <li key={u.id} style={{ fontSize: 13 }}>
              <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                {new Date(u.firstSeenAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
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
