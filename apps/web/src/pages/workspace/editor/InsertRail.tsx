/**
 * Insert rail (Phase 6) — ported from the prototype `InsertRail` (asset_12).
 * Section / Templates / Photo / Table / Logo tiles.
 *
 *  - Templates → TemplateInsertModal (Replace vs Merge, see InsertModals).
 *  - Table     → TableTypePicker (platform vs custom) anchored to the tile.
 *  - Section / Photo / Logo insert immediately into the active canvas.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../kit.js';
import type { WsTemplate } from '../types.js';
import { TableTypePicker, TemplateInsertModal } from './InsertModals.js';

function Tile({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={'Insert ' + label}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 5,
        padding: '11px 4px',
        border: '1px solid var(--border-1)',
        background: 'var(--bg-surface)',
        borderRadius: 9,
        cursor: 'pointer',
        font: 'inherit',
        color: 'var(--ink-2)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--accent)';
        e.currentTarget.style.color = 'var(--accent)';
        e.currentTarget.style.background = 'var(--accent-soft)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-1)';
        e.currentTarget.style.color = 'var(--ink-2)';
        e.currentTarget.style.background = 'var(--bg-surface)';
      }}
    >
      <Icon name={icon} size={18} />
      <span style={{ fontSize: 10, fontWeight: 600 }}>{label}</span>
    </button>
  );
}

export function InsertRail({
  product,
  onAddSection,
  onInsert,
  onApplyTemplate,
}: {
  /** Active product — suggested templates ordering + the catalog query. */
  product: string | null;
  onAddSection: () => void;
  onInsert: (kind: string) => void;
  /** Apply a chosen template by mode (replace vs merge). */
  onApplyTemplate: (template: WsTemplate, mode: 'replace' | 'merge') => void;
}) {
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showTablePicker) return;
    const h = (e: MouseEvent) => {
      if (tableRef.current && !tableRef.current.contains(e.target as Node)) {
        setShowTablePicker(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showTablePicker]);

  return (
    <>
      <div
        style={{
          borderLeft: '1px solid var(--border-1)',
          background: 'var(--bg-surface)',
          padding: '16px 9px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 9.5,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--ink-3)',
            fontWeight: 600,
            textAlign: 'center',
            marginBottom: 2,
          }}
        >
          Insert
        </div>
        <Tile icon="Plus" label="Section" onClick={onAddSection} />
        <Tile icon="LayoutTemplate" label="Templates" onClick={() => setShowTemplatePicker(true)} />
        <Tile icon="Image" label="Photo" onClick={() => onInsert('image')} />
        <div
          ref={tableRef}
          style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}
        >
          <Tile icon="Table" label="Table" onClick={() => setShowTablePicker((s) => !s)} />
          {showTablePicker && (
            <TableTypePicker
              onClose={() => setShowTablePicker(false)}
              onInsert={(kind) => {
                onInsert(kind);
                setShowTablePicker(false);
              }}
            />
          )}
        </div>
        <Tile icon="Stamp" label="Logo" onClick={() => onInsert('logo')} />
      </div>
      {showTemplatePicker && (
        <TemplateInsertModal
          product={product}
          onClose={() => setShowTemplatePicker(false)}
          onApply={onApplyTemplate}
        />
      )}
    </>
  );
}
