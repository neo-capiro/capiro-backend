import { useEffect } from 'react';
import { MeriIcon } from './meri-icons.js';
import type { MeriContextPacket } from './meri-vnext-api.js';

interface MeriContextSheetProps {
  open: boolean;
  packet: MeriContextPacket | null;
  loading: boolean;
  error: boolean;
  onClose: () => void;
}

/**
 * Read-only context inspector for a durable conversation packet. Context is
 * compiled server-side; this sheet never pretends a browser toggle can change
 * what the next model turn receives.
 */
export function MeriContextSheet({
  open,
  packet,
  loading,
  error,
  onClose,
}: MeriContextSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="vnext-meri__confirm-scrim" role="presentation">
      <section
        className="vnext-meri__confirm-dialog vnext-meri__context-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meri-context-sheet-title"
      >
        <div className="vnext-meri__context-sheet-head">
          <div>
            <div className="vnext-meri__section-label">CONTEXT PACKET</div>
            <h2 id="meri-context-sheet-title">Manage context</h2>
          </div>
          <button type="button" className="vnext-meri__icon-btn" aria-label="Close context sheet" onClick={onClose}>
            <MeriIcon name="XClose" size={15} color="#667085" />
          </button>
        </div>
        <p className="vnext-meri__context-sheet-note">
          This is the latest server-compiled context for this thread. Context is applied by the
          retrieval service; changes to source membership require an explicit server action and are
          not fabricated in the browser.
        </p>
        {loading ? <div className="vnext-meri__ctx-empty">Loading context packet…</div> : null}
        {error ? <div className="vnext-meri__ctx-empty">Context provenance could not be loaded.</div> : null}
        {packet && !loading && !error ? (
          <>
            {packet.degraded ? (
              <div className="vnext-meri__attachment-notice" role="alert">
                {packet.degradedReason ?? 'The context packet is degraded.'}
              </div>
            ) : null}
            <div className="vnext-meri__context-sheet-label">INCLUDED · {packet.items.length}</div>
            <div className="vnext-meri__context-sheet-list">
              {packet.items.map((item) => (
                <article key={item.id} className="vnext-meri__context-sheet-item">
                  <div className="vnext-meri__context-sheet-item-title">{item.label}</div>
                  <div className="vnext-meri__context-sheet-item-meta">
                    {item.type.replace(/_/g, ' ').toUpperCase()} · {item.scope.toUpperCase()} · {item.selection.toUpperCase()}
                  </div>
                  {item.rationale ? <div className="vnext-meri__context-sheet-item-body">{item.rationale}</div> : null}
                </article>
              ))}
            </div>
            <div className="vnext-meri__context-sheet-label">EXCLUDED · {packet.exclusions.length}</div>
            {packet.exclusions.length ? (
              <div className="vnext-meri__context-sheet-list">
                {packet.exclusions.map((item, index) => (
                  <article key={`${item.id ?? item.label}-${index}`} className="vnext-meri__context-sheet-item is-excluded">
                    <div className="vnext-meri__context-sheet-item-title">{item.label}</div>
                    <div className="vnext-meri__context-sheet-item-meta">{item.reason.replace(/_/g, ' ').toUpperCase()}</div>
                  </article>
                ))}
              </div>
            ) : <div className="vnext-meri__ctx-empty">No context items were excluded.</div>}
          </>
        ) : null}
        <div className="vnext-meri__confirm-actions">
          <button type="button" className="vnext-meri__confirm-cancel" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}
