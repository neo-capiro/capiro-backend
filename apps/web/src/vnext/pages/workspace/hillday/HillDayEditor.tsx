/**
 * Hill Day Editor — /workspace/documents/:id (demo document id
 * `hillday-demo` until the backend module ships).
 *
 * Markup mirrors the prototype's EDITOR section: topbar (back, title, saved
 * state, Preview as client, Deliver, overflow), the as-generated provenance
 * strip, and the three-column grid — outline rail, paper canvas (cover block,
 * fact grid, day-at-a-glance table, per-meeting sections), quality + sources
 * inspector. Column collapses follow the requirements' breakpoints.
 */
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { hillDayApi } from './api.js';
import { HILL_DAY_DATELINE } from './fixtures.js';
import { HdIcon, HdPrimary, HdSecondary } from './ui.js';

const QUALITY_CHECKS = [
  {
    label: 'Every meeting has a resolved office',
    detail: '6 of 6. Two offices were confirmed by you.',
    tone: 'ok' as const,
  },
  {
    label: 'Attendee titles present',
    detail: '5 of 6. Collins office attendees added manually.',
    tone: 'warn' as const,
  },
  {
    label: 'Correspondence inside window',
    detail: '3 threads used, all within 90 days.',
    tone: 'ok' as const,
  },
  {
    label: 'Client objectives cited',
    detail: 'Focus cites 2 Portfolio objectives and 1 live Strategy.',
    tone: 'ok' as const,
  },
  {
    label: 'No unsupported claims',
    detail: '1 sentence flagged for review in Meeting 5.',
    tone: 'warn' as const,
  },
];

const SOURCES = [
  { label: 'Directory', icon: 'Users01' as const, count: '9 records' },
  { label: 'Calendar', icon: 'Calendar2' as const, count: '6 events' },
  { label: 'Portfolio · Kela Systems', icon: 'Briefcase01' as const, count: '6 objectives' },
  { label: 'LegiWatch', icon: 'Target04' as const, count: '11 bills' },
  { label: 'Correspondence', icon: 'Mail01' as const, count: '3 threads' },
  { label: 'Your context', icon: 'Edit01' as const, count: '1 note' },
];

export function HillDayEditor() {
  const navigate = useNavigate();
  const params = useParams();
  const docId = params.id ?? 'hillday-demo';
  const [sectionId, setSectionId] = useState('m1');
  const [regen, setRegen] = useState<string | null>(null);
  const [docName, setDocName] = useState('Kela Systems Hill Day Schedule');

  const meetingsQuery = useQuery({
    queryKey: ['hd', 'meetings'],
    queryFn: () => hillDayApi.listMeetings(),
    staleTime: 60_000,
  });
  const all = meetingsQuery.data ?? [];
  const sections = all.filter((m) => m.kind === 'hill' && m.id !== 'x2');

  const coverFacts = [
    { k: 'Sponsor', v: 'Kela Systems' },
    { k: 'Prepared by', v: 'Maven Advocacy' },
    { k: 'Meetings', v: '6' },
    { k: 'Date', v: 'September 16, 2026' },
    { k: 'Lead', v: 'Neo Martinez' },
    { k: 'Revision', v: '1 · as generated' },
  ];

  const summary = sections.map((m) => {
    const first = (m.att ?? []).find((a) => a.state === 'resolved');
    return {
      id: m.id,
      time: m.time,
      member: m.member ?? '',
      office: m.party ?? '',
      room: m.room ?? '',
      min: (m.dur ?? '').replace(' min', ''),
      lead: first ? first.name : 'To be confirmed',
    };
  });

  const regenerate = (id: string) => {
    setSectionId(id);
    setRegen(id);
    setTimeout(() => setRegen(null), 1400);
  };

  return (
    <div className="hd-root" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', background: 'var(--hd-canvas)' }}>
    <div className="hd-editor">
      <div className="hd-editor__topbar">
        <button
          type="button"
          className="hd-icon-btn"
          onClick={() => navigate('/workspace/documents')}
          aria-label="Back to documents"
        >
          <HdIcon name="FlipBackward" size={18} />
        </button>
        <span className="hd-editor__title-block">
          <span className="hd-editor__title">{docName}</span>
          <span className="hd-editor__meta">
            <span className="hd-editor__version">Hill Day Schedule · Version 1</span>
            <span className="hd-editor__saved">
              <span className="hd-editor__saved-dot" />
              Saved
            </span>
          </span>
        </span>
        <HdSecondary style={{ height: 38 }}>
          <HdIcon name="Eye" size={16} />
          Preview as client
        </HdSecondary>
        <HdPrimary style={{ height: 38 }}>
          <HdIcon name="Send01" size={16} />
          Deliver
        </HdPrimary>
        <button type="button" className="hd-icon-btn" style={{ width: 38, height: 38 }} aria-label="More actions">
          <HdIcon name="DotsHorizontal" size={18} />
        </button>
      </div>

      <div className="hd-editor__prov">
        <span className="hd-editor__prov-label">
          As generated · 6 meetings · 14 sources · Quality 86%
        </span>
        <button type="button" className="hd-editor__prov-link">
          Context used
          <HdIcon name="ChevronRight" size={15} />
        </button>
      </div>

      <div className="hd-editor__grid">
        <div className="hd-editor__outline">
          <span className="hd-eyebrow" style={{ display: 'block', padding: '0 8px 10px' }}>
            Contents
          </span>
          <button
            type="button"
            className="hd-editor__outline-row"
            style={{ alignItems: 'center' }}
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            <HdIcon name="File04" size={16} />
            Cover and schedule
          </button>
          {sections.map((m, i) => (
            <button
              key={m.id}
              type="button"
              className={`hd-editor__outline-row${m.id === sectionId ? ' hd-editor__outline-row--on' : ''}`}
              onClick={() => {
                setSectionId(m.id);
                document.getElementById(`hd-section-${m.id}`)?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              <span className="hd-editor__outline-num">{String(i + 1).padStart(2, '0')}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="hd-editor__outline-member">{m.member}</span>
                <span className="hd-editor__outline-time">{m.time}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="hd-editor__canvas">
          <div className="hd-paper">
            <div className="hd-paper__cover">
              <div className="hd-paper__cover-rule">
                <span className="hd-paper__brand">
                  <span className="hd-paper__brand-mark">KS</span>
                  <span className="hd-paper__brand-name">Kela Systems</span>
                </span>
                <span className="hd-paper__firm">Maven Advocacy</span>
              </div>
              <h1 className="hd-paper__h1">Hill Day Schedule</h1>
              <p className="hd-paper__lede">{HILL_DAY_DATELINE}</p>
              <div className="hd-paper__facts">
                {coverFacts.map((c) => (
                  <span key={c.k} className="hd-paper__fact">
                    <span className="hd-paper__fact-k">{c.k}</span>
                    <span className="hd-paper__fact-v">{c.v}</span>
                  </span>
                ))}
              </div>
              <div style={{ marginTop: 28 }}>
                <span className="hd-paper__glance-label">The day at a glance</span>
                <div className="hd-paper__table">
                  <div className="hd-paper__th">
                    <span>Time</span>
                    <span>Member</span>
                    <span>Office</span>
                    <span>Room</span>
                    <span>Min</span>
                    <span>Staff lead</span>
                  </div>
                  {summary.map((r, i) => (
                    <div
                      key={r.id}
                      className="hd-paper__tr"
                      style={{
                        borderBottom:
                          i === summary.length - 1 ? '1px solid transparent' : undefined,
                      }}
                    >
                      <span className="hd-paper__td-time">{r.time}</span>
                      <span className="hd-paper__td-member">{r.member}</span>
                      <span className="hd-paper__td">{r.office}</span>
                      <span className="hd-paper__td" style={{ whiteSpace: 'nowrap' }}>
                        {r.room}
                      </span>
                      <span className="hd-paper__td-mono">{r.min}</span>
                      <span className="hd-paper__td">{r.lead}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {sections.map((m, i) => (
              <div key={m.id} id={`hd-section-${m.id}`} className="hd-section">
                <span className="hd-section__eyebrow-row">
                  <span className="hd-section__eyebrow">
                    Meeting {i + 1} · {m.time} · {m.dur}
                  </span>
                  <button
                    type="button"
                    className="hd-section__regen"
                    onClick={() => regenerate(m.id)}
                  >
                    <HdIcon
                      name={regen === m.id ? 'Loading01' : 'RefreshCw01'}
                      size={14}
                      className={regen === m.id ? 'hd-spin' : undefined}
                    />
                    {regen === m.id ? 'Regenerating…' : 'Regenerate'}
                  </button>
                </span>
                <h2 className="hd-section__h2">{m.member}</h2>
                <p className="hd-section__subline">
                  {m.party} · {m.room}
                </p>
                <div className="hd-section__facts">
                  {[
                    { k: 'Office', v: m.room },
                    { k: 'Attendees', v: (m.att ?? []).map((a) => a.name).join(', ') },
                    { k: 'Committees', v: m.cmte },
                    { k: 'Party · state', v: m.party },
                  ].map((f) => (
                    <span key={f.k}>
                      <span className="hd-section__fact-k">{f.k}</span>
                      <span className="hd-section__fact-v">{f.v}</span>
                    </span>
                  ))}
                </div>
                <h3 className="hd-section__h3">Focus</h3>
                <p className="hd-section__body">{m.focus}</p>
                <h3 className="hd-section__h3 hd-section__h3--tight">Background</h3>
                <p className="hd-section__body">{m.background}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="hd-editor__inspector">
          <span className="hd-eyebrow" style={{ display: 'block' }}>
            Quality
          </span>
          <div className="hd-checks">
            {QUALITY_CHECKS.map((c) => (
              <div key={c.label} className={`hd-check${c.tone === 'warn' ? ' hd-check--warn' : ''}`}>
                <span className={`hd-check__icon--${c.tone}`}>
                  <HdIcon name={c.tone === 'ok' ? 'CheckCircle' : 'AlertTriangle'} size={16} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="hd-check__label">{c.label}</span>
                  <span className="hd-check__detail">{c.detail}</span>
                </span>
              </div>
            ))}
          </div>

          <span className="hd-eyebrow hd-editor__inspector-sep" style={{ display: 'block' }}>
            Sources used
          </span>
          <div className="hd-sources">
            {SOURCES.map((s) => (
              <span key={s.label} className="hd-source-row">
                <HdIcon name={s.icon} size={15} />
                <span className="hd-source-row__label">{s.label}</span>
                <span className="hd-source-row__count">{s.count}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}
