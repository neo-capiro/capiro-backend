/**
 * Hill Day Wizard — /workspace/documents/new.
 *
 * Six steps, exactly the prototype's FLOW section: Template, Sponsor,
 * Meetings, Resolution, Context, Generate. Forward navigation always allowed;
 * the rail permits jumping back to any completed step; the sticky footer
 * carries the forward contract. State and copy mirror hill-day.dcscript.js.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { hillDayApi } from './api.js';
import { BLUEPRINTS, DOW_COLUMNS, DAY_LABELS, SPONSOR_SUPPLIES } from './fixtures.js';
import { HdIcon, HdPill, HdPrimary, HdSecondary } from './ui.js';

const STEP_LABELS = ['Template', 'Sponsor', 'Meetings', 'Resolution', 'Context', 'Generate'];

const FOOTER_NOTES = [
  'Blueprint decides the questions and the sections.',
  'Calendar and objectives come from the sponsor.',
  undefined, // computed per selection count
  undefined, // computed per resolution gaps
  'Context is optional. Threads outside 90 days are excluded.',
  undefined, // computed per run state
] as const;

export function HillDayWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const [view, setView] = useState<'cal' | 'list'>('cal');
  const [clientId, setClientId] = useState('kela');
  const [docName, setDocName] = useState('Kela Systems Hill Day Schedule');
  const [selected, setSelected] = useState<string[]>(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  const [ctxId, setCtxId] = useState('m1');
  const [notes, setNotes] = useState<Record<string, string>>({
    m1: 'Perrine asked for unit cost at rate in June and we never sent it. Bring the one-pager and do not re-litigate the fleet-count argument — he already agrees.',
  });
  const [threadSel, setThreadSel] = useState<string[]>(['t1', 't2', 't4']);
  const [carry, setCarry] = useState<Record<string, boolean>>({});
  const [fixed, setFixed] = useState<string[]>([]);
  const [fixOpen, setFixOpen] = useState<string[]>([]);
  const [done, setDone] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const meetingsQuery = useQuery({
    queryKey: ['hd', 'meetings'],
    queryFn: () => hillDayApi.listMeetings(),
    staleTime: 60_000,
  });
  const clientsQuery = useQuery({
    queryKey: ['hd', 'clients'],
    queryFn: () => hillDayApi.listClients(),
    staleTime: 60_000,
  });
  const meetings = meetingsQuery.data ?? [];
  const clients = clientsQuery.data ?? [];

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1200);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startRun = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setDone(0);
    timerRef.current = setInterval(() => {
      setDone((d) => {
        const n = d + 1;
        if (n >= 6 && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return Math.min(n, 6);
      });
    }, 620);
  };

  const go = (s: number) => {
    const clamped = Math.max(0, Math.min(5, s));
    setStep(clamped);
    if (clamped === 5) startRun();
  };

  const toggle = (id: string) =>
    setSelected((arr) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]));

  const hillMeetings = useMemo(
    () => meetings.filter((m) => selected.includes(m.id) && m.kind === 'hill'),
    [meetings, selected],
  );

  // Carry-over: server-supplied defaults per requirements §5 — committees on,
  // top two issue areas on, bio off, staffers with a Directory record on.
  const carryOn = (key: string, def: boolean) => {
    const v = carry[key];
    return v === undefined ? def : v;
  };
  const carryToggle = (key: string, def: boolean) =>
    setCarry((c) => ({ ...c, [key]: !carryOn(key, def) }));

  const ctxMeeting = hillMeetings.find((m) => m.id === ctxId) ?? hillMeetings[0];
  const ctxDir = ctxMeeting ? hillDayApi.memberDirectorySync(ctxMeeting.id) : null;
  const dirStaff = ctxDir?.staff ?? {};
  const ctxIssues = (ctxDir?.issues ?? []).map((label, i) => ({
    label,
    on: carryOn(`${ctxMeeting?.id}|iss${i}`, i < 2),
    toggle: () => carryToggle(`${ctxMeeting?.id}|iss${i}`, i < 2),
  }));
  const ctxStaff = (ctxMeeting?.att ?? []).map((a) => {
    const rec = dirStaff[a.name];
    const known = Boolean(rec);
    return {
      name: a.name,
      known,
      on: carryOn(`${ctxMeeting?.id}|st:${a.name}`, known),
      toggle: () => carryToggle(`${ctxMeeting?.id}|st:${a.name}`, known),
      role: rec
        ? rec.role
        : a.state === 'scheduler'
          ? 'Scheduling address — no substantive attendee yet'
          : 'No Directory record for this address',
      topics: rec?.topics ?? [],
      icon: known ? ('User01' as const) : a.state === 'stale' ? ('AlertTriangle' as const) : ('HelpCircle' as const),
      warn: !known,
    };
  });
  const rowCmte = {
    on: carryOn(`${ctxMeeting?.id}|cmte`, true),
    toggle: () => carryToggle(`${ctxMeeting?.id}|cmte`, true),
  };
  const rowBio = {
    on: carryOn(`${ctxMeeting?.id}|bio`, false),
    toggle: () => carryToggle(`${ctxMeeting?.id}|bio`, false),
  };
  const carryTotal = 2 + ctxIssues.length + ctxStaff.length;
  const carryUsed =
    (rowCmte.on ? 1 : 0) + (rowBio.on ? 1 : 0) + ctxIssues.filter((i) => i.on).length + ctxStaff.filter((p) => p.on).length;

  // Resolution roll-up
  const stateMeta: Record<string, { label: string; ok: boolean; fix: string; fixIcon: Parameters<typeof HdIcon>[0]['name'] }> = {
    resolved: { label: 'Resolved', ok: true, fix: '', fixIcon: 'Check' },
    unresolved: { label: 'No Directory match', ok: false, fix: 'Create Directory record', fixIcon: 'UserCheck01' },
    scheduler: { label: 'Scheduler only', ok: false, fix: 'Add attendee', fixIcon: 'Plus' },
    stale: { label: 'Office may be stale', ok: false, fix: 'Use this office', fixIcon: 'Check' },
  };
  const resolveCards = hillMeetings.map((m) => {
    const atts = (m.att ?? []).map((a) => {
      const meta =
        stateMeta[a.state] ??
        ({ label: a.state, ok: false, fix: 'Resolve', fixIcon: 'Check' } as const);
      const isFixed = fixed.includes(m.id + a.name);
      const open = fixOpen.includes(m.id + a.name);
      return {
        key: m.id + a.name,
        name: a.name,
        detail: isFixed
          ? 'Confirmed by you. Overrides the Directory record for this document.'
          : a.detail,
        stateLabel: isFixed ? 'Confirmed' : meta.label,
        ok: isFixed || meta.ok,
        fixLabel: meta.fix,
        fixIcon: meta.fixIcon,
        needsFix: !meta.ok && !isFixed,
        open,
        fix: () => {
          setFixed((f) => [...f, m.id + a.name]);
          setFixOpen((o) => o.filter((k) => k !== m.id + a.name));
        },
        openFix: () => setFixOpen((o) => (o.includes(m.id + a.name) ? o : [...o, m.id + a.name])),
      };
    });
    const bad = atts.filter((a) => !a.ok).length;
    return { m, atts, bad };
  });
  const gaps = resolveCards.reduce((n, c) => n + c.bad, 0);
  const totalAtt = hillMeetings.reduce((n, m) => n + (m.att?.length ?? 0), 0);

  const selCount = selected.length;
  const runDone = done >= 6;
  const footers = [
    'Blueprint decides the questions and the sections.',
    'Calendar and objectives come from the sponsor.',
    `${selCount} of ${meetings.length} meetings selected · ${selCount} prep sections will be written.`,
    gaps
      ? `${gaps} of ${totalAtt} attendees still need input. You can generate anyway.`
      : `${totalAtt} attendees resolved.`,
    'Context is optional. Threads outside 90 days are excluded.',
    runDone
      ? 'Six prep sections drafted. Nothing is applied until you open the document.'
      : 'Meri is drafting. You can leave and come back.',
  ];
  const nextLabels = [
    'Continue',
    'Open calendar',
    'Resolve attendees',
    'Add context',
    'Generate packet',
    runDone ? 'Open document' : 'Generating…',
  ];

  const weekCols = DOW_COLUMNS.map(([dow, num], i) => ({
    dow,
    num,
    hill: i === 2,
    items: meetings.filter((m) => m.day === i),
  }));
  const listGroups = DOW_COLUMNS.map(([, num], i) => ({
    label: `${DAY_LABELS[i]}, September ${num}${i === 2 ? ' · Hill Day' : ''}`,
    items: meetings.filter((m) => m.day === i),
  })).filter((g) => g.items.length);

  const runRows = hillMeetings.map((m, i) => {
    const st = i < done ? 'done' : i === done ? 'running' : 'queued';
    return {
      m,
      st,
      icon: st === 'done' ? 'CheckCircle' : st === 'running' ? 'Loading01' : 'Clock',
      status: st === 'done' ? 'Focus + Background' : st === 'running' ? 'Drafting…' : 'Queued',
    } as const;
  });

  return (
    <div className="hd-root" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', background: 'var(--hd-canvas)' }}>
    <div className="hd-flow">
      {/* Sticky top bar with the step rail */}
      <div className="hd-flow__topbar">
        <button type="button" className="hd-icon-btn" onClick={() => navigate('/workspace/documents')} aria-label="Back to documents">
          <HdIcon name="FlipBackward" size={18} />
        </button>
        <span className="hd-flow__crumb">
          <span className="hd-flow__crumb-title">New document</span>
          <span className="hd-flow__crumb-sub">Hill Day Schedule · Kela Systems</span>
        </span>
        <span className="hd-flow__compact-chip">
          Step {step + 1} of 6 · {STEP_LABELS[step]}
        </span>
        <div className={`hd-flow__rail${narrow ? ' hd-flow__rail--hidden' : ''}`}>
          {STEP_LABELS.map((label, i) => (
            <button
              key={label}
              type="button"
              className={[
                'hd-step',
                i === step ? 'hd-step--current' : '',
                i < step ? 'hd-step--past' : '',
                i > step + 1 ? 'hd-step--skipped' : '',
              ].join(' ')}
              onClick={() => i <= step + 1 && go(i)}
              aria-current={i === step ? 'step' : undefined}
            >
              <span className="hd-step__num">{i + 1}</span>
              <span className="hd-step__label">{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="hd-flow__body">
        {/* Step 1 · Template */}
        {step === 0 && (
          <div style={{ maxWidth: 1080 }}>
            <h2 className="hd-step-heading">What are you making?</h2>
            <p className="hd-step-sub" style={{ maxWidth: '60ch' }}>
              The template decides which layers the document reads from and which questions you are
              asked before it is drafted.
            </p>
            <div className="hd-pick-grid">
              {BLUEPRINTS.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className={`hd-pick-card${t.isNew ? ' hd-pick-card--on' : ''}`}
                  onClick={() => go(1)}
                >
                  <span style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <span
                      className={`hd-template-card__icon${t.isNew ? '' : ' hd-template-card__icon--plain'}`}
                      style={t.isNew ? undefined : { color: 'var(--hd-gray-600)' }}
                    >
                      <HdIcon name={t.icon} size={20} />
                    </span>
                    <span className={`hd-radio${t.isNew ? ' hd-radio--on' : ''}`}>
                      <span className="hd-radio__dot" style={{ display: t.isNew ? 'block' : 'none' }} />
                    </span>
                  </span>
                  <span style={{ display: 'block' }}>
                    <span className="hd-template-card__name">{t.name}</span>
                    <span className="hd-template-card__desc">{t.desc}</span>
                  </span>
                  <span className="hd-pick-card__sources">
                    {t.sources.map((src) => (
                      <span key={src} className="hd-source-badge">
                        {src}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 2 · Sponsor */}
        {step === 1 && (
          <div className="hd-sponsor-grid">
            <div>
              <h2 className="hd-step-heading">Who is the sponsor?</h2>
              <p className="hd-step-sub" style={{ maxWidth: '60ch' }}>
                The sponsoring client scopes the calendar, supplies the objectives the narrative is
                written against, and provides the logo the packet is co-branded with.
              </p>
              <div className="hd-client-list">
                <div className="hd-client-list__search">
                  <HdIcon name="SearchLg" size={18} />
                  <input type="text" placeholder="Search Portfolio clients…" aria-label="Search clients" />
                  <span className="hd-eyebrow">14 clients</span>
                </div>
                {clients.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`hd-client-row${clientId === c.id ? ' hd-client-row--on' : ''}`}
                    onClick={() => {
                      setClientId(c.id);
                      setDocName(`${c.name} Hill Day Schedule`);
                    }}
                  >
                    <span className="hd-client-row__mono">{c.mono}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="hd-client-row__name">{c.name}</span>
                      <span className="hd-client-row__meta">{c.meta}</span>
                    </span>
                    {clientId === c.id && (
                      <span style={{ color: 'var(--hd-brand-600)', display: 'flex' }}>
                        <HdIcon name="CheckCircle" size={20} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="hd-name-field">
                <label htmlFor="hd-doc-name">Document name</label>
                <input
                  id="hd-doc-name"
                  type="text"
                  value={docName}
                  onChange={(e) => setDocName(e.target.value)}
                />
                <span className="hd-name-field__hint">
                  Prefilled from the sponsor. Editable now and after generation.
                </span>
              </div>
            </div>
            <aside className="hd-supplies">
              <span className="hd-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--hd-gray-500)' }}>
                <HdIcon name="Stars02" size={14} />
                What the sponsor supplies
              </span>
              <div className="hd-supplies__list">
                {SPONSOR_SUPPLIES.map((s) => (
                  <span key={s.title} className="hd-supplies__item">
                    <span className="hd-supplies__dot" />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="hd-supplies__title">{s.title}</span>
                      <span className="hd-supplies__body">{s.body}</span>
                    </span>
                  </span>
                ))}
              </div>
            </aside>
          </div>
        )}

        {/* Step 3 · Meetings */}
        {step === 2 && (
          <div style={{ maxWidth: 1360 }}>
            <div className="hd-meetings-head">
              <div style={{ minWidth: 0 }}>
                <h2 className="hd-step-heading">Which meetings go in the packet?</h2>
                <p className="hd-step-sub" style={{ maxWidth: '70ch' }}>
                  Calendar scoped to Kela Systems, week of September 14. Meetings surface when an
                  attendee address matches a Directory staffer record, or when the event is tagged
                  to the client.
                </p>
              </div>
              <div className="hd-meetings-controls">
                <div className="hd-segmented">
                  <button
                    type="button"
                    className={`hd-segmented__item${view === 'cal' ? ' hd-segmented__item--on' : ''}`}
                    onClick={() => setView('cal')}
                  >
                    <HdIcon name="Calendar2" size={16} />
                    Calendar
                  </button>
                  <button
                    type="button"
                    className={`hd-segmented__item${view === 'list' ? ' hd-segmented__item--on' : ''}`}
                    onClick={() => setView('list')}
                  >
                    <HdIcon name="List" size={16} />
                    List
                  </button>
                </div>
                <span className="hd-sel-count">{selCount} of {meetings.length} selected</span>
              </div>
            </div>

            {view === 'cal' && (
              <div className="hd-week">
                {weekCols.map((col) => (
                  <div key={col.dow} className={`hd-week__col${col.hill ? ' hd-week__col--hill' : ''}`}>
                    <div className={`hd-week__head${col.hill ? ' hd-week__head--hill' : ''}`}>
                      <span className="hd-week__dow">{col.dow}</span>
                      <span className="hd-week__num">{col.num}</span>
                      <span className="hd-week__count">{col.items.length || '—'}</span>
                    </div>
                    <div className="hd-week__body">
                      {col.items.map((m) => {
                        const on = selected.includes(m.id);
                        const internal = m.kind === 'internal';
                        return (
                          <button
                            key={m.id}
                            type="button"
                            className={`hd-cal-card${on ? ' hd-cal-card--on' : ''}`}
                            onClick={() => toggle(m.id)}
                          >
                            <span className="hd-cal-card__meta">
                              <span className={`hd-checkbox${on ? ' hd-checkbox--on' : ''}`} style={{ width: 14, height: 14 }}>
                                <span
                                  className="hd-checkbox__tick"
                                  style={{ width: 7, height: 7, display: on ? 'block' : 'none' }}
                                />
                              </span>
                              <span className="hd-cal-card__time">{m.time}</span>
                              <span className="hd-cal-card__dur">{m.dur}</span>
                            </span>
                            <span className="hd-cal-card__short">{m.short}</span>
                            <span className="hd-cal-card__place">{m.place}</span>
                          </button>
                        );
                      })}
                      {col.items.length === 0 && <span className="hd-week__empty">No meetings</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {view === 'list' && (
              <div className="hd-list">
                {listGroups.map((g) => (
                  <div key={g.label}>
                    <div className="hd-list__group">{g.label}</div>
                    {g.items.map((m) => {
                      const on = selected.includes(m.id);
                      const internal = m.kind === 'internal';
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className={`hd-list__row${on ? ' hd-list__row--on' : ''}`}
                          onClick={() => toggle(m.id)}
                        >
                          <span style={{ flex: '0 0 auto', display: 'flex' }}>
                            <span
                              className={`hd-checkbox${on ? ' hd-checkbox--on' : ''}`}
                              style={{ width: 18, height: 18, borderRadius: 5 }}
                            >
                              <span
                                className="hd-checkbox__tick"
                                style={{ width: 11, height: 11, display: on ? 'block' : 'none' }}
                              />
                            </span>
                          </span>
                          <span className="hd-list__time">{m.time}</span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span className="hd-list__subject">{m.subject}</span>
                            <span className="hd-list__meta">
                              {internal
                                ? `Internal · ${m.place}`
                                : `${m.att?.length ?? 0} attendees · ${m.place}`}
                            </span>
                          </span>
                          <span style={{ flex: '0 0 auto', display: 'flex' }}>
                            <HdPill tone={internal ? 'gray' : on ? 'navy' : 'gray'}>
                              {internal ? 'Internal' : on ? 'In packet' : 'Available'}
                            </HdPill>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 4 · Resolution */}
        {step === 3 && (
          <div className="hd-resolve">
            <h2 className="hd-step-heading">Confirm what we resolved</h2>
            <p className="hd-step-sub">
              Attendee address → Directory staffer → office → member. Members are almost never on
              the invite; the member is derived from the staffer's office association, not from the
              attendee list. Your corrections govern.
            </p>
            <div className={`hd-resolve__banner${gaps ? ' hd-resolve__banner--warn' : ''}`}>
              <span className="hd-resolve__banner-icon">
                <HdIcon name={gaps ? 'AlertTriangle' : 'CheckCircle'} size={18} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="hd-resolve__banner-title">
                  {gaps
                    ? `${totalAtt - gaps} of ${totalAtt} attendees resolved`
                    : `All ${totalAtt} attendees resolved`}
                </span>
                <span className="hd-resolve__banner-body">
                  {gaps
                    ? 'Partial resolution proceeds. Unresolved attendees are flagged here, not dropped — type a name and role, or create the Directory record.'
                    : 'Every attendee mapped to a Directory record and an office. Your overrides govern.'}
                </span>
              </span>
              {gaps > 0 && <HdSecondary className="hd-resolve__banner-btn">Jump to first gap</HdSecondary>}
            </div>

            <div className="hd-resolve-cards">
              {resolveCards.map(({ m, atts, bad }) => (
                <div key={m.id} className={`hd-resolve-card${bad ? ' hd-resolve-card--warn' : ''}`}>
                  <div className={`hd-resolve-card__head${bad ? ' hd-resolve-card__head--warn' : ''}`}>
                    <span className="hd-resolve-card__time">{m.time}</span>
                    <span className="hd-resolve-card__vsep" />
                    <span className="hd-resolve-card__member">{m.member}</span>
                    <span style={{ flex: '0 0 auto', display: 'flex' }}>
                      <HdPill tone={bad ? 'warn' : 'ok'}>{bad ? `${bad} needs input` : 'Resolved'}</HdPill>
                    </span>
                  </div>
                  <div className="hd-resolve-card__cols">
                    <div className="hd-resolve-card__office">
                      <span className="hd-eyebrow">Resolved office</span>
                      <div className="hd-resolve-card__office-facts">
                        {[
                          { k: 'Member', v: m.member ?? '', w: 600 },
                          { k: 'Party · state', v: m.party ?? '', w: 500 },
                          { k: 'Location', v: m.room ?? '', w: 500 },
                          { k: 'Committees', v: m.cmte ?? '', w: 500 },
                          { k: 'Duration', v: m.dur ?? '', w: 500 },
                        ].map((f) => (
                          <span key={f.k} className="hd-fact-row">
                            <span className="hd-fact-row__k">{f.k}</span>
                            <span className="hd-fact-row__v" style={{ fontWeight: f.w }}>
                              {f.v}
                            </span>
                          </span>
                        ))}
                      </div>
                      <button type="button" className="hd-resolve-card__change-office">
                        <HdIcon name="SwitchHorizontal01" size={15} />
                        Change office
                      </button>
                    </div>
                    <div className="hd-resolve-card__atts">
                      <span className="hd-resolve-card__atts-head">
                        <span className="hd-eyebrow">Attendees</span>
                        <span className="hd-resolve-card__atts-meta">
                          {m.att?.length ?? 0} on the invite · 90-day history
                        </span>
                      </span>
                      <div className="hd-att-list">
                        {atts.map((a) => (
                          <div
                            key={a.key}
                            className={[
                              'hd-att',
                              a.open ? 'hd-att--fix-open' : '',
                              a.needsFix ? 'hd-att--needs-fix hd-att--warn' : '',
                            ].join(' ')}
                          >
                            <span className="hd-att__row">
                              <span className={`hd-att__icon hd-att__icon--${a.ok ? 'ok' : 'warn'}`}>
                                <HdIcon name={a.ok ? 'CheckCircle' : a.fixIcon === 'Plus' ? 'ClockRewind' : a.fixIcon === 'UserCheck01' ? 'HelpCircle' : 'ClockRewind'} size={16} />
                              </span>
                              <span className="hd-att__name">{a.name}</span>
                              <span className={`hd-att__state${a.ok ? ' hd-att__state--ok' : ''}`}>
                                {a.stateLabel}
                              </span>
                            </span>
                            <span className="hd-att__detail">{a.detail}</span>
                            <span className="hd-att__fix">
                              <input type="text" placeholder="Full name" aria-label="Full name" />
                              <input type="text" placeholder="Title or role" aria-label="Title or role" />
                              <button type="button" className="hd-att__fix-btn" onClick={a.open ? a.fix : a.openFix}>
                                <HdIcon name={a.fixIcon} size={15} />
                                {a.open ? a.fixLabel : 'Resolve'}
                              </button>
                            </span>
                          </div>
                        ))}
                      </div>
                      <button type="button" className="hd-resolve-card__add-att">
                        <HdIcon name="Plus" size={15} />
                        Add attendee manually
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 5 · Context */}
        {step === 4 && ctxMeeting && (
          <div className="hd-context">
            <h2 className="hd-step-heading">Add what we don't know</h2>
            <p className="hd-step-sub">
              Per meeting: anything you know that the platform does not, plus the correspondence you
              want the narrative written from. Threads are scoped to the resolved attendees or
              tagged to Kela Systems.
            </p>
            <div className="hd-context__grid">
              <div className="hd-context__rail">
                <div className="hd-context__rail-head hd-eyebrow">{hillMeetings.length} meetings</div>
                {hillMeetings.map((m) => {
                  const on = m.id === ctxMeeting.id;
                  const noteLen = (notes[m.id] ?? '').length;
                  const th = (hillDayApi.listThreadsSync(m.id) ?? []).filter((t) => threadSel.includes(t.id)).length;
                  const badge =
                    (noteLen ? 'NOTE' : '') +
                    (noteLen && th ? ' · ' : '') +
                    (th ? `${th} ${th === 1 ? 'THREAD' : 'THREADS'}` : '') || '—';
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={`hd-context__rail-row${on ? ' hd-context__rail-row--on' : ''}`}
                      onClick={() => setCtxId(m.id)}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="hd-context__rail-time">{m.time}</span>
                        <span className="hd-context__rail-member">{m.member}</span>
                      </span>
                      <span className={`hd-context__rail-badge${noteLen || th ? ' hd-context__rail-badge--on' : ''}`}>
                        {badge}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="hd-context__main">
                <div className="hd-carry">
                  <div className="hd-carry__head">
                    <HdIcon name="Users01" size={16} />
                    <span
                      className="hd-eyebrow"
                      style={{ flex: '1 1 auto', whiteSpace: 'nowrap', color: 'var(--hd-gray-500)' }}
                    >
                      What the record already carries
                    </span>
                    <span className="hd-carry__meta">
                      {carryUsed} of {carryTotal} details carried
                    </span>
                  </div>
                  <div className="hd-carry__body">
                    <span className="hd-carry__member-row">
                      <span className="hd-carry__member">{ctxMeeting.member}</span>
                      <span className="hd-carry__party">{ctxMeeting.party}</span>
                    </span>
                    <span className="hd-carry__hint">
                      Tick what should reach the draft. Anything left unticked stays in the Directory
                      record and out of this document.
                    </span>
                    <div className="hd-carry__rows">
                      <button
                        type="button"
                        className={`hd-carry__row${rowCmte.on ? ' hd-carry__row--on' : ''}`}
                        onClick={rowCmte.toggle}
                      >
                        <span className="hd-carry__row-label">
                          <span className={`hd-checkbox${rowCmte.on ? ' hd-checkbox--on' : ''}`} style={{ width: 16, height: 16 }}>
                            <span className="hd-checkbox__tick" style={{ width: 9, height: 9, display: rowCmte.on ? 'block' : 'none' }} />
                          </span>
                          Committees
                        </span>
                        <span className="hd-carry__row-value">{ctxMeeting.cmte}</span>
                      </button>
                      <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', padding: 8 }}>
                        <span className="hd-carry__row-label">Issue areas</span>
                        <span className="hd-carry__issues">
                          {ctxIssues.map((iss) => (
                            <button
                              key={iss.label}
                              type="button"
                              className={`hd-issue-chip${iss.on ? ' hd-issue-chip--on' : ''}`}
                              onClick={iss.toggle}
                            >
                              <span style={{ display: 'flex', marginTop: 1 }}>
                                <HdIcon name={iss.on ? 'Check' : 'Plus'} size={13} />
                              </span>
                              <span style={{ minWidth: 0 }}>{iss.label}</span>
                            </button>
                          ))}
                        </span>
                      </div>
                      <button
                        type="button"
                        className={`hd-carry__row${rowBio.on ? ' hd-carry__row--on' : ''}`}
                        onClick={rowBio.toggle}
                      >
                        <span className="hd-carry__row-label">
                          <span className={`hd-checkbox${rowBio.on ? ' hd-checkbox--on' : ''}`} style={{ width: 16, height: 16 }}>
                            <span className="hd-checkbox__tick" style={{ width: 9, height: 9, display: rowBio.on ? 'block' : 'none' }} />
                          </span>
                          Bio
                        </span>
                        <span className="hd-carry__row-value">{ctxDir?.bio}</span>
                      </button>
                    </div>
                    <div className="hd-carry__staffers-head">
                      <span className="hd-eyebrow">Staffers in the room</span>
                      <span className="hd-carry__meta">
                        {ctxStaff.length
                          ? `${ctxStaff.filter((p) => p.on).length} of ${ctxStaff.length} included`
                          : 'No attendees resolved yet'}
                      </span>
                    </div>
                    <div className="hd-carry__staffers">
                      {ctxStaff.map((p) => (
                        <button
                          key={p.name}
                          type="button"
                          className={`hd-staffer${p.on ? ' hd-staffer--on' : ''}${p.topics.length ? ' hd-staffer--topics' : ''}`}
                          onClick={p.toggle}
                        >
                          <span className="hd-staffer__row">
                            <span className={`hd-checkbox${p.on ? ' hd-checkbox--on' : ''}`} style={{ width: 16, height: 16 }}>
                              <span className="hd-checkbox__tick" style={{ width: 9, height: 9, display: p.on ? 'block' : 'none' }} />
                            </span>
                            <span className="hd-staffer__name">{p.name}</span>
                            <span style={{ color: p.known ? 'var(--hd-green-500)' : p.icon === 'AlertTriangle' ? 'var(--hd-amber-500)' : 'var(--hd-gray-400)', display: 'flex' }}>
                              <HdIcon name={p.icon} size={15} />
                            </span>
                          </span>
                          <span className="hd-staffer__role">{p.role}</span>
                          <span className="hd-staffer__topics">
                            {p.topics.map((tp) => (
                              <span key={tp} className="hd-topic-chip">
                                {tp}
                              </span>
                            ))}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="hd-note-card">
                  <span className="hd-note-card__head">
                    <span className="hd-note-card__title">Your context for this meeting</span>
                    <span className="hd-note-card__meta">
                      {ctxMeeting.time} · {ctxMeeting.room}
                    </span>
                  </span>
                  <label htmlFor="hd-note">What the platform does not have</label>
                  <textarea
                    id="hd-note"
                    rows={4}
                    value={notes[ctxMeeting.id] ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [ctxMeeting.id]: e.target.value }))}
                    placeholder="What do you know that the platform does not? Prior conversation, staff temperament, an ask that has already been declined."
                  />
                  <span className="hd-note-card__hint">
                    Goes into Background verbatim as a source. Meri will not contradict it.
                  </span>
                </div>

                <ThreadsCard
                  meetingId={ctxMeeting.id}
                  selected={threadSel}
                  onToggle={(id) =>
                    setThreadSel((arr) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]))
                  }
                />
              </div>
            </div>
          </div>
        )}

        {/* Step 6 · Generate */}
        {step === 5 && (
          <div className="hd-run">
            <div className="hd-run__card">
              <div className="hd-run__head">
                <span className="hd-run__icon">
                  <HdIcon name="Stars02" size={20} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="hd-run__title">
                    {runDone ? 'Six prep sections drafted' : 'Meri is drafting the packet'}
                  </span>
                  <span className="hd-run__sub">
                    {runDone
                      ? 'Focus and Background written for every meeting. Open to edit.'
                      : 'Assembling Directory, Portfolio and Intelligence per meeting.'}
                  </span>
                </span>
                <span className="hd-run__pct">{Math.round((done / 6) * 100)}%</span>
              </div>
              <div className="hd-run__bar">
                <div className="hd-run__bar-fill" style={{ width: `${Math.round((done / 6) * 100)}%` }} />
              </div>
              <div className="hd-run__rows">
                {runRows.map(({ m, st, icon, status }) => (
                  <div key={m.id} className={`hd-run-row hd-run-row--${st}`}>
                    <span className={`hd-run-row__icon hd-run-row__icon--${st}`}>
                      <HdIcon name={icon as 'CheckCircle' | 'Clock'} size={18} className={st === 'running' ? 'hd-spin' : undefined} />
                    </span>
                    <span className="hd-run-row__time">{m.time}</span>
                    <span className="hd-run-row__member">{m.member}</span>
                    <span className="hd-run-row__status">{status}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="hd-run__foot">
              Focus and Background are drafted per meeting. A failed section resolves to unavailable
              and is flagged in the document — never to an empty section.
            </p>
          </div>
        )}
      </div>

      {/* Sticky footer with the forward contract */}
      <div className="hd-flow__footer">
        <span className="hd-flow__footer-note">{footers[step]}</span>
        <HdSecondary
          className={`hd-flow__back${step === 0 ? ' hd-flow__back--dim' : ''}`}
          onClick={() => go(step - 1)}
        >
          Back
        </HdSecondary>
        <HdPrimary
          disabled={step === 5 && !runDone}
          onClick={() => {
            if (step === 5) {
              if (runDone) navigate('/workspace/documents/hillday-demo');
            } else {
              go(step + 1);
            }
          }}
        >
          {nextLabels[step]}
          {!(step === 5 && !runDone) && <HdIcon name="ArrowRight" size={16} />}
        </HdPrimary>
      </div>
    </div>
    </div>
  );
}

function ThreadsCard({
  meetingId,
  selected,
  onToggle,
}: {
  meetingId: string;
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const threads = hillDayApi.listThreadsSync(meetingId) ?? [];
  const included = threads.filter((t) => selected.includes(t.id)).length;
  return (
    <div className="hd-threads">
      <div className="hd-threads__head">
        <span className="hd-threads__title">Correspondence</span>
        <span className="hd-threads__meta">
          {threads.length
            ? `${threads.length} found · ${included} included`
            : 'None in window'}
        </span>
        <span className="hd-threads__window">
          <HdIcon name="ClockRewind" size={15} />
          Last 90 days
          <HdIcon name="ChevronDown" size={15} />
        </span>
      </div>
      {threads.map((t) => {
        const on = selected.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            className={`hd-threads__row${on ? ' hd-threads__row--on' : ''}`}
            onClick={() => onToggle(t.id)}
          >
            <span style={{ flex: '0 0 auto', display: 'flex' }}>
              <span className={`hd-checkbox${on ? ' hd-checkbox--on' : ''}`} style={{ width: 18, height: 18, borderRadius: 5 }}>
                <span className="hd-checkbox__tick" style={{ width: 11, height: 11, display: on ? 'block' : 'none' }} />
              </span>
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="hd-threads__subject">{t.subject}</span>
              <span className="hd-threads__sub">{t.meta}</span>
            </span>
            <span className="hd-threads__age">{t.age}</span>
          </button>
        );
      })}
      <div className="hd-threads__foot">
        Threads outside the window are excluded rather than summarised. Widen the window if a
        decision predates it.
      </div>
    </div>
  );
}

// FOOTER_NOTES is superseded by the computed `footers` array above; kept as a
// shape reference for the backend contract. Void reference to satisfy lint.
void FOOTER_NOTES;
