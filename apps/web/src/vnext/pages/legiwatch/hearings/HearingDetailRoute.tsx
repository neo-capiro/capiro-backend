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
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
  parseHearingMoment,
} from '../lib/hearing-datetime.js';
import {
  accessPillLabel,
  isClosedSession,
  transcriptAvailability,
} from '../lib/hearing-detail-states.js';
import { LwPill, LwButton, LwSkeleton } from '../lib/primitives.js';
import { LwStateUnavailable } from '../states/SystemStates.js';

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
  const event = useCanonicalHearingEvent(hearingId);
  const transcript = usePublicHearingTranscript(hearingId);
  const intelligence = useHearingIntelligence(hearingId);
  const [transcriptQuery, setTranscriptQuery] = useState('');

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
  const moment = parseHearingMoment({
    date: e.calendarDate ?? (e.scheduledStart ? e.scheduledStart.slice(0, 10) : ''),
    startsAt: e.scheduledStart ?? null,
    timeZone: e.timeZone ?? null,
  });
  // LW-QA-002: only VERIFIED closed/private is a closed session. UNKNOWN is
  // unverified — capture fails closed, but the product never claims closed.
  const closed = isClosedSession(e.publicAccessStatus);
  const accessLabel = accessPillLabel(e.publicAccessStatus);
  const availability = transcriptAvailability(e);
  const intel = intelligence.data ?? [];
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

      {/* 3. Session/capture — explicit, honest state */}
      <section className="lw-card" style={{ padding: 18 }} aria-label="Session and capture">
        <div className="lw-card__head">
          <h2 className="lw-card__title">Session & capture</h2>
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
        {accessLabel === 'PUBLIC' && (e.eventStatus ?? '').toUpperCase() === 'SCHEDULED' ? (
          <LwButton variant="primary" onClick={() => navigate('/legiwatch?tab=hearings')}>
            Schedule / follow from the calendar
          </LwButton>
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
                  <li key={s.id} style={{ borderLeft: s.gapBefore ? '2px solid var(--lw-faint)' : undefined, paddingLeft: 10 }}>
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
            {availability.available
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
                  <p className="lw-mono" style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--lw-meta)' }}>
                    Evidence: “{item.evidenceText.slice(0, 200)}”
                    {item.startMs != null ? ` @ ${msToClock(item.startMs)}` : ''}
                    {item.speakerName ? ` — ${item.speakerName}` : ''}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 6. Client relevance — tenant-scoped overlay only */}
      <section className="lw-card" style={{ padding: 18 }} aria-label="Client relevance">
        <div className="lw-card__head">
          <h2 className="lw-card__title">Client relevance</h2>
          <span className="lw-card__meta">Your workspace only</span>
        </div>
        {e.subscription?.scheduled ? (
          <p style={{ fontSize: 13, margin: 0 }}>You follow this proceeding. Client match detail lives in My Sessions once a capture runs.</p>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--lw-meta)', margin: 0 }}>
            No watchlist match recorded for your workspace. Follow the hearing from the calendar to
            receive relevance updates.
          </p>
        )}
      </section>
    </div>
  );
}
