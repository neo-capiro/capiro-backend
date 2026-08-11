import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

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
  items: readonly CapiroTabItem[];
  activeId: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const moveFocus = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const list = event.currentTarget.parentElement;
    if (!list) return;
    const enabled = Array.from(
      list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
    );
    const currentIndex = enabled.indexOf(event.currentTarget);
    if (currentIndex < 0 || enabled.length === 0) return;

    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % enabled.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = enabled.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const next = enabled[nextIndex]!;
    next.focus();
    const nextId = next.dataset.tabId;
    if (nextId) onChange(nextId);
  };

  return (
    <div className="capiro-tabs" role="tablist" aria-label={label}>
      {items.map((item) => {
        const selected = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            className="capiro-tab"
            role="tab"
            data-tab-id={item.id}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            onKeyDown={moveFocus}
          >
            {item.label}
          </button>
        );
      })}
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

export function CapiroMenu({ items, label }: { items: readonly CapiroMenuItem[]; label: string }) {
  const handleKeyboard = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const enabled = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]):not(:disabled)'),
    );
    if (enabled.length === 0) return;

    const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const currentIndex = current ? enabled.indexOf(current) : -1;
    let nextIndex = 0;
    if (event.key === 'End') nextIndex = enabled.length - 1;
    if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % enabled.length;
    if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? enabled.length - 1 : (currentIndex - 1 + enabled.length) % enabled.length;

    event.preventDefault();
    enabled[nextIndex]!.focus();
  };

  return (
    <ul className="capiro-menu" role="menu" aria-label={label} onKeyDown={handleKeyboard}>
      {items.map((item) => (
        <li key={item.id} role="none">
          {item.href ? (
            <a
              role="menuitem"
              href={item.href}
              aria-disabled={item.disabled || undefined}
              tabIndex={item.disabled ? -1 : 0}
              onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
                if (item.disabled) {
                  event.preventDefault();
                  return;
                }
                item.onSelect?.();
              }}
            >
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
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
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
    <span className="capiro-popover" ref={rootRef}>
      <button
        type="button"
        className="capiro-popover__trigger"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open ? (
        <div id={panelId} role="dialog" aria-label={label} className="capiro-popover__panel capiro-elevation-control">
          {children}
        </div>
      ) : null}
    </span>
  );
}
