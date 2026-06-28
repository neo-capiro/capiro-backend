/**
 * Packet document tabs (ported from the prototype `DocTabs`, asset_14). Tab 1 =
 * the main document (label = product). Additional packet documents (cover
 * letter, fact sheet, appendix, …) are real `WsDocument` rows persisted via the
 * engine (Q-ED-7). Non-main tabs rename (double-click) + remove (×).
 *
 * The "+ Add" menu offers preset names + a custom name. Cover-letter is added
 * here too (and is also auto-ensured by the editor when cfg.coverLetter flips).
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../kit.js';

export interface DocTab {
  id: string;
  label: string;
  main?: boolean;
}

const PRESETS = ['Cover letter', 'Fact sheet', 'Appendix', 'One-pager', 'Support letter'];

export function DocTabs({
  tabs,
  activeId,
  onSelect,
  onAdd,
  onRename,
  onRemove,
}: {
  tabs: DocTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: (label: string) => void;
  onRename: (id: string, label: string) => void;
  onRemove: (id: string) => void;
}) {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const [customInput, setCustomInput] = useState('');
  const addRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // E-11: keep the active tab in view when tabs overflow the strip width.
  useEffect(() => {
    scrollRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeId]);

  useEffect(() => {
    if (!showAddMenu) return;
    const h = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setShowAddMenu(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showAddMenu]);

  const add = (label: string) => {
    onAdd(label);
    setShowAddMenu(false);
    setCustomInput('');
  };
  const commitRename = (id: string) => {
    const v = editVal.trim();
    if (v) onRename(id, v);
    setEditingId(null);
  };

  return (
    <div
      style={{
        maxWidth: 624,
        width: '100%',
        margin: '0 auto',
        display: 'flex',
        alignItems: 'flex-end',
      }}
    >
      <div
        ref={scrollRef}
        className="ws-tabstrip-scroll"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          flex: 1,
          minWidth: 0,
          overflowX: 'auto',
          paddingBottom: 1,
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeId === tab.id;
          const isEditing = editingId === tab.id;
          return (
            <div
              key={tab.id}
              data-active={isActive}
              onClick={() => onSelect(tab.id)}
              onDoubleClick={
                !tab.main
                  ? (e) => {
                      e.stopPropagation();
                      setEditingId(tab.id);
                      setEditVal(tab.label);
                    }
                  : undefined
              }
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 13px',
                border: '1px solid',
                borderColor: isActive ? 'var(--border-1)' : 'transparent',
                borderBottom: isActive
                  ? '1px solid var(--bg-surface)'
                  : '1px solid var(--border-1)',
                background: isActive ? 'var(--bg-surface)' : 'var(--bg-canvas)',
                color: isActive ? 'var(--ink-1)' : 'var(--ink-3)',
                fontWeight: isActive ? 600 : 400,
                fontSize: 12.5,
                borderRadius: '8px 8px 0 0',
                marginBottom: -1,
                cursor: 'pointer',
                zIndex: isActive ? 2 : 1,
                position: 'relative',
                maxWidth: 190,
                flex: 'none',
                userSelect: 'none',
              }}
            >
              <Icon
                name={tab.main ? 'FileText' : 'File'}
                size={14}
                style={{ color: isActive ? 'var(--accent)' : 'var(--ink-4)', flex: 'none' }}
              />
              {isEditing ? (
                <input
                  autoFocus
                  value={editVal}
                  onChange={(e) => setEditVal(e.target.value)}
                  onBlur={() => commitRename(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(tab.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    fontSize: 12.5,
                    fontFamily: 'var(--font-sans)',
                    fontWeight: 600,
                    width: 100,
                    padding: 0,
                  }}
                />
              ) : (
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                >
                  {tab.label}
                </span>
              )}
              {!tab.main && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(tab.id);
                  }}
                  title="Remove document"
                  style={{
                    border: 'none',
                    background: 'none',
                    cursor: 'pointer',
                    display: 'grid',
                    placeItems: 'center',
                    color: 'var(--ink-4)',
                    padding: 1,
                    borderRadius: 4,
                    flex: 'none',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--bg-sunken)';
                    e.currentTarget.style.color = 'var(--critical)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'none';
                    e.currentTarget.style.color = 'var(--ink-4)';
                  }}
                >
                  <Icon name="X" size={11} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* + add document to packet */}
      <div
        ref={addRef}
        style={{ position: 'relative', marginLeft: 5, alignSelf: 'center', marginBottom: 1 }}
      >
        <button
          onClick={() => setShowAddMenu((s) => !s)}
          title="Add document to packet"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '6px 10px',
            border: '1px dashed var(--border-1)',
            background: 'transparent',
            color: 'var(--ink-3)',
            fontSize: 11.5,
            fontWeight: 600,
            borderRadius: 8,
            cursor: 'pointer',
            fontFamily: 'var(--font-sans)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--accent)';
            e.currentTarget.style.color = 'var(--accent)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-1)';
            e.currentTarget.style.color = 'var(--ink-3)';
          }}
        >
          <Icon name="Plus" size={13} />
          Add
        </button>
        {showAddMenu && (
          <div
            className="card"
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              zIndex: 60,
              width: 222,
              padding: 10,
              boxShadow: 'var(--shadow-2)',
            }}
          >
            <div
              style={{
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.07em',
                color: 'var(--ink-3)',
                fontWeight: 700,
                marginBottom: 7,
              }}
            >
              Add to packet
            </div>
            {PRESETS.map((ex) => (
              <button
                key={ex}
                onClick={() => add(ex)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '7px 8px',
                  border: 'none',
                  background: 'transparent',
                  borderRadius: 6,
                  cursor: 'pointer',
                  textAlign: 'left',
                  font: 'inherit',
                  fontSize: 12.5,
                  color: 'var(--ink-1)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-2)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <Icon name="File" size={13} style={{ color: 'var(--accent)', flex: 'none' }} />
                {ex}
              </button>
            ))}
            <div
              style={{
                borderTop: '1px solid var(--border-1)',
                marginTop: 6,
                paddingTop: 7,
                display: 'flex',
                gap: 5,
              }}
            >
              <input
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                placeholder="Custom name…"
                className="field"
                style={{
                  flex: 1,
                  padding: '5px 9px',
                  fontSize: 12,
                  fontFamily: 'var(--font-sans)',
                  background: 'var(--bg-surface)',
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customInput.trim()) add(customInput.trim());
                }}
                onClick={(e) => e.stopPropagation()}
              />
              <button
                className="btn sm"
                onClick={() => customInput.trim() && add(customInput.trim())}
                style={{ opacity: customInput.trim() ? 1 : 0.4 }}
              >
                <Icon name="Plus" size={12} />
              </button>
            </div>
            <div style={{ marginTop: 7, fontSize: 10.5, color: 'var(--ink-3)', lineHeight: 1.4 }}>
              Double-click a tab to rename · × to remove
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
