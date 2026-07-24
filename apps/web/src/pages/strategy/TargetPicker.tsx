/*
 * Searchable client-target picker for member/committee/agency-subject nodes
 * (NOD-7 field editor) — mirrors OwnerPicker's popover pattern. Selecting a
 * row snapshots that ClientTarget onto the node's targetRef so Execution
 * staging can resolve a REAL recipient instead of the bare subject category.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from './strategy-ui.js';
import { targetDisplayLabel, targetRefFromClientTarget, type ClientTargetLite } from './client-targets-lite.js';
import type { NodeTargetRef } from './types.js';

export function TargetPicker({
  targets,
  loading,
  value,
  onChange,
}: {
  targets: ClientTargetLite[];
  loading?: boolean;
  value: NodeTargetRef | null;
  onChange: (target: NodeTargetRef | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setQ('');
  };

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? targets.filter((t) => `${t.memberName ?? ''} ${t.committee ?? ''}`.toLowerCase().includes(needle))
    : targets;

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: 1,
            minWidth: 0,
            border: '1px solid var(--border-2)',
            borderRadius: 9,
            padding: '7px 11px',
            background: 'var(--bg-surface-2)',
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'var(--font-sans)',
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 'var(--text-base)',
              color: value ? 'var(--ink-1)' : 'var(--ink-3)',
              fontWeight: value ? 600 : 400,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {value ? targetDisplayLabel(value) : 'No target set'}
          </span>
          <Icon name="chevdown" size={14} color="var(--ink-3)" />
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            title="Clear target"
            style={{
              border: '1px solid var(--border-2)',
              borderRadius: 9,
              background: 'var(--bg-surface-2)',
              cursor: 'pointer',
              padding: '0 9px',
            }}
          >
            <Icon name="x" size={13} color="var(--ink-3)" />
          </button>
        )}
      </div>

      {open && (
        <>
          <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              zIndex: 61,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-2)',
              borderRadius: 9,
              boxShadow: '0 12px 30px rgba(12,26,56,0.18)',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: 8, borderBottom: '1px solid var(--border-1)' }}>
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search this client's targets…"
                style={{
                  width: '100%',
                  border: '1px solid var(--border-2)',
                  borderRadius: 7,
                  padding: '7px 10px',
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'var(--font-sans)',
                  color: 'var(--ink-1)',
                  background: 'var(--bg-surface)',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ maxHeight: 220, overflow: 'auto' }}>
              {loading ? (
                <div style={{ padding: '10px 12px', color: 'var(--ink-3)', fontSize: 'var(--text-sm)' }}>
                  Loading targets…
                </div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: '10px 12px', color: 'var(--ink-3)', fontSize: 'var(--text-sm)' }}>
                  {targets.length === 0
                    ? 'No targets on this client yet — add one from the client’s Targets tab.'
                    : 'No targets found.'}
                </div>
              ) : (
                filtered.map((t) => {
                  const selected = value?.clientTargetId === t.id || value?.memberId === t.memberId;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        onChange(targetRefFromClientTarget(t));
                        close();
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        padding: '8px 12px',
                        border: 'none',
                        background: selected ? 'var(--bg-surface-2)' : 'transparent',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 'var(--text-sm)',
                            fontWeight: 600,
                            color: 'var(--ink-1)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {t.memberName ?? t.memberId}
                        </span>
                        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)' }}>
                          {[t.party, t.state, t.chamber, t.committee].filter(Boolean).join(' · ') || '—'}
                        </span>
                      </span>
                      {selected && <Icon name="check" size={14} color="var(--accent)" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
