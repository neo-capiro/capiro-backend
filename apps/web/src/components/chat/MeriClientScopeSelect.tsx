import { useEffect, useRef, useState } from 'react';

export interface MeriClientOption {
  id: string;
  name: string;
}

export function MeriClientScopeSelect({
  clients,
  value,
  onChange,
}: {
  clients: MeriClientOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = clients.find((client) => client.id === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="meri-scope-select" ref={rootRef}>
      <button
        type="button"
        className="meri-scope-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        title="Client scope"
      >
        <span>{selected?.name ?? 'General (no client)'}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="meri-scope-menu" role="listbox" aria-label="Client scope">
          {[{ id: '', name: 'General (no client)' }, ...clients].map((client) => (
            <button
              key={client.id || '__general__'}
              type="button"
              role="option"
              aria-selected={value === client.id}
              onClick={() => {
                onChange(client.id);
                setOpen(false);
              }}
            >
              <span>{client.name}</span>
              {value === client.id ? <span aria-hidden="true">✓</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
