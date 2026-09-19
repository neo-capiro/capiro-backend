import { useEffect, useRef, useState, type RefObject } from 'react';
import { FundingOpportunityV2Icon } from './funding-opportunities-v2-icons.js';
import type { FundingOpportunityV2DetailSource, FundingOpportunityV2ExternalAudit } from './funding-opportunities-v2-detail-types.js';

export interface FundingOpportunityV2ExternalConfirmationProps {
  destination: { kind: string; label?: string; url: string | null; note: string };
  source: FundingOpportunityV2DetailSource;
  sourceRecordId: string;
  clientId: string | null;
  onExternalAudit: FundingOpportunityV2ExternalAudit;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled])')];
}

export function FundingOpportunityV2ExternalConfirmation({
  destination,
  source,
  sourceRecordId,
  clientId,
  onExternalAudit,
  onClose,
  returnFocusRef,
}: FundingOpportunityV2ExternalConfirmationProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const auditInFlight = useRef(false);
  const busyRef = useRef(false);
  const closeRef = useRef(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  busyRef.current = busy;
  closeRef.current = onClose;

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    focusable(modal)[0]?.focus();
    if (!modal.hasAttribute('tabindex')) modal.tabIndex = -1;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (busyRef.current) { modal.focus(); return; }
        closeRef.current();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const nodes = focusable(modal);
      if (!nodes.length) { event.preventDefault(); modal.focus(); return; }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onEscape, true);
    modal.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onEscape, true);
      modal.removeEventListener('keydown', onKeyDown);
      triggerRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    if (busy) requestAnimationFrame(() => modalRef.current?.focus());
  }, [busy]);

  async function continueToSource() {
    if (busy || auditInFlight.current) return;
    auditInFlight.current = true;
    setBusy(true);
    setError(null);
    // Reserve the popup synchronously from the user gesture. `noopener` makes
    // Chromium return null even when it created the tab, which leaves an
    // uncloseable blank tab and tempts the caller to open a second tab. Detach
    // the opener after reserving the real handle instead.
    const popup = window.open('', '_blank');
    if (popup) {
      try { popup.opener = null; } catch { /* cross-window hardening is best effort */ }
    }
    try {
      const audited = await onExternalAudit({ source, sourceRecordId, clientId, destinationKind: destination.kind });
      if (popup && !popup.closed) {
        // Navigate the reserved tab through a noreferrer anchor. Directly
        // assigning popup.location preserves the preview page as Referer;
        // the audited source must receive no caller referrer.
        const targetDocument = popup.document;
        const anchor = targetDocument.createElement('a');
        anchor.href = audited.authoritativeUrl;
        anchor.target = '_self';
        anchor.rel = 'noreferrer';
        anchor.textContent = 'Continue';
        targetDocument.body.replaceChildren(anchor);
        anchor.click();
      } else {
        throw new Error('The browser blocked the source window.');
      }
      onClose();
    } catch {
      if (popup && !popup.closed) popup.close();
      setError('The source click could not be recorded. Stay here and try again.');
    } finally {
      auditInFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="fo-v2-detail-modal-backdrop" role="presentation">
      <div ref={modalRef} className="fo-v2-detail-modal" role="dialog" aria-modal="true" aria-labelledby="fo-v2-external-title" tabIndex={-1}>
        <header>
          <div>
            <span className="fo-v2-detail-eyebrow">External destination</span>
            <h2 id="fo-v2-external-title">You are leaving Capiro</h2>
          </div>
          <button className="fo-v2-detail-icon-button" aria-label="Close external confirmation" disabled={busy} onClick={onClose}><FundingOpportunityV2Icon name="XClose" size={20} /></button>
        </header>
        <div className="fo-v2-detail-modal__body">
          <strong>{destination.label ?? destination.kind}</strong>
          <code>{destination.url}</code>
          <p>{destination.note} Capiro does not record a submission.</p>
          {error ? <p role="alert" className="fo-v2-detail-modal__error">{error}</p> : null}
        </div>
        <footer>
          <button className="fo-v2-detail-button" disabled={busy} onClick={onClose}>Stay here</button>
          <button className="fo-v2-detail-button fo-v2-detail-button--dark" disabled={busy} onClick={() => void continueToSource()}>{busy ? 'Recording…' : 'Continue'} <FundingOpportunityV2Icon name="LinkExternal01" size={16} /></button>
        </footer>
      </div>
    </div>
  );
}
