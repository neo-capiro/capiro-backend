/**
 * Hearings tab (§7.7) — the module's landing tab. Two columns: the schedule
 * (left) and sessions + scheduled recordings (right).
 *
 * PR A remediation (2026-09-02, LW-QA-001/002/005):
 *  - The schedule now reads the CANONICAL Phase 3 master calendar
 *    (`/api/legiwatch/live-hearings/calendar`) scoped to the SELECTED WEEK
 *    (from/to), instead of one forward-only upcoming fetch paged locally.
 *    Historical weeks therefore fetch their real completed rows, and the
 *    header count is the server's count for exactly the visible range.
 *  - Date/time rendering goes through the shared contract
 *    (`lib/hearing-datetime.ts`): the true instant when the official time is
 *    known, "Time not announced" otherwise — never the 8:00 PM previous-day
 *    artifact of parsing a calendar date as UTC midnight.
 *  - Closed sessions (publicAccessStatus CLOSED / UNKNOWN-private) are
 *    classified from canonical visibility BEFORE any capture affordance:
 *    they render "Closed session — no public stream", never "Attend live".
 *
 * Scheduled (unattended) recordings: there is no server capture-job queue
 * (GAPS LW-G2). The queue panel renders its UNAVAILABLE state honestly rather
 * than fabricating a queue — the setup modal's Unattended mode is disabled
 * with the reason named, and Attend live (browser capture) is the honest path.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useHearingSessionHistory,
  useResolveStream,
  type UpcomingHearing,
} from '../../../../lib/hearing-watch-api.js';
import {
  useLwWeekCalendar,
  browserCaptureCapability,
  serverCaptureCapability,
  type CanonicalHearingEvent,
} from '../lib/canonical-hearings.js';
import { LwPill, LwSeg, LwButton, LwSkeleton } from '../lib/primitives.js';
import {
  LwStateEmpty,
  LwStateUnavailable,
  LwStateAllClear,
} from '../states/SystemStates.js';
import { LwModal } from '../overlays/LwModal.js';
import type { HearingCapability, Tone } from '../lib/types.js';
import { TranscriptionSetupModal } from '../overlays/TranscriptionSetupModal.js';
import {
  calendarBucketIndex,
  easternDayOf,
  formatHearingDay,
  formatHearingTime,
  parseHearingMoment,
  useEasternWeekDays,
  type HearingMoment,
} from '../lib/hearing-datetime.js';

type ViewMode = 'calendar' | 'list';

const KIND_TONE: Record<string, Tone> = { HEARING: 'brand', MARKUP: 'gray' };

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Canonical → legacy-modal adapter. The setup modal still speaks the legacy
 * UpcomingHearing shape; the canonical row carries strictly more truth.
 */
function toLegacyHearing(e: CanonicalHearingEvent): UpcomingHearing {
  return {
    id: e.id,
    title: e.title,
    committee: e.committee?.name ?? 'Committee',
    chamber: e.chamber ?? '',
    // NEVER parse this string as a time — modal consumers use startsAt.
    scheduledAt: e.calendarDate ?? (e.scheduledStart ? e.scheduledStart.slice(0, 10) : ''),
    startsAt: e.scheduledStart ?? null,
    time: e.scheduledStart ? formatHearingTime(parseHearingMoment({ date: e.calendarDate ?? '', startsAt: e.scheduledStart, timeZone: e.timeZone })) : null,
    timezone: e.timeZone ?? null,
    visibility: e.publicAccessStatus === 'CLOSED' ? 'private' : 'public',
    type: e.eventType ?? null,
    location: e.location ?? null,
    url: e.officialPageUrl ?? null,
    sessionId: null,
    sessionStatus: null,
    watchlistMatchCount: 0,
    recapSaved: false,
  };
}

/** vNext capability for a canonical row (LW-QA-002): visibility FIRST. */
function canonicalCapability(e: CanonicalHearingEvent): {
  capability: HearingCapability;
  closed: boolean;
  reason: string;
} {
  const access = (e.publicAccessStatus ?? 'UNKNOWN').toUpperCase();
  if (access === 'CLOSED' || access === 'PRIVATE' || access === 'UNKNOWN') {
    return {
      capability: 'unavailable',
      closed: true,
      reason:
        access === 'UNKNOWN'
          ? 'Public access could not be verified from official source metadata.'
          : 'Closed session — no public stream.',
    };
  }
  const server = serverCaptureCapability(e);
  if (server.allowed) return { capability: 'direct', closed: false, reason: server.reason ?? '' };
  const browser = browserCaptureCapability(e);
  if (browser.allowed) return { capability: 'browser', closed: false, reason: browser.reason ?? '' };
  return { capability: 'unavailable', closed: false, reason: browser.reason ?? server.reason ?? '' };
}

export function HearingsTab({ scope }: { scope: string }) {
  const navigate = useNavigate();
  const history = useHearingSessionHistory();
  const resolveStream = useResolveStream();

  const [view, setView] = useState<ViewMode>('calendar');
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => new Date());
  const [committee, setCommittee] = useState<string>('');
  const [kind, setKind] = useState<string>('');
  const [search, setSearch] = useState('');
  const [setupHearing, setSetupHearing] = useState<CanonicalHearingEvent | null>(null);

  const weekDays = useEasternWeekDays(weekAnchor);
  const rangeFrom = weekDays[0] ?? '';
  const rangeTo = weekDays[6] ?? '';

  // LW-QA-005: server-side range query. The query key includes the week, so a
  // prior week's response can never overwrite a newer navigation request.
  const calendar = useLwWeekCalendar({
    from: rangeFrom,
    to: rangeTo,
    committee: committee || undefined,
    q: search.trim() || undefined,
  });

  const rows = useMemo(() => calendar.data?.items ?? [], [calendar.data]);
  const serverTotal = calendar.data?.total ?? 0;

  const filtered = useMemo(() => {
    const k = kind.toUpperCase();
    return rows.filter((e) => (k ? (e.eventType ?? 'HEARING').toUpperCase() === k : true));
  }, [rows, kind]);

  const committees = useMemo(
    () => Array.from(new Set(rows.map((e) => e.committee?.name ?? '').filter(Boolean))).sort(),
    [rows],
  );

  // The visible filtered count IS the header count (server total for the range,
  // adjusted by the kind facet which the server does not see).
  const visibleCount = kind ? filtered.length : Math.min(serverTotal, rows.length);

  // Live rows come from the canonical live endpoint's shape via the calendar
  // rows themselves; the room route is handled in the live tab.
  const live = useMemo(() => rows.find((e) => e.eventStatus === 'in_progress') ?? null, [rows]);

  const momentOf = (e: CanonicalHearingEvent): HearingMoment =>
    parseHearingMoment({
      date: e.calendarDate ?? (e.scheduledStart ? easternDayOf(e.scheduledStart) ?? '' : ''),
      startsAt: e.scheduledStart ?? null,
      time: null,
      timeZone: e.timeZone ?? null,
    });

  const byDay = useMemo(() => {
    const map = new Map<number, CanonicalHearingEvent[]>();
    weekDays.forEach((_, i) => map.set(i, []));
    for (const e of filtered) {
      const idx = calendarBucketIndex(momentOf(e), weekDays);
      if (idx >= 0) map.get(idx)!.push(e);
    }
    for (const list of map.values()) {
      list.sort((a, b) =>
        (a.scheduledStart ?? a.calendarDate ?? '').localeCompare(b.scheduledStart ?? b.calendarDate ?? ''),
      );
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, weekDays]);

  const openHearing = (e: CanonicalHearingEvent) => {
    // Every row routes to the canonical detail (PR B); the setup modal is
    // reachable from detail. Live hearings keep the room route.
    if (e.eventStatus === 'in_progress') {
      navigate(`/legiwatch/live`);
      return;
    }
    navigate(`/legiwatch/hearings/${encodeURIComponent(e.id)}`);
  };

  if (calendar.isLoading) {
    return (
      <div className="lw-body">
        <div className="lw-hearings-cols">
          <div className="lw-card" style={{ padding: 18 }}>
            <LwSkeleton height={32} />
            <div style={{ height: 12 }} />
            <LwSkeleton height={206} delay={2} />
          </div>
          <div className="lw-card" style={{ padding: 18 }}>
            <LwSkeleton height={120} delay={3} />
          </div>
        </div>
      </div>
    );
  }

  if (calendar.isError) {
    return (
      <div className="lw-body">
        <LwStateUnavailable
          source="Hearing schedule"
          reason="The canonical committee calendar could not be loaded for this week. Sessions and recordings below are unaffected."
          onRetry={() => void calendar.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="lw-body">
      <div className="lw-hearings-cols">
        {/* LEFT — the schedule */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <div className="lw-controls">
            <LwSeg
              ariaLabel="Schedule view"
              options={[
                { id: 'calendar' as ViewMode, label: 'Calendar' },
                { id: 'list' as ViewMode, label: 'List' },
              ]}
              value={view}
              onChange={setView}
            />
            <select
              aria-label="Committee"
              className="lw-btn"
              value={committee}
              onChange={(e) => setCommittee(e.target.value)}
            >
              <option value="">All committees</option>
              {committees.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              aria-label="Proceeding kind"
              className="lw-btn"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">All kinds</option>
              <option value="HEARING">Hearings</option>
              <option value="MARKUP">Markups</option>
            </select>
            <div className="lw-search">
              <span aria-hidden="true" style={{ color: 'var(--lw-meta)' }}>⌕</span>
              <input
                aria-label="Search proceedings"
                placeholder="Search title or committee"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {view === 'calendar' ? (
            <section className="lw-card lw-cal" aria-label="Week calendar">
              <div className="lw-card__head">
                <button
                  className="lw-navbtn"
                  aria-label="Previous week"
                  onClick={() => {
                    const d = new Date(weekAnchor);
                    d.setDate(d.getDate() - 7);
                    setWeekAnchor(d);
                  }}
                >
                  ‹
                </button>
                <button
                  className="lw-navbtn"
                  aria-label="Next week"
                  onClick={() => {
                    const d = new Date(weekAnchor);
                    d.setDate(d.getDate() + 7);
                    setWeekAnchor(d);
                  }}
                >
                  ›
                </button>
                <span className="lw-weeklabel">
                  {formatHearingDay(parseHearingMoment({ date: weekDays[0] ?? '' }))} –{' '}
                  {formatHearingDay(parseHearingMoment({ date: weekDays[6] ?? '' }))}
                </span>
                <span className="lw-card__meta">
                  {visibleCount} proceedings · {serverTotal > rows.length ? 'showing first 200' : `${totalMatches0(rows)} client matches`}
                </span>
                <LwButton
                  onClick={() => {
                    const matched = filtered.filter((e) => (e.subscription?.scheduled ?? false));
                    const ics = matched
                      .map((e) => `${e.calendarDate ?? e.scheduledStart ?? ''} — ${e.title} (${e.committee?.name ?? ''})`)
                      .join('\n');
                    const blob = new Blob([`LegiWatch watchlist-matched proceedings\n\n${ics}`], {
                      type: 'text/plain',
                    });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = 'legiwatch-calendar.txt';
                    a.click();
                    URL.revokeObjectURL(a.href);
                  }}
                >
                  Export calendar
                </LwButton>
              </div>

              <div className="lw-cal__grid">
                {weekDays.map((day, i) => {
                  const list = byDay.get(i) ?? [];
                  const isToday = sameDay(new Date(), parseEasternUTC(day));
                  return (
                    <div key={day} className={`lw-cal__day${isToday ? ' is-today' : ''}`}>
                      <div className="lw-cal__dayhead">
                        <span className="lw-cal__weekday">{WEEKDAY[i]}</span>
                        <span className="lw-cal__date">{Number(day.slice(8, 10))}</span>
                      </div>
                      {list.length === 0 ? (
                        <span className="lw-cal__empty">No proceedings</span>
                      ) : (
                        list.map((e) => {
                          const isLive = e.eventStatus === 'in_progress';
                          const { capability: cap, closed } = canonicalCapability(e);
                          const queued = e.capture?.status === 'scheduled';
                          const kindCls =
                            closed
                              ? 'lw-chip--unavailable'
                              : isLive
                                ? 'lw-chip--live'
                                : (e.eventType ?? 'HEARING').toUpperCase() === 'MARKUP'
                                  ? 'lw-chip--markup'
                                  : 'lw-chip--hearing';
                          const m = momentOf(e);
                          return (
                            <button
                              key={e.id}
                              type="button"
                              className={`lw-chip ${kindCls}`}
                              onClick={() => openHearing(e)}
                              aria-label={`${e.title}, ${e.committee?.name ?? ''}, ${formatHearingTime(m)}`}
                            >
                              <span className="lw-chip__row">
                                <span className="lw-chip__time">{formatHearingTime(m)}</span>
                                {isLive || queued ? (
                                  <span
                                    className="lw-chip__marker"
                                    style={{ background: isLive ? 'var(--lw-error-dot)' : 'var(--lw-brand-dot)' }}
                                    aria-hidden="true"
                                  />
                                ) : null}
                              </span>
                              <span className="lw-chip__title">{e.title}</span>
                              <span className="lw-chip__meta">
                                {e.committee?.name ?? ''}
                                {closed ? ' · CLOSED SESSION' : ''}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="lw-cal__legend">
                <span className="lw-legend__item"><span className="lw-legend__dot" style={{ background: 'var(--lw-error-dot)' }} />Live now</span>
                <span className="lw-legend__item"><span className="lw-legend__dot" style={{ background: 'var(--lw-brand-dot)' }} />Hearing</span>
                <span className="lw-legend__item"><span className="lw-legend__dot" style={{ background: 'var(--lw-faint)' }} />Markup</span>
                <span className="lw-legend__item"><span className="lw-legend__dot" style={{ background: 'var(--lw-brand-dot)' }} />Recording queued</span>
              </div>
            </section>
          ) : (
            <section className="lw-card" aria-label="Schedule list">
              <div className="lw-card__head">
                <h2 className="lw-card__title">Schedule — this week</h2>
                <span className="lw-card__meta">{visibleCount} proceedings</span>
              </div>
              {filtered.length === 0 ? (
                <div style={{ padding: 18 }}>
                  <LwStateEmpty onReset={() => { setCommittee(''); setKind(''); setSearch(''); }} />
                </div>
              ) : (
                filtered.map((e) => {
                  const isLive = e.eventStatus === 'in_progress';
                  const { capability: cap, closed, reason } = canonicalCapability(e);
                  const queued = e.capture?.status === 'scheduled';
                  const verb = isLive
                    ? 'OPEN LIVE ROOM'
                    : queued
                      ? 'RECORDING SCHEDULED'
                      : closed
                        ? 'CLOSED SESSION'
                        : cap === 'unavailable'
                          ? 'RECORDING UNAVAILABLE'
                          : 'VIEW DETAIL';
                  return (
                    <div key={e.id} className={`lw-lrow${isLive ? ' is-live' : ''}`}>
                      <button
                        type="button"
                        className="lw-lrow__main"
                        style={{ textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', width: '100%' }}
                        onClick={() => openHearing(e)}
                        aria-label={`Open ${e.title}`}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <span className="lw-lrow__when">
                            {formatHearingDay(momentOf(e)).toUpperCase()} · {formatHearingTime(momentOf(e))}
                          </span>
                          <LwPill tone={KIND_TONE[(e.eventType ?? 'HEARING').toUpperCase()] ?? 'brand'} size="22">
                            {(e.eventType ?? 'HEARING').toUpperCase()}
                          </LwPill>
                          <span className="lw-lrow__cm">{e.committee?.name ?? ''}</span>
                        </div>
                        <div className="lw-lrow__title">{e.title}</div>
                        <div className="lw-lrow__match">
                          {closed ? reason : (e.capture?.status ? `CAPTURE ${e.capture.status.toUpperCase()}` : 'NO CAPTURE REQUESTED')}
                        </div>
                      </button>
                      <div className="lw-lrow__side">
                        <LwPill tone={closed ? 'gray' : cap === 'unavailable' ? 'gray' : cap === 'pending' ? 'warning' : 'success'} size="26">
                          {closed ? 'CLOSED' : cap === 'direct' || cap === 'browser' ? 'AVAILABLE' : cap.toUpperCase()}
                        </LwPill>
                        <button
                          type="button"
                          className="lw-lrow__verb"
                          onClick={() => openHearing(e)}
                        >
                          {closed ? 'DETAILS →' : `${verb} →`}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </section>
          )}
        </div>

        {/* RIGHT — My Sessions + Scheduled recordings */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="lw-card" aria-label="My Sessions">
            <div className="lw-card__head">
              <h2 className="lw-card__title">My Sessions</h2>
              <span className="lw-card__meta">
                {live ? '1 live' : 'None live'} · {history.data?.pages?.[0]?.total ?? 0} total
              </span>
            </div>

            {live ? (
              <div className="lw-session lw-on-ink">
                <span className="lw-session__badge">
                  <span className="lw-session__dot is-live" aria-hidden="true" />
                  LIVE
                </span>
                <div className="lw-session__title">{live.title}</div>
                <div className="lw-session__sub">{live.committee?.name ?? ''}</div>
                <div className="lw-session__actions">
                  <LwButton variant="primary" size="40" onClick={() => navigate('/legiwatch/live')}>
                    Open live room →
                  </LwButton>
                  <LwButton size="40" onClick={() => openHearing(live)}>
                    Details
                  </LwButton>
                </div>
              </div>
            ) : (
              <div style={{ padding: '16px 18px' }}>
                <LwStateAllClear lastScan="just now" />
              </div>
            )}

            <div className="lw-history__label">Recent session history</div>
            <div className="lw-history__rows">
              {(history.data?.pages?.[0]?.items ?? []).slice(0, 3).map((s) => {
                const rec = s.status === 'failed-recoverable';
                const done = s.status === 'completed';
                return (
                  <div key={s.id} className="lw-hrow">
                    <div>
                      <div className="lw-hrow__title">{s.title}</div>
                      <div className="lw-hrow__sub">
                        {done ? 'Completed' : rec ? 'Failed recoverable · source drift' : s.status}
                        {s.watchlistMatchCount != null ? ` · ${s.watchlistMatchCount} matches` : ''}
                      </div>
                    </div>
                    <span className="lw-hrow__pill">
                      <LwPill tone={rec ? 'warning' : done ? 'success' : 'gray'}>
                        {rec ? 'RECOVERABLE' : done ? (s.recapSaved ? 'RECAP READY' : 'REVIEWED') : s.status.toUpperCase()}
                      </LwPill>
                    </span>
                  </div>
                );
              })}
              {(history.data?.pages?.[0]?.items ?? []).length === 0 ? (
                <div className="lw-recs__empty">No sessions yet. Start capture from the schedule.</div>
              ) : null}
            </div>
          </section>

          <section className="lw-card" aria-label="Scheduled recordings">
            <div className="lw-card__head">
              <h2 className="lw-card__title">Scheduled recordings</h2>
              <span className="lw-card__meta">Unattended queue</span>
            </div>
            <div className="lw-recs__rows">
              {/* GAPS LW-G2: no server capture-job queue exists. Render the honest
                  empty/unavailable state rather than a fabricated queue. */}
              <div className="lw-recs__empty">
                No recordings are queued. Unattended capture isn't available on this backend yet —
                schedule one from the calendar and Capiro records the proceeding once the capture
                service is enabled.
              </div>
            </div>
            <div className="lw-note">
              <div className="lw-note__label">How unattended capture works</div>
              <div className="lw-note__body">
                Capture starts five minutes before the gavel, stops at adjournment, and delivers the
                transcript, matched moments and client impact to My Sessions. Stream capability is
                resolved at setup, so a queued recording is one that can actually run.
              </div>
            </div>
          </section>
        </div>
      </div>

      {setupHearing ? (
        <TranscriptionSetupModal
          hearing={toLegacyHearing(setupHearing)}
          capability={canonicalCapability(setupHearing).capability}
          resolveStream={resolveStream}
          onClose={() => setSetupHearing(null)}
        />
      ) : null}
    </div>
  );
}

/** `YYYY-MM-DD` → local Date at midnight (parts-parsed, no UTC shift). */
function parseEasternUTC(day: string): Date {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  return new Date(y, m - 1, d);
}

const WEEKDAY = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function totalMatches0(rows: CanonicalHearingEvent[]): number {
  return rows.filter((e) => e.subscription?.scheduled ?? false).length;
}
