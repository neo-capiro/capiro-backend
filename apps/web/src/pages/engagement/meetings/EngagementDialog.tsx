import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './engagement-dialog.css';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface EngagementDialogProps {
  open: boolean;
  eyebrow?: string;
  title: string;
  description?: string;
  width?: number | string;
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  dirty?: boolean;
  closeLabel?: string;
  onClose: () => void;
}

/**
 * Shared Engagement modal shell. It owns focus containment, Escape, scroll lock,
 * scrim behavior, and dirty-form protection so every design-system window behaves
 * consistently instead of relying on a mix of ad-hoc AntD and inline overlays.
 */
export function EngagementDialog({
  open,
  eyebrow,
  title,
  description,
  width = 620,
  children,
  footer,
  busy = false,
  dirty = false,
  closeLabel = 'Close',
  onClose,
}: EngagementDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeState = useRef({ busy, dirty, onClose });
  closeState.current = { busy, dirty, onClose };

  const requestClose = useCallback(() => {
    const state = closeState.current;
    if (state.busy) return;
    if (state.dirty && !window.confirm('Discard your unsaved changes?')) return;
    state.onClose();
  }, []);

  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel)?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null,
      );
      if (!nodes.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = priorOverflow;
      previousFocus.current?.focus();
    };
  }, [open, requestClose]);

  if (!open || typeof document === 'undefined') return null;

  const onScrimMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) requestClose();
  };

  return createPortal(
    <div className="engagement-dialog-layer" role="presentation" onMouseDown={onScrimMouseDown}>
      <div
        ref={panelRef}
        className="engagement-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        style={
          {
            '--engagement-dialog-width': typeof width === 'number' ? `${width}px` : width,
          } as CSSProperties
        }
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="engagement-dialog__header">
          <div className="engagement-dialog__heading">
            {eyebrow ? <span className="engagement-dialog__eyebrow">{eyebrow}</span> : null}
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button
            type="button"
            className="engagement-dialog__close"
            aria-label={closeLabel}
            disabled={busy}
            onClick={requestClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="engagement-dialog__body">{children}</div>
        {footer ? <footer className="engagement-dialog__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
