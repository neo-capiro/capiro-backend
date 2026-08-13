/**
 * One modal shell, five contents (§7.13). Shared: 14px radius, greyed header
 * with eyebrow/title/subtitle, scrollable body, footer with a standing note
 * plus Cancel and one primary action. Escape and backdrop close; focus is
 * trapped; dirty state prompts before discard.
 *
 * The scrim and panel also carry the surface-wide `.capiro-overlay` /
 * `.capiro-modal` names so this reads as the same object every other vNext
 * module uses. legiwatch.css still restates the below-780 full-height sheet:
 * the foundation's rules are (0,2,0) and every rule in legiwatch.css is (0,3,0)
 * through `.lw`, so the module's own base sizing would otherwise win the tie.
 */
import { useEffect, useRef, type ReactNode } from 'react';

export function LwModal({
  kind,
  eyebrow,
  title,
  subtitle,
  note,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  primaryTitle,
  onClose,
  dirty,
  children,
  width,
}: {
  kind: 'views' | 'watch' | 'transcription' | 'states' | 'how';
  eyebrow: string;
  title: string;
  subtitle: string;
  note: string;
  primaryLabel: string;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  primaryTitle?: string;
  onClose: () => void;
  dirty?: boolean;
  children: ReactNode;
  width?: number;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Escape closes (with dirty guard); focus trapped inside the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (dirty && !window.confirm('Discard unsaved changes?')) return;
        onClose();
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, dirty]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('button, [href], input, select')?.focus();
  }, []);

  return (
    <div
      className="capiro-overlay lw-modal-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          if (dirty && !window.confirm('Discard unsaved changes?')) return;
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className={`capiro-modal lw-modal lw-modal--${kind}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={width ? { width } : undefined}
      >
        <div className="lw-modal__head">
          <div className="lw-eyebrow">{eyebrow}</div>
          <h2 className="lw-modal__title">{title}</h2>
          <p className="lw-modal__sub">{subtitle}</p>
        </div>
        <div className="lw-modal__body">{children}</div>
        <div className="lw-modal__foot">
          <span className="lw-modal__note">{note}</span>
          <button type="button" className="lw-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="lw-btn lw-btn--primary"
            onClick={onPrimary}
            disabled={primaryDisabled}
            title={primaryTitle}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
