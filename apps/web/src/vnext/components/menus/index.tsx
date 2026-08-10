import { useId, useState, type ReactNode } from 'react';

export interface CapiroTabItem {
  id: string;
  label: string;
  disabled?: boolean;
}

export function CapiroTabs({
  items,
  activeId,
  onChange,
  label,
}: {
  items: CapiroTabItem[];
  activeId: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div className="capiro-tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="capiro-tab"
          role="tab"
          aria-selected={item.id === activeId}
          disabled={item.disabled}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function CapiroTooltip({ content, children }: { content: string; children: ReactNode }) {
  return <span title={content}>{children}</span>;
}

export interface CapiroMenuItem {
  id: string;
  label: string;
  onSelect?: () => void;
  href?: string;
  disabled?: boolean;
}

export function CapiroMenu({ items, label }: { items: CapiroMenuItem[]; label: string }) {
  return (
    <ul className="capiro-menu" role="menu" aria-label={label}>
      {items.map((item) => (
        <li key={item.id} role="none">
          {item.href ? (
            <a role="menuitem" href={item.href} aria-disabled={item.disabled || undefined}>
              {item.label}
            </a>
          ) : (
            <button role="menuitem" type="button" disabled={item.disabled} onClick={item.onSelect}>
              {item.label}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function CapiroPopover({
  trigger,
  children,
  label = 'Popover',
}: {
  trigger: ReactNode;
  children: ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <span className="capiro-popover">
      <span
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
      >
        {trigger}
      </span>
      {open ? (
        <span id={panelId} role="dialog" aria-label={label} className="capiro-popover__panel capiro-elevation-control">
          {children}
        </span>
      ) : null}
    </span>
  );
}
