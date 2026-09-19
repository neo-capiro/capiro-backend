import { useEffect, useRef, useState, type RefObject } from 'react';
import { PURSUIT_REASONS } from './funding-opportunities-v2-pursuit.js';
import { FundingOpportunityV2Icon } from './funding-opportunities-v2-icons.js';

export interface FundingOpportunityV2NotFitDialogProps {
  title: string;
  clientId: string | null;
  source: import('@capiro/shared').OpportunitySourceV2;
  sourceRecordId: string;
  busy: boolean;
  error: string | null;
  onSubmit: (input: { clientId: string; source: string; sourceRecordId: string; reason: string; note: string | null }) => void | Promise<void>;
  onChooseClient: () => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled])')];
}

export function FundingOpportunityV2NotFitDialog({ title, clientId, source, sourceRecordId, busy, error, onSubmit, onChooseClient, onClose, returnFocusRef }: FundingOpportunityV2NotFitDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    focusable(dialog)[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const nodes = focusable(dialog);
      if (!nodes.length) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => { dialog.removeEventListener('keydown', onKeyDown); const target = triggerRef.current; if (target?.isConnected) target.focus(); };
  }, []);

  return (
    <div className="fo-v2-detail-modal-backdrop" role="presentation">
      <div ref={dialogRef} className="fo-v2-detail-modal" role="dialog" aria-modal="true" aria-labelledby="fo-v2-not-fit-title">
        <header>
          <div>
            <span className="fo-v2-detail-eyebrow">Workflow</span>
            <h2 id="fo-v2-not-fit-title">Not a fit — record a reason</h2>
            <p>{title}</p>
          </div>
          <button className="fo-v2-detail-icon-button" aria-label="Close not a fit dialog" disabled={busy} onClick={onClose}><FundingOpportunityV2Icon name="XClose" size={18} /></button>
        </header>
        <div className="fo-v2-detail-modal__body">
          {!clientId ? <p role="alert">Choose a client before recording this decision.</p> : null}
          {!clientId ? <button className="fo-v2-detail-button" onClick={onChooseClient}>Choose a client</button> : null}
          <fieldset disabled={busy || !clientId}>
            <legend>Reason — required</legend>
            {PURSUIT_REASONS.map((option) => <label key={option.key}><input type="radio" name="v2-not-fit-reason" checked={reason === option.key} onChange={() => setReason(option.key)} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}
          </fieldset>
          <label>Note — optional<textarea value={note} onChange={(event) => setNote(event.target.value)} disabled={busy || !clientId} placeholder="Anything the next operator needs to know." /></label>
          {error ? <p role="alert" className="fo-v2-detail-modal__error">{error}</p> : null}
        </div>
        <footer>
          <span>Actor, timestamp, client, record and reason are recorded.</span>
          <button className="fo-v2-detail-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="fo-v2-detail-button fo-v2-detail-button--dark" disabled={busy || !clientId || !reason} onClick={() => clientId && void onSubmit({ clientId, source, sourceRecordId, reason, note: note.trim() || null })}>{busy ? 'Recording…' : 'Record the decision'}</button>
        </footer>
      </div>
    </div>
  );
}
