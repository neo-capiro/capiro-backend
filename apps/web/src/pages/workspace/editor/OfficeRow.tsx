/**
 * Submission-targets office switcher (ported from the prototype `OfficeRow`,
 * asset_14). Renders ONLY when `cfg.personalize` (the single canonical
 * predicate, Q-ED-1). One chip per office from `cfg.offices` (active = accent);
 * "+ Office" adds another target (toast stub for now).
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ava, Icon } from '../kit.js';
import { useApi } from '../../../lib/use-api.js';
import { useDebouncedValue } from '../../../lib/use-debounced-value.js';

interface DirContactLite {
  id: string;
  fullName: string;
  memberName?: string;
  state?: string;
  district?: string;
  chamber?: string;
}

function initialsOf(name: string): string {
  return name
    .replace(/^(Rep\.|Sen\.)\s+/, '')
    .split(/\s+/)
    .map((x) => x[0])
    .filter(Boolean)
    .slice(-2)
    .join('')
    .toUpperCase();
}

export function OfficeRow({
  offices,
  active,
  onChange,
  onAddOffice,
}: {
  offices: string[];
  active: string | null;
  onChange: (who: string) => void;
  /** E-12: add a submission target (member name) to cfg.offices. */
  onAddOffice: (name: string) => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const dq = useDebouncedValue(q.trim(), 250);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const { data } = useQuery({
    queryKey: ['ws-editor-office-search', dq],
    enabled: open && dq.length > 0,
    placeholderData: (prev) => prev,
    queryFn: async () =>
      (
        await api.get<{ contacts: DirContactLite[] }>('/api/directory/contacts', {
          params: { q: dq, pageSize: 6, sort: 'name-asc' },
        })
      ).data,
  });
  const results = (data?.contacts ?? []).filter((c) => !offices.includes(c.fullName)).slice(0, 6);

  return (
    <div style={{ maxWidth: 624, width: '100%', margin: '0 auto 4px' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginBottom: 5 }}
      >
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--ink-3)',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            marginRight: 3,
          }}
        >
          Submission targets
        </span>
        {offices.map((who) => {
          const on = active === who;
          return (
            <button
              key={who}
              onClick={() => onChange(who)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px 4px 6px',
                borderRadius: 20,
                border: '1px solid',
                borderColor: on ? 'var(--accent)' : 'var(--border-1)',
                background: on ? 'var(--accent-soft)' : 'var(--bg-surface)',
                color: on ? 'var(--accent-ink)' : 'var(--ink-2)',
                fontSize: 12,
                fontWeight: on ? 600 : 400,
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
              }}
            >
              <Ava x={initialsOf(who)} size={18} />
              {who.replace(/^(Rep\.|Sen\.)\s+/, '')}
            </button>
          );
        })}
        <div ref={boxRef} style={{ position: 'relative' }}>
          <button
            className="btn sm btn-ghost"
            style={{ color: 'var(--ink-3)', fontSize: 11 }}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon name="Plus" size={12} />
            Office
          </button>
          {open && (
            <div
              className="card"
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                zIndex: 40,
                width: 280,
                padding: 6,
                boxShadow: 'var(--shadow-2)',
              }}
            >
              <div
                className="field"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 9px',
                  marginBottom: 6,
                  background: 'var(--bg-surface)',
                }}
              >
                <Icon name="Search" size={13} style={{ color: 'var(--ink-3)' }} />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search the directory by name"
                  style={{
                    flex: 1,
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    fontSize: 12.5,
                    fontFamily: 'var(--font-sans)',
                  }}
                />
              </div>
              {dq.length > 0 &&
                results.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      onAddOffice(c.fullName);
                      onChange(c.fullName);
                      setQ('');
                      setOpen(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 8px',
                      border: 'none',
                      background: 'transparent',
                      borderRadius: 6,
                      cursor: 'pointer',
                      font: 'inherit',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-2)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <Ava x={initialsOf(c.fullName)} size={20} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, display: 'block' }}>
                        {c.fullName}
                      </span>
                      <span style={{ fontSize: 10.5, color: 'var(--ink-3)' }} className="num">
                        {[c.state, c.district ? 'Dist ' + c.district : '', c.chamber]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <Icon name="Plus" size={12} style={{ color: 'var(--accent)' }} />
                  </button>
                ))}
              {dq.length > 0 && results.length === 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--ink-3)', padding: '8px 9px' }}>
                  No members found.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
