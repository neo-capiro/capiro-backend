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
 * Scheduled server attendance is managed from canonical hearing detail.
 * Browser sessions use the shared live capture room.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Search, DownloadCloud } from 'lucide-react';
import { ArchiveSubTab } from './ArchiveSubTab.js';
import {
  useHearingSessionHistory,
} from '../../../../lib/hearing-watch-api.js';
import {
  useLwWeekCalendar,
  isLiveEvent,
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
import { useCalendarExportBulk, downloadIcs } from '../lib/wave1-api.js';
import type { HearingCapability, Tone } from '../lib/types.js';
import {
  calendarBucketIndex,
  formatHearingDay,
  formatHearingTime,
  momentOfCanonicalEvent,
  parseHearingMoment,
  useEasternWeekDays,
} from '../lib/hearing-datetime.js';

type ViewMode = 'calendar' | 'list';

const KIND_TONE: Record<string, Tone> = { HEARING: 'brand', MARKUP: 'gray' };

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** vNext capability for a canonical row (LW-QA-002): visibility FIRST. */
export function canonicalCapability(e: CanonicalHearingEvent): {
  capability: HearingCapability;
  closed: boolean;
  reason: string;
} {
  const access = (e.publicAccessStatus ?? 'UNKNOWN').toUpperCase();
  // LW-QA-002 review item A: UNKNOWN is NOT CLOSED. A closed session is a
  // verified negative ("closed session — no public stream"); an unverified one
  // simply has not had its public access confirmed from official metadata.
  // Closed/PRIVATE → labeled CLOSED SESSION, no capture action. UNKNOWN →
  // labeled "Public access unverified", fail-closed for capture (no affordance,
  // consent inert), but never labeled as a closed session.
  if (access === 'CLOSED' || access === 'PRIVATE') {
    return {
      capability: 'unavailable',
      closed: true,
      reason: 'Closed session — no public stream.',
    };
  }
  if (access === 'UNKNOWN') {
    return {
      capability: 'unavailable',
      closed: false,
      reason: 'Public access unverified — official source metadata does not confirm public access yet.',
    };
  }
  const server = serverCaptureCapability(e);
  if (server.allowed) return { capability: 'direct', closed: false, reason: server.reason ?? '' };
  const browser = browserCaptureCapability(e);
  if (browser.allowed) return { capability: 'browser', closed: false, reason: browser.reason ?? '' };
  return { capability: 'unavailable', closed: false, reason: browser.reason ?? server.reason ?? '' };
}

/**
 * PR D / LW-QA-011 — true below 900px CSS width. matchMedia is the same
 * mechanism the stylesheet media queries use, so JS and CSS agree at the
 * boundary; a resize listener covers browsers without addListener callbacks
 * (jsdom's matchMedia is stubbed to a non-live object, so a fallback resize
 * check keeps tests deterministic).
 */
function useMediaBelow900(): boolean {
  const [below, setBelow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia('(max-width: 899px)').matches;
    }
    return window.innerWidth < 900;
  });
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      const onResize = () => setBelow(window.innerWidth < 900);
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    const mq = window.matchMedia('(max-width: 899px)');
    const onChange = (ev: MediaQueryListEvent) => setBelow(ev.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return below;
}

/**
 * The Hearings sub-views (W1-3 IA):
 *   ?sub=schedule  the calendar + list (the landing sub-view)
 *   ?sub=sessions  My Sessions and scheduled recordings
 *   ?sub=archive   the durable historical corpus, searched server-side
 */
const HEARING_SUBS = [
  { id: 'schedule' as const, label: 'Schedule' },
  { id: 'sessions' as const, label: 'My Sessions' },
  { id: 'archive' as const, label: 'Archive' },
];
type HearingSub = (typeof HEARING_SUBS)[number]['id'];

export function HearingsTab({ scope }: { scope: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Unknown values land on the schedule rather than rendering nothing.
  const rawSub = searchParams.get('sub');
  const sub: HearingSub = HEARING_SUBS.some((s) => s.id === rawSub)
    ? (rawSub as HearingSub)
    : 'schedule';
  const setSub = (next: HearingSub) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'schedule') params.delete('sub');
    else params.set('sub', next);
    setSearchParams(params, { replace: true });
  };
  const history = useHearingSessionHistory();
  const exportWeek = useCalendarExportBulk();

  // The user's saved desktop preference (LegiWatch Settings → default view).
  const [view, setView] = useState<ViewMode>('calendar');
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => new Date());
  const [committee, setCommittee] = useState<string>('');
  const [kind, setKind] = useState<string>('');
  const [search, setSearch] = useState('');

  // PR D / LW-QA-011: below 900px the seven-day grid compresses to ~90px
  // columns — unreadable. The schedule TEMPORARILY renders agenda/list layout
  // (the LwSeg control is disabled with the reason so the state is honest).
  // The override is NEVER written back to the user's preference: returning to
  // a full-size display restores exactly what they saved. CSS already drops
  // the grid to one day per row below 780 as belt-and-braces.
  const narrow = useMediaBelow900();
  const effectiveView: ViewMode = narrow ? 'list' : view;

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
  const scheduledAttendance = rows.filter((event) => event.subscription?.scheduled);

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
  const live = useMemo(() => rows.find((e) => isLiveEvent(e)) ?? null, [rows]);

  const byDay = useMemo(() => {
    const map = new Map<number, CanonicalHearingEvent[]>();
    weekDays.forEach((_, i) => map.set(i, []));
    for (const e of filtered) {
      const idx = calendarBucketIndex(momentOfCanonicalEvent(e), weekDays);
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
    // Live and archived proceedings share the canonical transcript/intel room.
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

  // Sub-view strip (segmented control, v2 prototype) + public/private legend
  // chip. Rendered for every sub-view so navigation is always reachable.
  const subStrip = (
    <div className="lw-subtabs" role="tablist" aria-label="Hearings sub-views">
      <LwSeg
        ariaLabel="Hearing views"
        options={HEARING_SUBS.map((s) => ({ id: s.id, label: s.label }))}
        value={sub}
        onChange={(next) => setSub(next as HearingSub)}
      />
      <span className="lw-recordkey" aria-hidden="true">
        <span className="lw-recordkey__sw lw-recordkey__sw--public" />
        <span className="lw-recordkey__lab">Public record</span>
        <span className="lw-recordkey__sep" />
        <span className="lw-recordkey__sw lw-recordkey__sw--analysis" />
        <span className="lw-recordkey__lab lw-recordkey__lab--analysis">Your analysis</span>
      </span>
    </div>
  );

  if (sub === 'archive') {
    return (
      <div className="lw-body">
        {subStrip}
        {/* W1-3 — server-side search over the durable historical corpus. */}
        <ArchiveSubTab clientId={scope} />
      </div>
    );
  }

  return (
    <div className="lw-body">
      {subStrip}
      <div className={sub === 'sessions' ? 'lw-hearings-cols lw-hearings-cols--single' : 'lw-schedule'}>
        {/* Schedule sub-view is full-width (the calendar runs the whole content
            width). The Sessions sub-view keeps the two-column rail. */}
        {sub === 'sessions' ? null : (
        <div className="lw-schedule">
          <div className="lw-controls">
            <LwSeg
              ariaLabel="Schedule view"
              options={[
                { id: 'calendar' as ViewMode, label: 'Calendar' },
                { id: 'list' as ViewMode, label: 'Agenda' },
              ]}
              value={effectiveView}
              onChange={setView}
              disabled={narrow}
            />
            {narrow ? (
              <span style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                Agenda layout at this width — Calendar returns on a wider display
              </span>
            ) : null}
            <div className="lw-selectwrap">
              <select
                aria-label="Committee"
                className="lw-btn lw-select"
                value={committee}
                onChange={(e) => setCommittee(e.target.value)}
              >
                <option value="">All committees</option>
                {committees.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <ChevronDown size={14} className="lw-select__caret" aria-hidden="true" />
            </div>
            <div className="lw-selectwrap">
              <select
                aria-label="Proceeding kind"
                className="lw-btn lw-select"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="">All proceedings</option>
                <option value="HEARING">Hearings</option>
                <option value="MARKUP">Markups</option>
              </select>
              <ChevronDown size={14} className="lw-select__caret" aria-hidden="true" />
            </div>
            <div className="lw-search">
              <Search size={16} className="lw-search__icon" aria-hidden="true" />
              <input
                aria-label="Search proceedings"
                placeholder="Filter this week by title, committee or witness"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {effectiveView === 'calendar' ? (
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
                  <ChevronLeft size={15} aria-hidden="true" />
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
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
                <span className="lw-weeklabel">
                  {formatHearingDay(parseHearingMoment({ date: weekDays[0] ?? '' }))} –{' '}
                  {formatHearingDay(parseHearingMoment({ date: weekDays[6] ?? '' }))}
                </span>
                <span className="lw-card__meta">
                  {/* Honest header (LW-QA-005 review item E): the count is the
                      server total for the visible range (bounded by the first
                      page), and the secondary count is subscriptions scheduled
                      by the user — never implied to be "matches". */}
                  {visibleCount} proceedings ·{' '}
                  {serverTotal > rows.length
                    ? `showing first ${rows.length}`
                    : `${totalMatches0(rows)} scheduled by you`}
                </span>
                <LwButton
                  disabled={exportWeek.isPending}
                  onClick={() => {
                    const from = weekDays[0];
                    const to = weekDays[6];
                    if (!from || !to) return;
                    exportWeek.mutate(
                      { from, to },
                      { onSuccess: (result) => downloadIcs(result) },
                    );
                  }}
                >
                  {exportWeek.isPending ? 'Preparing…' : 'Export calendar'}
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
                          const isLive = isLiveEvent(e);
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
                          const m = momentOfCanonicalEvent(e);
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
                <span className="lw-legend__item"><span className="lw-legend__dot" style={{ background: 'var(--lw-warn-ring)' }} />Access unverified</span>
                <span className="lw-legend__item"><span className="lw-legend__dot" style={{ background: 'var(--lw-brand-dot)' }} />Capiro attending</span>
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
                  const isLive = isLiveEvent(e);
                  const m = momentOfCanonicalEvent(e);
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
                            {formatHearingDay(m).toUpperCase()} · {formatHearingTime(m)}
                          </span>
                          <LwPill tone={KIND_TONE[(e.eventType ?? 'HEARING').toUpperCase()] ?? 'brand'} size="22">
                            {(e.eventType ?? 'HEARING').toUpperCase()}
                          </LwPill>
                          {e.committee?.systemCode ? (
                            <button
                              type="button"
                              className="lw-lrow__cm"
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline dotted' }}
                              onClick={(ev) => { ev.stopPropagation(); navigate(`/legiwatch/committees/${encodeURIComponent(e.committee!.systemCode!)}`); }}
                            >
                              {e.committee.name}
                            </button>
                          ) : (
                            <span className="lw-lrow__cm">{e.committee?.name ?? ''}</span>
                          )}
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
        )}

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
                  <LwButton variant="primary" size="40" onClick={() => openHearing(live)}>
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
                const rec = ['failed-recoverable', 'failed'].includes(s.status);
                const done = ['completed', 'ended'].includes(s.status);
                const browserSession = ['browser_mic', 'browser_tab'].includes(s.audioSource);
                const path = s.hearingId && !browserSession
                  ? `/legiwatch/hearings/${encodeURIComponent(s.hearingId)}`
                  : `/intelligence/hearing-watch/${encodeURIComponent(s.id)}`;
                return (
                  <div
                    key={s.id}
                    className="lw-hrow"
                    role="button"
                    tabIndex={0}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(path)}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      navigate(path);
                    } }}
                    aria-label={`Open ${s.title}`}
                  >
                    <div>
                      <div className="lw-hrow__title">{s.title}</div>
                      <div className="lw-hrow__sub">
                        {done ? 'Completed' : rec ? 'Capture interrupted · can resume' : s.status}
                        {s.watchlistMatchCount != null ? ` · ${s.watchlistMatchCount} matches` : ''}
                      </div>
                    </div>
                    <span className="lw-hrow__pill">
                      <LwPill tone={rec ? 'warning' : done ? 'success' : 'gray'}>
                        {rec ? 'RECOVERABLE' : done ? (s.recapSaved ? 'RECAP READY' : 'COMPLETE') : s.status.toUpperCase()}
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
              <span className="lw-card__meta">Selected week</span>
            </div>
            <div className="lw-recs__rows">
              {scheduledAttendance.length === 0 ? (
                <div className="lw-recs__empty">No attendance is scheduled for the selected week. Open a hearing to check automatic or browser attendance.</div>
              ) : scheduledAttendance.map((event) => (
                <button key={event.id} type="button" className="lw-hrow" onClick={() => openHearing(event)}
                  style={{ width: '100%', border: 0, background: 'none', textAlign: 'left', cursor: 'pointer' }}>
                  <div>
                    <div className="lw-hrow__title">{event.title}</div>
                    <div className="lw-hrow__sub">{formatHearingDay(momentOfCanonicalEvent(event))} · {formatHearingTime(momentOfCanonicalEvent(event))}</div>
                  </div>
                  <LwPill tone="brand">{event.capture?.status ?? 'SCHEDULED'}</LwPill>
                </button>
              ))}
            </div>
            <div className="lw-note">
              <div className="lw-note__label">How unattended capture works</div>
              <div className="lw-note__body">
                Automatic attendance records the official stream on the server and continues when
                you leave the site. Open a hearing to check its capture status, transcript and intelligence.
                Browser attendance requires an open tab and an awake device.
              </div>
            </div>
          </section>
        </div>
      </div>


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
