import { useEffect, useRef, type ReactNode } from 'react';
import { CapiroIconButton } from '../actions/index.js';

interface OverlayProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function OverlayBody({ kind, title, children, onClose }: Omit<OverlayProps, 'open'> & { kind: 'modal' | 'drawer' }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => !element.hasAttribute('disabled') && element.tabIndex !== -1);

      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      className="capiro-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className={`${kind === 'modal' ? 'capiro-modal' : 'capiro-drawer'} capiro-elevation-widget`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          {/* Titles are built at the call site from live data ("Data health —
              {client.name}", "Fill with Meri — {clientName}"). A flex item's
              automatic minimum size is its min-content width, so a single long
              unbreakable token would push the close button out of the panel;
              .capiro-wrap-anywhere sets min-width:0 and lets it break. The close
              button holds its square via .capiro-icon-button's flex:0 0 auto. */}
          <h2 className="capiro-vnext-heading capiro-wrap-anywhere" style={{ fontSize: 17 }}>{title}</h2>
          <CapiroIconButton label="Close" icon="×" onClick={onClose} />
        </div>
        {children}
      </section>
    </div>
  );
}

export function CapiroModal({ open, ...props }: OverlayProps) {
  return open ? <OverlayBody kind="modal" {...props} /> : null;
}

export function CapiroDrawer({ open, ...props }: OverlayProps) {
  return open ? <OverlayBody kind="drawer" {...props} /> : null;
}
