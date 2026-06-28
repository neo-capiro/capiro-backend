/**
 * Insert modals (Phase 6) — ported from the prototype (asset_12), wired to the
 * engine template catalog (useTemplatesFor).
 *
 *  - TemplateInsertModal: searchable template list (suggested-for-product first),
 *    a section preview, and BOTH apply paths (Q-ED-5):
 *      · Replace  — warns, then replaces cfg.sections (written content cleared).
 *      · Merge    — appends the template's sections not already present, keeping
 *                   existing content + order.
 *    Both set cfg.selectedTemplate.
 *  - TableTypePicker: "Pull from platform" vs "Custom table" → inserts the
 *    matching table block into the active canvas via the Phase-5 block model.
 */
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../kit.js';
import type { WsSectionMeta, WsTemplate } from '../types.js';
import { useAllTemplates } from '../api.js';

// Shared anchored-popover frame for the Insert-rail pickers.
const POPOVER: CSSProperties = {
  position: 'absolute',
  right: 'calc(100% + 8px)',
  top: 0,
  zIndex: 60,
  width: 252,
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-1)',
  borderRadius: 10,
  boxShadow: 'var(--shadow-2)',
  padding: 12,
};
const POPOVER_HEADER: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--ink-3)',
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
  marginBottom: 9,
};
const POPOVER_CANCEL: CSSProperties = {
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  fontSize: 11,
  color: 'var(--ink-3)',
  width: '100%',
  textAlign: 'center',
  padding: '3px 0',
  fontFamily: 'var(--font-sans)',
};

function Stepper({
  label,
  value,
  set,
}: {
  label: string;
  value: number;
  set: (v: number) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
      }}
    >
      <span style={{ fontSize: 12 }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button className="btn sm btn-ghost" onClick={() => set(Math.max(1, value - 1))}>
          <Icon name="Minus" size={12} />
        </button>
        <span className="num" style={{ width: 18, textAlign: 'center', fontSize: 12.5 }}>
          {value}
        </span>
        <button className="btn sm btn-ghost" onClick={() => set(Math.min(12, value + 1))}>
          <Icon name="Plus" size={12} />
        </button>
      </span>
    </div>
  );
}

// ── Table type picker ─────────────────────────────────────────────────────────
const TABLE_OPTIONS: Array<{
  kind: 'table-platform' | 'table-custom';
  icon: string;
  label: string;
  desc: string;
  accent: boolean;
}> = [
  {
    kind: 'table-platform',
    icon: 'Database',
    label: 'Pull from platform',
    desc: 'Auto-populate from R-1, UPL, or program data Meri has access to.',
    accent: true,
  },
  {
    kind: 'table-custom',
    icon: 'LayoutGrid',
    label: 'Custom table',
    desc: 'Start blank and fill in manually.',
    accent: false,
  },
];

export function TableTypePicker({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  onInsert: (
    kind: 'table-platform' | 'table-custom',
    extra?: { rows?: number; cols?: number },
  ) => void;
}) {
  // E-6: choosing "Custom table" opens a rows×cols step before inserting.
  const [dims, setDims] = useState<{ rows: number; cols: number } | null>(null);

  if (dims) {
    return (
      <div style={POPOVER}>
        <div style={POPOVER_HEADER}>Table size</div>
        <Stepper label="Rows" value={dims.rows} set={(v) => setDims({ ...dims, rows: v })} />
        <Stepper label="Columns" value={dims.cols} set={(v) => setDims({ ...dims, cols: v })} />
        <button
          className="btn btn-accent sm"
          style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
          onClick={() => {
            onInsert('table-custom', dims);
            onClose();
          }}
        >
          <Icon name="Check" size={12} />
          Insert {dims.rows}×{dims.cols} table
        </button>
        <button onClick={() => setDims(null)} style={POPOVER_CANCEL}>
          Back
        </button>
      </div>
    );
  }

  return (
    <div style={POPOVER}>
      <div style={POPOVER_HEADER}>Add table</div>
      {TABLE_OPTIONS.map((o) => (
        <button
          key={o.kind}
          onClick={() => {
            if (o.kind === 'table-custom') {
              setDims({ rows: 3, cols: 2 });
            } else {
              onInsert(o.kind);
              onClose();
            }
          }}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            width: '100%',
            padding: '9px 10px',
            border: '1px solid',
            borderColor: o.accent ? 'var(--accent)' : 'var(--border-1)',
            background: o.accent ? 'var(--accent-soft)' : 'var(--bg-surface-2)',
            borderRadius: 8,
            cursor: 'pointer',
            textAlign: 'left',
            font: 'inherit',
            marginBottom: 8,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--accent)';
            e.currentTarget.style.background = 'var(--accent-soft)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = o.accent ? 'var(--accent)' : 'var(--border-1)';
            e.currentTarget.style.background = o.accent
              ? 'var(--accent-soft)'
              : 'var(--bg-surface-2)';
          }}
        >
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: o.accent ? 'var(--accent)' : 'var(--bg-sunken)',
              color: o.accent ? '#fff' : 'var(--ink-3)',
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
            }}
          >
            <Icon name={o.icon} size={14} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>{o.label}</div>
            <div style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.35 }}>{o.desc}</div>
          </div>
        </button>
      ))}
      <button onClick={onClose} style={POPOVER_CANCEL}>
        Cancel
      </button>
    </div>
  );
}

// ── Section type picker (E-2) ─────────────────────────────────────────────────
const SECTION_TYPES: Array<{
  key: string;
  name: string;
  defaultName: string;
  desc: string;
  icon: string;
  meta?: Partial<WsSectionMeta>;
  custom?: boolean;
}> = [
  {
    key: 'prose',
    name: 'Prose',
    defaultName: 'New section',
    desc: 'Narrative paragraphs.',
    icon: 'AlignLeft',
  },
  {
    key: 'facts',
    name: 'Key facts',
    defaultName: 'Key facts',
    desc: 'A concise bullet list.',
    icon: 'List',
  },
  {
    key: 'budget',
    name: 'Budget',
    defaultName: 'Funding history',
    desc: 'Funding figures by fiscal year.',
    icon: 'Table',
    meta: { smart: true },
  },
  {
    key: 'custom',
    name: 'Custom',
    defaultName: '',
    desc: 'Name a blank section.',
    icon: 'Plus',
    custom: true,
  },
];

export function SectionTypePicker({
  onClose,
  onChoose,
}: {
  onClose: () => void;
  onChoose: (name?: string, meta?: Partial<WsSectionMeta>) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  if (naming) {
    return (
      <div style={POPOVER}>
        <div style={POPOVER_HEADER}>Name the section</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onChoose(name.trim() || 'New section');
              onClose();
            }
          }}
          placeholder="Section name"
          className="field"
          style={{ width: '100%', padding: '7px 10px', fontSize: 12.5, marginBottom: 8 }}
        />
        <button
          className="btn btn-accent sm"
          style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
          onClick={() => {
            onChoose(name.trim() || 'New section');
            onClose();
          }}
        >
          <Icon name="Plus" size={12} />
          Add section
        </button>
        <button onClick={() => setNaming(false)} style={POPOVER_CANCEL}>
          Back
        </button>
      </div>
    );
  }

  return (
    <div style={POPOVER}>
      <div style={POPOVER_HEADER}>Add section</div>
      {SECTION_TYPES.map((t) => (
        <button
          key={t.key}
          onClick={() => {
            if (t.custom) {
              setNaming(true);
              return;
            }
            onChoose(t.defaultName, t.meta);
            onClose();
          }}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            width: '100%',
            padding: '8px 10px',
            border: '1px solid var(--border-1)',
            background: 'var(--bg-surface-2)',
            borderRadius: 8,
            cursor: 'pointer',
            textAlign: 'left',
            font: 'inherit',
            marginBottom: 8,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--accent)';
            e.currentTarget.style.background = 'var(--accent-soft)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-1)';
            e.currentTarget.style.background = 'var(--bg-surface-2)';
          }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              background: 'var(--bg-sunken)',
              color: 'var(--ink-3)',
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
            }}
          >
            <Icon name={t.icon} size={13} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>{t.name}</div>
            <div style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.35 }}>{t.desc}</div>
          </div>
        </button>
      ))}
      <button onClick={onClose} style={POPOVER_CANCEL}>
        Cancel
      </button>
    </div>
  );
}

// ── Template insert modal ─────────────────────────────────────────────────────
type ApplyMode = 'replace' | 'merge';

export function TemplateInsertModal({
  product,
  onClose,
  onApply,
}: {
  product: string | null;
  onClose: () => void;
  /** Apply the chosen template by the chosen mode (replace vs merge). */
  onApply: (template: WsTemplate, mode: ApplyMode) => void;
}) {
  // E-3: search the FULL tenant template library (all products), not just the
  // selected product's two. Suggested-for-product is derived below.
  const { data: libTemplates, isLoading } = useAllTemplates();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<WsTemplate | null>(null);
  const [confirming, setConfirming] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => libTemplates ?? [], [libTemplates]);
  const productTemplates = useMemo(() => all.filter((t) => t.product === product), [all, product]);
  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((t) => `${t.name} ${t.product}`.toLowerCase().includes(q));
  }, [all, search]);

  // Replace-confirmation gate (written content is cleared on replace).
  if (confirming && selected) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 220,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div className="card" style={{ width: 380, padding: 24, boxShadow: 'var(--shadow-3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Icon name="AlertTriangle" size={18} style={{ color: 'var(--notable)' }} />
            <div style={{ fontSize: 14, fontWeight: 700 }}>Replace document structure?</div>
          </div>
          <div
            style={{
              fontSize: 13,
              color: 'var(--ink-2)',
              lineHeight: 1.55,
              marginBottom: 18,
            }}
          >
            Applying <b>{selected.name}</b> will replace your current sections. Written content will
            be cleared.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setConfirming(false)}>
              Go back
            </button>
            <button
              className="btn btn-accent"
              onClick={() => {
                onApply(selected, 'replace');
                onClose();
              }}
            >
              Replace sections
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 210,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: 580,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--shadow-3)',
          padding: 0,
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '16px 18px 12px',
            borderBottom: '1px solid var(--border-1)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Icon name="LayoutTemplate" size={15} style={{ color: 'var(--accent)' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>Choose a template</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
              Replace your structure, or merge a template&apos;s sections into it.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-3)' }}
          >
            <Icon name="X" size={15} />
          </button>
        </div>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-1)' }}>
          <div
            className="field"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 10px',
              background: 'var(--bg-surface)',
            }}
          >
            <Icon name="Search" size={13} style={{ color: 'var(--ink-3)' }} />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search all templates…"
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 12.5,
                fontFamily: 'var(--font-sans)',
              }}
              autoFocus
            />
          </div>
        </div>
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: 16,
            display: 'grid',
            gridTemplateColumns: selected ? '1fr 240px' : '1fr',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {isLoading && (
              <div style={{ fontSize: 12, color: 'var(--ink-3)', padding: '12px 0' }}>
                Loading templates…
              </div>
            )}
            {!isLoading && results.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--ink-3)', padding: '12px 0' }}>
                No templates match “{search}”.
              </div>
            )}
            {!search && productTemplates.length > 0 && (
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                  color: 'var(--ink-3)',
                  marginBottom: 4,
                }}
              >
                Suggested for {product}
              </div>
            )}
            {results.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelected(t.id === selected?.id ? null : t)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 11px',
                  border: '1px solid',
                  borderColor: selected?.id === t.id ? 'var(--accent)' : 'var(--border-1)',
                  background: selected?.id === t.id ? 'var(--accent-soft)' : 'var(--bg-surface)',
                  borderRadius: 8,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 7,
                    background: t.accentColor || 'var(--bg-surface-2)',
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Icon name={t.icon || 'FileText'} size={14} style={{ color: '#fff' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{t.product}</div>
                </div>
                {t.meriPrimary && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: 'var(--accent)',
                      letterSpacing: '0.07em',
                    }}
                  >
                    Recommended
                  </span>
                )}
                {selected?.id === t.id && (
                  <Icon name="Check" size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                )}
              </button>
            ))}
          </div>
          {selected && (
            <div
              style={{
                borderLeft: '1px solid var(--border-1)',
                paddingLeft: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700 }}>{selected.name}</div>
              {selected.description && (
                <div style={{ fontSize: 11.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                  {selected.description}
                </div>
              )}
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                  color: 'var(--ink-3)',
                  marginTop: 4,
                }}
              >
                Sections
              </div>
              {selected.sections.map((s, i) => (
                <div
                  key={i}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
                >
                  <div
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: 2,
                      background: selected.accentColor || 'var(--accent)',
                      flexShrink: 0,
                    }}
                  />
                  {s}
                </div>
              ))}
              <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 7 }}>
                <button
                  className="btn btn-accent"
                  onClick={() => setConfirming(true)}
                  style={{ justifyContent: 'center' }}
                >
                  <Icon name="Replace" size={13} />
                  Replace sections
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    onApply(selected, 'merge');
                    onClose();
                  }}
                  style={{ justifyContent: 'center' }}
                >
                  <Icon name="ListPlus" size={13} />
                  Merge into document
                </button>
                <div style={{ fontSize: 10.5, color: 'var(--ink-3)', lineHeight: 1.4 }}>
                  Merge keeps your existing sections + content and appends any missing ones.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
