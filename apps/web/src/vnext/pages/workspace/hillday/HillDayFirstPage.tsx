import { useState } from 'react';
import type { CoverFactKey, FirstPageEdits, HillDayDocumentView, SummaryColumnKey, SummaryRow } from './types.js';
import { HdIcon, HdPrimary, HdSecondary } from './ui.js';

const COLUMNS: Array<{ key: SummaryColumnKey; label: string; width: number; maxLength: number; className: string }> = [
  { key: 'time', label: 'Time', width: 0.85, maxLength: 80, className: 'hd-paper__td-time' },
  { key: 'member', label: 'Member', width: 1.85, maxLength: 300, className: 'hd-paper__td-member' },
  { key: 'office', label: 'Office', width: 1.15, maxLength: 300, className: 'hd-paper__td' },
  { key: 'room', label: 'Room', width: 1.35, maxLength: 500, className: 'hd-paper__td' },
  { key: 'minutes', label: 'Min', width: 0.55, maxLength: 40, className: 'hd-paper__td-mono' },
  { key: 'staffLead', label: 'Staff lead', width: 1.35, maxLength: 300, className: 'hd-paper__td' },
];
const FACT_KEYS: CoverFactKey[] = ['Sponsor', 'Prepared by', 'Meetings', 'Date', 'Lead', 'Revision'];

interface FirstPageDraft {
  baseline: HillDayDocumentView;
  title: string;
  dateline: string;
  facts: Array<{ k: string; v: string }>;
  rows: SummaryRow[];
  columns: SummaryColumnKey[];
}

function visibleColumns(doc: HillDayDocumentView): SummaryColumnKey[] {
  // Older documents and API responses predate configurable columns.
  return COLUMNS.filter((c) => doc.summaryColumns ? doc.summaryColumns.includes(c.key) : !doc.firstPage?.hiddenColumns?.includes(c.key)).map((c) => c.key);
}

function createDraft(doc: HillDayDocumentView): FirstPageDraft {
  return {
    baseline: doc,
    title: doc.cover.title,
    dateline: doc.cover.dateline,
    facts: doc.cover.facts.map((f) => ({ ...f })),
    rows: doc.summary.map((r) => ({ ...r })),
    columns: visibleColumns(doc),
  };
}

/** Retain existing overrides and add only values changed in this edit session. */
function buildEdits(draft: FirstPageDraft): FirstPageEdits {
  const { baseline } = draft;
  const edits: FirstPageEdits = { ...baseline.firstPage };
  if (draft.title !== baseline.cover.title) edits.title = draft.title;
  if (draft.dateline !== baseline.cover.dateline) edits.dateline = draft.dateline;
  const facts = new Map((edits.facts ?? []).map((f) => [f.key, f]));
  for (const fact of draft.facts) {
    if (FACT_KEYS.includes(fact.k as CoverFactKey) && fact.v !== baseline.cover.facts.find((f) => f.k === fact.k)?.v) {
      facts.set(fact.k as CoverFactKey, { key: fact.k as CoverFactKey, value: fact.v });
    }
  }
  if (facts.size) edits.facts = [...facts.values()];
  const currentMeetingIds = new Set(baseline.summary.map((r) => r.meetingId));
  const rows = new Map((edits.rows ?? []).filter((r) => currentMeetingIds.has(r.meetingId)).map((r) => [r.meetingId, { ...r }]));
  for (const row of draft.rows) {
    const initial = baseline.summary.find((r) => r.meetingId === row.meetingId);
    const patch = rows.get(row.meetingId) ?? { meetingId: row.meetingId };
    for (const { key } of COLUMNS) {
      if (row[key] !== initial?.[key]) patch[key] = row[key];
    }
    if (Object.keys(patch).length > 1) rows.set(row.meetingId, patch);
  }
  if (rows.size) edits.rows = [...rows.values()];
  else delete edits.rows;
  if (draft.columns.join(',') !== visibleColumns(baseline).join(',')) {
    edits.hiddenColumns = COLUMNS.filter((c) => !draft.columns.includes(c.key)).map((c) => c.key);
  }
  return edits;
}

export function HillDayFirstPage({ doc, loading, disabled, saving, onEditingChange, onSave }: {
  doc: HillDayDocumentView | null;
  loading: boolean;
  disabled: boolean;
  saving: boolean;
  onEditingChange: (editing: boolean) => void;
  onSave: (edits: FirstPageEdits | null, expectedUpdatedAt: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<FirstPageDraft | null>(null);
  const finishEditing = () => {
    setDraft(null);
    onEditingChange(false);
  };
  const save = async () => {
    if (!draft || saving) return;
    if (await onSave(buildEdits(draft), draft.baseline.updatedAt)) finishEditing();
  };
  const columns = COLUMNS.filter((c) => (draft?.columns ?? (doc ? visibleColumns(doc) : COLUMNS.map((c) => c.key))).includes(c.key));
  const gridStyle = {
    gridTemplateColumns: columns.map((c) => `minmax(0, ${c.width}fr)`).join(' '),
    minWidth: columns.length > 4 ? 600 : 0,
  };
  const rows = draft?.rows ?? doc?.summary ?? [];
  const facts = draft?.facts ?? doc?.cover.facts ?? [];

  return (
    <>
      <div className="hd-first-page__toolbar">
        <div className="hd-first-page__intro">
          <span className="hd-first-page__title">First page</span>
          <span className="hd-first-page__hint">Edit the cover and schedule on this page. First-page changes appear in the preview and delivered PDF.</span>
        </div>
        {draft ? (
          <div className="hd-first-page__actions">
            <HdSecondary disabled={saving} onClick={finishEditing}>Cancel</HdSecondary>
            <HdPrimary disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save first page'}</HdPrimary>
          </div>
        ) : (
          <div className="hd-first-page__actions">
            {doc?.firstPage && Object.keys(doc.firstPage).length > 0 && (
              <HdSecondary disabled={disabled || saving} title="Remove saved first-page edits and show the source values again" onClick={() => doc && void onSave(null, doc.updatedAt)}>Restore defaults</HdSecondary>
            )}
            <HdSecondary disabled={!doc || disabled || saving} onClick={() => {
              if (!doc) return;
              setDraft(createDraft(doc));
              onEditingChange(true);
            }}>
              <HdIcon name="Edit01" size={15} /> Edit first page
            </HdSecondary>
          </div>
        )}
        {draft && (
          <fieldset className="hd-first-page__columns" disabled={saving}>
            <legend>Columns shown in the schedule</legend>
            <div className="hd-first-page__column-options">
              {COLUMNS.map(({ key, label }) => (
                <label key={key}>
                  <input type="checkbox" checked={draft.columns.includes(key)} disabled={draft.columns.length === 1 && draft.columns.includes(key)} onChange={(e) => {
                    const checked = e.target.checked;
                    setDraft((current) => current ? { ...current, columns: COLUMNS.filter((c) => c.key === key ? checked : current.columns.includes(c.key)).map((c) => c.key) } : current);
                  }} />
                  {key === 'minutes' ? 'Minutes' : label}
                </label>
              ))}
            </div>
            <p className="hd-first-page__hint">Uncheck a column to remove it from the first page. You can show it again later. Keep at least one column.</p>
          </fieldset>
        )}
      </div>
      <div className="hd-paper__cover">
        <div className="hd-paper__cover-rule">
          <span className="hd-paper__brand">
            <span className="hd-paper__brand-mark">{doc?.client.mono ?? ''}</span>
            <span className="hd-paper__brand-name">{doc?.client.name ?? ''}</span>
          </span>
          <span className="hd-paper__firm">{doc?.firm.name ?? ''}</span>
        </div>
        {draft ? (
          <div className="hd-first-page__cover-fields">
            <label className="hd-first-page__field">Title
              <input className="hd-first-page__input hd-first-page__input--title" value={draft.title} maxLength={200} disabled={saving} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </label>
            <label className="hd-first-page__field">Subtitle
              <textarea className="hd-first-page__input" value={draft.dateline} maxLength={1000} rows={3} disabled={saving} onChange={(e) => setDraft({ ...draft, dateline: e.target.value })} />
            </label>
          </div>
        ) : (
          <>
            <h1 className="hd-paper__h1">{doc?.cover.title ?? 'Hill Day Schedule'}</h1>
            <p className="hd-paper__lede">{doc?.cover.dateline ?? (loading ? 'Loading…' : '')}</p>
          </>
        )}
        <div className="hd-paper__facts">
          {facts.map((fact, index) => draft ? (
            <label key={fact.k} className="hd-paper__fact">
              <span className="hd-paper__fact-k">{fact.k}</span>
              <textarea className="hd-first-page__input hd-first-page__input--fact" value={fact.v} maxLength={500} rows={2} disabled={saving} onChange={(e) => setDraft({ ...draft, facts: draft.facts.map((f, i) => i === index ? { ...f, v: e.target.value } : f) })} />
            </label>
          ) : (
            <span key={fact.k} className="hd-paper__fact">
              <span className="hd-paper__fact-k">{fact.k}</span>
              <span className="hd-paper__fact-v">{fact.v}</span>
            </span>
          ))}
        </div>
        <div style={{ marginTop: 28 }}>
          <span className="hd-paper__glance-label">The day at a glance</span>
          <div className="hd-paper__table" role="table" aria-label="The day at a glance">
            <div className="hd-paper__th" role="row" style={gridStyle}>
              {columns.map((c) => <span role="columnheader" key={c.key}>{c.label}</span>)}
            </div>
            {rows.map((row, index) => (
              <div key={row.meetingId} className="hd-paper__tr" role="row" style={gridStyle}>
                {columns.map((column) => (
                  <span key={column.key} role="cell" className={column.className}>
                    {draft ? (
                      <textarea className="hd-first-page__input hd-first-page__input--cell" aria-label={`Meeting ${index + 1} ${column.key === 'minutes' ? 'minutes' : column.label.toLowerCase()}`} value={row[column.key]} maxLength={column.maxLength} rows={3} disabled={saving} onChange={(e) => setDraft({ ...draft, rows: draft.rows.map((r) => r.meetingId === row.meetingId ? { ...r, [column.key]: e.target.value } : r) })} />
                    ) : row[column.key]}
                  </span>
                ))}
              </div>
            ))}
            {doc && rows.length === 0 && (
              <div className="hd-paper__tr" role="row" style={gridStyle}>
                <span className="hd-paper__td" role="cell" style={{ gridColumn: '1 / -1' }}>No meetings selected.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
