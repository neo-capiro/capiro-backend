import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { CapiroIconButton } from '../actions/index.js';

interface OverlayProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  /**
   * Override the shell's default width (560px modal / 480px drawer,
   * `primitives.css`). Additive — omit for the existing default; every
   * current caller does and is unaffected.
   */
  width?: number | string;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');
// Only the top dialog handles keyboard events when a review opens a preview.
const overlayStack: HTMLElement[] = [];
let overflowBeforeOverlays = '';

export function useDialogFocus(dialogRef: RefObject<HTMLElement | null>, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (overlayStack.length === 0) overflowBeforeOverlays = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const panel = dialogRef.current;
    if (panel) {
      overlayStack.push(panel);
      overlayStack.sort((a, b) => (a.contains(b) ? -1 : b.contains(a) ? 1 : 0));
      overlayStack.at(-1)?.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (overlayStack.at(-1) !== dialogRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(
        (element) =>
          !element.hasAttribute('disabled') &&
          !element.closest('[hidden]') &&
          element.tabIndex !== -1,
      );

      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (document.activeElement === dialogRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      if (panel) {
        const index = overlayStack.indexOf(panel);
        if (index >= 0) overlayStack.splice(index, 1);
      }
      document.removeEventListener('keydown', onKeyDown);
      if (overlayStack.length === 0) document.body.style.overflow = overflowBeforeOverlays;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
}

function OverlayBody({
  kind,
  title,
  children,
  onClose,
  width,
}: Omit<OverlayProps, 'open'> & { kind: 'modal' | 'drawer' }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useDialogFocus(dialogRef, onClose);

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
        style={
          width != null
            ? {
                width: typeof width === 'number' ? `min(${width}px, 100%)` : width,
                maxWidth: '100%',
              }
            : undefined
        }
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 12,
          }}
        >
          {/* Titles are built at the call site from live data ("Data health —
              {client.name}", "Fill with Meri — {clientName}"). A flex item's
              automatic minimum size is its min-content width, so a single long
              unbreakable token would push the close button out of the panel;
              .capiro-wrap-anywhere sets min-width:0 and lets it break. The close
              button holds its square via .capiro-icon-button's flex:0 0 auto. */}
          <h2 className="capiro-vnext-heading capiro-wrap-anywhere" style={{ fontSize: 17 }}>
            {title}
          </h2>
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
