/*
 * Strategies vNext — ONE modal shell for all six overlays (STRATEGIES-HANDOFF §7.10).
 *
 * Header (eyebrow / title / subtitle / close), scrollable body, footer
 * (note-or-filename + Cancel + primary). Focus trap, Escape, backdrop click,
 * the dirty-state guard and route sync live HERE — never in a body. Bodies
 * declare `dirty` and `closeTo`; the shell decides when it is safe to leave.
 *
 * Why not CapiroModal (vnext/components/overlays)? The kit modal provides the
 * focus trap, Escape and backdrop click, but NOT route sync, NOT a dirty-state
 * guard, and not the §7.10 header/footer anatomy (eyebrow + subtitle + meta,
 * note-or-filename footer). This shell reuses the kit's trap pattern and adds
 * the Strategies contract on top — the thin module shell the build contract
 * allows when the kit primitive does not already do focus trap + route sync.
 *
 * Route sync: overlays are routes (§6). Closing navigates to `closeTo` (the
 * caller route), so browser back/forward re-opens and re-closes the overlay.
 * The router renders the caller beneath; this shell renders only the modal.
 *
 * v3 pass (design handoff 2026-08-16): frame geometry is now the exact shared
 * shell from the handoff's "Modals" section — fixed/inset:0, z-index:70, a
 * `rgba(12,17,29,.6)` backdrop, top-aligned + scrollable (not centered), the
 * two-part panel shadow, and the `stPop` entrance keyframe (strategies-tokens
 * .css). Each modal carries its own frame width via `maxWidth` (px) rather
 * than a two-value `size` enum — the six overlays differ enough (900–1080px)
 * that a binary md/lg no longer fit; see each overlay's call site for its
 * value from the handoff's per-modal table.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CapiroButton, CapiroIconButton } from '../../../components/actions/index.js';
import './modal-shell.css';

/** Lets the panel set its own `--st-modal-max-width` (a real CSS custom
 * property is not part of the DOM.CSSProperties typing). */
type ModalPanelStyle = CSSProperties & { '--st-modal-max-width'?: string };

/** Local `XClose` glyph (design handoff "Icons": `x-import ... name="XClose"`
 * on the header close button, size 18). The shared icon set
 * (`../../../components/icons/index.tsx`) has no close/X entry, and adding
 * one there is out of scope for this pass — that file is shared, not owned
 * here. Mirrors its stroke convention (24x24 viewBox, currentColor, 1.75
 * stroke — see the glyph functions atop StrategyLibraryVNext.tsx) as a
 * self-contained, file-local glyph instead. */
function CloseGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface StrategiesModalShellProps {
  /** Small uppercase kicker above the title (e.g. "NEW STRATEGY"). */
  eyebrow: string;
  title: string;
  subtitle?: ReactNode;
  /** Right-of-header content (e.g. the "CURRENT · REV 42" chip in History). */
  headerMeta?: ReactNode;
  /** Body — the overlay-specific form/panels. Scrolled by the shell. */
  children: ReactNode;
  /** Footer left: policy note or the export filename field. */
  footerNote?: ReactNode;
  primaryLabel: ReactNode;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  primaryBusy?: boolean;
  cancelLabel?: string;
  /** Caller route (§6) — closing the overlay navigates here. */
  closeTo: string;
  /** When true, close gestures (Escape / backdrop / × / Cancel) ask first. */
  dirty?: boolean;
  /** Panel max-width in px — one per modal, per the handoff's per-modal table
   * (README "Modals" / reference `modalVals` meta.w): new 1000, phases 960,
   * export 980, history 1080, upload 960, conflict 900. */
  maxWidth: number;
  /** Resolve-conflict is the one modal whose primary is solid red instead of
   * the dark gradient (`modalVals` meta.conflict.bg: '#B42318'). Every other
   * modal leaves this false and keeps the standard gradient primary. */
  primaryDanger?: boolean;
}

export function StrategiesModalShell({
  eyebrow,
  title,
  subtitle,
  headerMeta,
  children,
  footerNote,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  primaryBusy = false,
  cancelLabel = 'Cancel',
  closeTo,
  dirty = false,
  maxWidth,
  primaryDanger = false,
}: StrategiesModalShellProps) {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState(false);

  /* Route sync: the ONLY way out of an overlay is back to its caller route. */
  const close = useCallback(() => {
    navigate(closeTo);
  }, [navigate, closeTo]);

  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirming(true);
      return;
    }
    close();
  }, [dirty, close]);

  /* A successful save/clear resets the guard without a navigation. */
  useEffect(() => {
    if (!dirty) setConfirming(false);
  }, [dirty]);

  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestCloseRef.current();
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
      className="capiro-strategies st-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="st-modal"
        style={{ '--st-modal-max-width': `${maxWidth}px` } as ModalPanelStyle}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="st-modal__header">
          <div>
            <p className="st-modal__eyebrow">{eyebrow}</p>
            <h2 className="st-modal__title">{title}</h2>
            {subtitle ? <p className="st-modal__subtitle">{subtitle}</p> : null}
          </div>
          <div className="st-modal__header-side">
            {headerMeta}
            <CapiroIconButton label="Close" icon={<CloseGlyph size={18} />} onClick={requestClose} />
          </div>
        </header>

        <div className="st-modal__body">{children}</div>

        {confirming ? (
          <div className="st-modal__guard" role="alertdialog" aria-label="Discard unsaved changes?">
            <span>
              <strong>Discard unsaved changes?</strong> Your edits in this dialog are not saved.
            </span>
            <span className="st-modal__guard-actions">
              <CapiroButton size="compact" variant="secondary" onClick={() => setConfirming(false)}>
                Keep editing
              </CapiroButton>
              <CapiroButton size="compact" variant="primary" onClick={close}>
                Discard changes
              </CapiroButton>
            </span>
          </div>
        ) : null}

        <footer className="st-modal__footer">
          <div className="st-modal__footer-note">{footerNote}</div>
          <div className="st-modal__footer-actions">
            <CapiroButton variant="quiet" onClick={requestClose}>
              {cancelLabel}
            </CapiroButton>
            {onPrimary ? (
              <CapiroButton
                variant="primary"
                className={primaryDanger ? 'st-modal__primary--danger' : undefined}
                onClick={onPrimary}
                disabled={primaryDisabled}
                loading={primaryBusy}
              >
                {primaryLabel}
              </CapiroButton>
            ) : null}
          </div>
        </footer>
      </section>
    </div>
  );
}
