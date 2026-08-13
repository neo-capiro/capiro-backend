/**
 * Hearings tab (§7.7) — the module's landing tab. Two columns: the schedule
 * (left) and sessions + scheduled recordings (right).
 *
 * Honest capability (§1.10, §6.4): direct / browser / pending / unavailable are
 * four different outcomes resolved BEFORE setup. The schedule row shows the
 * resolved capability; the setup modal offers only paths that can succeed.
 * There is no manual hearing entry anywhere (§4.1 #19) — proceedings come from
 * the source.
 *
 * Scheduled (unattended) recordings: there is no server capture-job queue
 * (GAPS LW-G2). The queue panel renders its UNAVAILABLE state honestly rather
 * than fabricating a queue — the setup modal's Unattended mode is disabled
 * with the reason named, and Attend live (browser capture) is the honest path.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useUpcomingHearings,
  useHearingSessionHistory,
  useResolveStream,
  isMediaUrl,
  type UpcomingHearing,
} from '../../../../lib/hearing-watch-api.js';
import { LwPill, LwSeg, LwButton, LwSkeleton } from '../lib/primitives.js';
import {
  LwStateEmpty,
  LwStateUnavailable,
  LwStateAllClear,
} from '../states/SystemStates.js';
import type { HearingCapability, Tone } from '../lib/types.js';
import { TranscriptionSetupModal } from '../overlays/TranscriptionSetupModal.js';

type ViewMode = 'calendar' | 'list';

/** §6.4 capability resolution. A hearing with a directly-embeddable media URL
 *  is `direct`; a page URL (or none yet resolved) is `browser`; a hearing whose
 *  session is already pending resolution is `pending`; one with no resolvable
 *  source is `unavailable`. Resolved lazily per row — capability is not a
 *  stored field (GAPS LW-G10). */
function capabilityOf(h: UpcomingHearing): HearingCapability {
  if (h.url && isMediaUrl(h.url)) return 'direct';
  if (h.url) return 'browser';
  if (h.sessionStatus === 'pending') return 'pending';
  return 'unavailable';
}

const KIND_TONE: Record<string, Tone> = { HEARING: 'brand', MARKUP: 'gray' };

/** The Monday-start week containing `anchor`. */
export function weekOf(anchor: Date): Date[] {
  const d = new Date(anchor);
  const day = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d);
    x.setDate(d.getDate() + i);
    return x;
  });
}

const WEEKDAY = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function HearingsTab({ scope }: { scope: string }) {
  const navigate = useNavigate();
  const upcoming = useUpcomingHearings();
  const history = useHearingSessionHistory();
  const resolveStream = useResolveStream();

  const [view, setView] = useState<ViewMode>('calendar');
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => new Date());
  const [committee, setCommittee] = useState<string>('');
  const [kind, setKind] = useState<string>('');
  const [search, setSearch] = useState('');
  const [setupHearing, setSetupHearing] = useState<UpcomingHearing | null>(null);

  const hearings = useMemo(() => upcoming.data ?? [], [upcoming.data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return hearings.filter((h) => {
      if (committee && !(h.committee ?? '').toLowerCase().includes(committee.toLowerCase())) return false;
      if (kind && (h.type ?? 'HEARING').toUpperCase() !== kind) return false;
      if (q && !(`${h.title} ${h.committee}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [hearings, committee, kind, search]);

  const week = useMemo(() => weekOf(weekAnchor), [weekAnchor]);
  const today = useMemo(() => new Date(), []);
  const byDay = useMemo(() => {
    const map = new Map<number, UpcomingHearing[]>();
    week.forEach((d, i) => map.set(i, []));
    for (const h of filtered) {
      const d = new Date(h.scheduledAt);
      const idx = week.findIndex((wd) => sameDay(wd, d));
      if (idx >= 0) map.get(idx)!.push(h);
    }
    for (const list of map.values()) list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    return map;
  }, [filtered, week]);

  const live = useMemo(() => hearings.find((h) => h.sessionStatus === 'live') ?? null, [hearings]);
  const nextUpcoming = useMemo(() => {
    const now = Date.now();
    return (
      [...hearings]
        .filter((h) => (h.watchlistMatchCount ?? 0) > 0 && new Date(h.scheduledAt).getTime() > now)
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0] ?? null
    );
  }, [hearings]);

  const weekStart = week[0] ?? new Date();
  const weekEnd = week[6] ?? new Date();
  const weekLabel = `${weekStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – ${weekEnd.toLocaleDateString('en-US', { day: 'numeric', year: 'numeric' })}`;
  const totalMatches = filtered.reduce((n, h) => n + (h.watchlistMatchCount ?? 0), 0);

  const committees = useMemo(
    () => Array.from(new Set(hearings.map((h) => h.committee).filter(Boolean))) as string[],
    [hearings],
  );

  const openHearing = (h: UpcomingHearing) => {
    const cap = capabilityOf(h);
    if (cap === 'unavailable') return; // muted, non-routing (§7.7)
    if (h.sessionStatus === 'live' && h.sessionId) {
      navigate(`/intelligence/hearing-watch/${h.sessionId}`);
      return;
    }
    setSetupHearing(h);
  };

  if (upcoming.isLoading) {
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

  if (upcoming.isError) {
    return (
      <div className="lw-body">
        <LwStateUnavailable
          source="Hearing schedule"
          reason="The committee schedule source could not be loaded. Sessions and recordings below are unaffected."
          onRetry={() => void upcoming.refetch()}
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
                <span className="lw-weeklabel">{weekLabel}</span>
                <span className="lw-card__meta">
                  {filtered.length} proceedings · {totalMatches} client matches
                </span>
                <LwButton
                  onClick={() => {
                    /* §7.7: export only watchlist-matched proceedings */
                    const matched = filtered.filter((h) => (h.watchlistMatchCount ?? 0) > 0);
                    const ics = matched
                      .map((h) => `${new Date(h.scheduledAt).toISOString()} — ${h.title} (${h.committee})`)
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
                {week.map((day, i) => {
                  const list = byDay.get(i) ?? [];
                  const isToday = sameDay(day, today);
                  return (
                    <div key={day.toISOString()} className={`lw-cal__day${isToday ? ' is-today' : ''}`}>
                      <div className="lw-cal__dayhead">
                        <span className="lw-cal__weekday">{WEEKDAY[i]}</span>
                        <span className="lw-cal__date">{day.getDate()}</span>
                      </div>
                      {list.length === 0 ? (
                        <span className="lw-cal__empty">No proceedings</span>
                      ) : (
                        list.map((h) => {
                          const isLive = h.sessionStatus === 'live';
                          const cap = capabilityOf(h);
                          const queued = Boolean(h.sessionId) && h.sessionStatus === 'scheduled';
                          const kindCls =
                            cap === 'unavailable'
                              ? 'lw-chip--unavailable'
                              : isLive
                                ? 'lw-chip--live'
                                : (h.type ?? 'HEARING').toUpperCase() === 'MARKUP'
                                  ? 'lw-chip--markup'
                                  : 'lw-chip--hearing';
                          return (
                            <button
                              key={h.id}
                              type="button"
                              className={`lw-chip ${kindCls}`}
                              onClick={() => openHearing(h)}
                              disabled={cap === 'unavailable'}
                              aria-label={`${h.title}, ${h.committee}, ${timeLabel(h.scheduledAt)}`}
                            >
                              <span className="lw-chip__row">
                                <span className="lw-chip__time">{timeLabel(h.scheduledAt)}</span>
                                {isLive || queued ? (
                                  <span
                                    className="lw-chip__marker"
                                    style={{ background: isLive ? 'var(--lw-error-dot)' : 'var(--lw-brand-dot)' }}
                                    aria-hidden="true"
                                  />
                                ) : null}
                              </span>
                              <span className="lw-chip__title">{h.title}</span>
                              <span className="lw-chip__meta">
                                {h.committee}
                                {(h.watchlistMatchCount ?? 0) > 0 ? ` · ${h.watchlistMatchCount} MATCHES` : ''}
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
                <h2 className="lw-card__title">Upcoming schedule</h2>
                <span className="lw-card__meta">{filtered.length} proceedings</span>
              </div>
              {filtered.length === 0 ? (
                <div style={{ padding: 18 }}>
                  <LwStateEmpty onReset={() => { setCommittee(''); setKind(''); setSearch(''); }} />
                </div>
              ) : (
                filtered.map((h) => {
                  const isLive = h.sessionStatus === 'live';
                  const cap = capabilityOf(h);
                  const queued = Boolean(h.sessionId) && h.sessionStatus === 'scheduled';
                  const verb = isLive
                    ? 'OPEN LIVE ROOM'
                    : queued
                      ? 'RECORDING SCHEDULED'
                      : cap === 'unavailable'
                        ? 'RECORDING UNAVAILABLE'
                        : 'SCHEDULE RECORDING';
                  return (
                    <div key={h.id} className={`lw-lrow${isLive ? ' is-live' : ''}`}>
                      <div className="lw-lrow__main">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <span className="lw-lrow__when">
                            {new Date(h.scheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()} · {timeLabel(h.scheduledAt)}
                          </span>
                          <LwPill tone={KIND_TONE[(h.type ?? 'HEARING').toUpperCase()] ?? 'brand'} size="22">
                            {(h.type ?? 'HEARING').toUpperCase()}
                          </LwPill>
                          <span className="lw-lrow__cm">{h.committee}</span>
                        </div>
                        <div className="lw-lrow__title">{h.title}</div>
                        <div className="lw-lrow__match">
                          {(h.watchlistMatchCount ?? 0) > 0 ? `${h.watchlistMatchCount} CLIENT MATCHES` : 'NO CLIENT MATCHES'}
                        </div>
                      </div>
                      <div className="lw-lrow__side">
                        <LwPill tone={cap === 'unavailable' ? 'gray' : cap === 'pending' ? 'warning' : 'success'} size="26">
                          {cap === 'direct' || cap === 'browser' ? 'AVAILABLE' : cap.toUpperCase()}
                        </LwPill>
                        <button
                          type="button"
                          className="lw-lrow__verb"
                          disabled={cap === 'unavailable'}
                          onClick={() => openHearing(h)}
                        >
                          {verb} →
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
                {live ? '1 live' : 'None live'} · {history.data?.pages?.[0]?.total ?? hearings.length} total
              </span>
            </div>

            {live ? (
              <div className="lw-session lw-on-ink">
                <span className="lw-session__badge">
                  <span className="lw-session__dot is-live" aria-hidden="true" />
                  LIVE · {liveClock(live)}
                </span>
                <div className="lw-session__title">{live.title}</div>
                <div className="lw-session__sub">
                  {live.committee} · {live.watchlistMatchCount ?? 0} clients
                </div>
                <div className="lw-session__actions">
                  <LwButton
                    variant="primary"
                    size="40"
                    onClick={() => live.sessionId && navigate(`/intelligence/hearing-watch/${live.sessionId}`)}
                  >
                    Open live room →
                  </LwButton>
                  <LwButton size="40" onClick={() => setSetupHearing(live)}>
                    End session
                  </LwButton>
                </div>
              </div>
            ) : nextUpcoming ? (
              <div className="lw-session lw-on-ink">
                <span className="lw-session__badge">
                  <span className="lw-session__dot is-next" aria-hidden="true" />
                  NEXT SESSION · {startsIn(nextUpcoming.scheduledAt)}
                </span>
                <div className="lw-session__title">{nextUpcoming.title}</div>
                <div className="lw-session__sub">
                  {nextUpcoming.committee} · {timeLabel(nextUpcoming.scheduledAt)}
                </div>
                <div className="lw-session__body">
                  Nothing is live right now. This is the next proceeding on your watchlist.
                </div>
                <div className="lw-session__actions">
                  <LwButton variant="primary" size="40" onClick={() => setSetupHearing(nextUpcoming)}>
                    {nextUpcoming.sessionId && nextUpcoming.sessionStatus === 'scheduled'
                      ? 'Recording scheduled'
                      : 'Schedule recording'}
                  </LwButton>
                  <LwButton size="40" onClick={() => setView('calendar')}>View schedule</LwButton>
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
          hearing={setupHearing}
          capability={capabilityOf(setupHearing)}
          resolveStream={resolveStream}
          onClose={() => setSetupHearing(null)}
        />
      ) : null}
    </div>
  );
}

function liveClock(h: UpcomingHearing): string {
  if (!h.scheduledAt) return '00:00:00';
  const ms = Date.now() - new Date(h.scheduledAt).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function startsIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'NOW';
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  return h > 0 ? `STARTS IN ${h}H ${min % 60}M` : `STARTS IN ${min}M`;
}
