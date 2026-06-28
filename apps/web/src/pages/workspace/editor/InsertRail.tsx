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
import type { WsBlock, WsSectionMeta, WsTemplate } from '../types.js';
import { SectionTypePicker, TableTypePicker, TemplateInsertModal } from './InsertModals.js';

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
  clientId,
  onAddSection,
  onInsert,
  onApplyTemplate,
}: {
  /** Active product — suggested templates ordering + the catalog query. */
  product: string | null;
  /** Resolved client id for the doc — enables client-scoped platform tables. */
  clientId?: string | null;
  onAddSection: (name?: string, meta?: Partial<WsSectionMeta>) => void;
  onInsert: (kind: string, extra?: Partial<WsBlock>) => void;
  /** Apply a chosen template by mode (replace vs merge). */
  onApplyTemplate: (template: WsTemplate, mode: 'replace' | 'merge') => void;
}) {
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [showSectionPicker, setShowSectionPicker] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLDivElement>(null);

  // E-5/E-8: a hidden file input opens the OS picker for photo + logo inserts.
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingKind = useRef<'photo' | 'logo'>('photo');
  const pickImage = (kind: 'photo' | 'logo') => {
    pendingKind.current = kind;
    fileRef.current?.click();
  };
  const onPickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg)$/.test(f.type) || f.size > 2 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => onInsert(pendingKind.current, { src: String(reader.result) });
    reader.readAsDataURL(f);
  };

  useEffect(() => {
    if (!showTablePicker && !showSectionPicker) return;
    const h = (e: MouseEvent) => {
      if (showTablePicker && tableRef.current && !tableRef.current.contains(e.target as Node))
        setShowTablePicker(false);
      if (showSectionPicker && sectionRef.current && !sectionRef.current.contains(e.target as Node))
        setShowSectionPicker(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showTablePicker, showSectionPicker]);

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
          overflowY: 'auto',
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
        <div
          ref={sectionRef}
          style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}
        >
          <Tile icon="Plus" label="Section" onClick={() => setShowSectionPicker((s) => !s)} />
          {showSectionPicker && (
            <SectionTypePicker
              onClose={() => setShowSectionPicker(false)}
              onChoose={(name, meta) => {
                onAddSection(name, meta);
                setShowSectionPicker(false);
              }}
            />
          )}
        </div>
        <Tile icon="LayoutTemplate" label="Templates" onClick={() => setShowTemplatePicker(true)} />
        <Tile icon="Image" label="Photo" onClick={() => pickImage('photo')} />
        <div
          ref={tableRef}
          style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}
        >
          <Tile icon="Table" label="Table" onClick={() => setShowTablePicker((s) => !s)} />
          {showTablePicker && (
            <TableTypePicker
              clientId={clientId}
              onClose={() => setShowTablePicker(false)}
              onInsert={(kind, extra) => {
                onInsert(kind, extra);
                setShowTablePicker(false);
              }}
            />
          )}
        </div>
        <Tile icon="Stamp" label="Logo" onClick={() => pickImage('logo')} />
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          style={{ display: 'none' }}
          onChange={onPickImage}
        />
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
