/*
 * Searchable org-member owner picker (CRT-6 create modal + NOD-7 node rail).
 * Avatar + name button → popover with an autofocused search filter and the
 * member list; selecting sets the owner (Clerk user id). "No members found."
 * empty state. A fixed backdrop closes it on outside click.
 */
import { useEffect, useRef, useState } from 'react';
import { Ava, Icon } from './strategy-ui.js';
import { initialsOf, memberName, type TenantMember } from './members.js';

export function OwnerPicker({
  members,
  value,
  onChange,
}: {
  members: TenantMember[];
  value: string | null;
  onChange: (clerkUserId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setQ(''); // clear the filter so reopening starts fresh
  };

  const name = memberName(members, value);
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? members.filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(needle))
    : members;

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          border: '1px solid var(--border-2)',
          borderRadius: 9,
          padding: '7px 11px',
          background: 'var(--bg-surface-2)',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <Ava id={initialsOf(name)} size={22} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 'var(--text-base)',
            color: 'var(--ink-1)',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {name}
        </span>
        <Icon name="chevdown" size={14} color="var(--ink-3)" />
      </button>

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
                placeholder="Search org members…"
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
              {filtered.length === 0 ? (
                <div
                  style={{ padding: '10px 12px', color: 'var(--ink-3)', fontSize: 'var(--text-sm)' }}
                >
                  No members found.
                </div>
              ) : (
                filtered.map((m) => (
                  <button
                    key={m.clerkUserId}
                    type="button"
                    onClick={() => {
                      onChange(m.clerkUserId);
                      setOpen(false);
                      setQ('');
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '8px 12px',
                      border: 'none',
                      background:
                        m.clerkUserId === value ? 'var(--bg-surface-2)' : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <Ava id={initialsOf(m.name)} size={22} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 'var(--text-sm)',
                          fontWeight: 600,
                          color: 'var(--ink-1)',
                        }}
                      >
                        {m.name}
                      </span>
                      <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)' }}>
                        {m.email}
                      </span>
                    </span>
                    {m.clerkUserId === value && <Icon name="check" size={14} color="var(--accent)" />}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
