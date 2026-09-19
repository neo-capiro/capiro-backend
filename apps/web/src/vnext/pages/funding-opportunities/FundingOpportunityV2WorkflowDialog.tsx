import { useEffect, useRef, useState, type RefObject } from 'react';
import type { FundingOpportunityResultRow } from './FundingOpportunityV2ResultCard.js';

export type FundingOpportunityWorkflowDialogAction = 'follow_up' | 'assign_owner' | 'note';
export type FundingOpportunityWorkflowPatch = {
  ownerUserId?: string | null;
  notes?: string | null;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
};
export interface FundingOpportunityWorkflowMember {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

interface Props {
  row: FundingOpportunityResultRow;
  action: FundingOpportunityWorkflowDialogAction;
  teamMembers: FundingOpportunityWorkflowMember[];
  busy: boolean;
  error: string | null;
  onSubmit: (patch: FundingOpportunityWorkflowPatch) => void | Promise<void>;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  teamMembersLoading?: boolean;
  teamMembersError?: boolean;
  onRetryTeamMembers?: () => void;
}

function memberName(member: FundingOpportunityWorkflowMember): string {
  const name = [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
  return name || member.email;
}

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled])')];
}

export function FundingOpportunityV2WorkflowDialog({ row, action, teamMembers, busy, error, onSubmit, onClose, returnFocusRef, teamMembersLoading = false, teamMembersError = false, onRetryTeamMembers }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const busyRef = useRef(busy);
  const closeRef = useRef(onClose);
  const [date, setDate] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [notes, setNotes] = useState('');
  busyRef.current = busy;
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    focusable(dialog)[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusable(dialog);
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, []);

  const followUpInvalid = action === 'follow_up' && (!date || !nextAction.trim());
  const noteInvalid = action === 'note' && !notes.trim();
  const ownerInvalid = action === 'assign_owner' && (!ownerUserId || teamMembersLoading || teamMembersError);
  const disabled = busy || followUpInvalid || noteInvalid || ownerInvalid;
  const title = action === 'follow_up' ? 'Set follow-up' : action === 'assign_owner' ? 'Assign owner' : 'Add note';

  function submit() {
    if (disabled) return;
    if (action === 'follow_up') {
      void onSubmit({ nextAction: nextAction.trim(), nextActionDueAt: `${date}T00:00:00.000Z` });
    } else if (action === 'assign_owner') {
      void onSubmit({ ownerUserId });
    } else {
      void onSubmit({ notes: notes.trim() });
    }
  }

  return (
    <div className="fo-v2-detail-modal-backdrop" role="presentation">
      <div ref={dialogRef} className="fo-v2-detail-modal" role="dialog" aria-modal="true" aria-labelledby="fo-v2-workflow-title">
        <header>
          <div>
            <span className="fo-v2-detail-eyebrow">Workflow</span>
            <h2 id="fo-v2-workflow-title">{title}</h2>
            <p>{row.title}</p>
          </div>
          <button className="fo-v2-detail-icon-button" aria-label={`Close ${title}`} disabled={busy} onClick={onClose}>×</button>
        </header>
        <div className="fo-v2-detail-modal__body">
          {action === 'follow_up' ? <>
            <label>Follow-up date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} disabled={busy} /></label>
            <label>Next action<input value={nextAction} onChange={(event) => setNextAction(event.target.value)} disabled={busy} placeholder="What should happen next?" /></label>
          </> : null}
          {action === 'assign_owner' ? <div className="fo-v2-workflow-owner-field"><label htmlFor="fo-v2-workflow-owner">Owner</label>{teamMembersLoading ? <p>Loading team members…</p> : teamMembersError ? <div className="fo-v2-workflow-owner-error"><p role="alert">Team members could not be loaded.</p><button type="button" onClick={onRetryTeamMembers} disabled={busy}>Retry team members</button></div> : <select id="fo-v2-workflow-owner" value={ownerUserId} onChange={(event) => setOwnerUserId(event.target.value)} disabled={busy}><option value="">Choose a team member</option>{teamMembers.map((member) => <option key={member.userId} value={member.userId}>{memberName(member)}</option>)}</select>}</div> : null}
          {action === 'note' ? <label>Note<textarea value={notes} onChange={(event) => setNotes(event.target.value)} disabled={busy} placeholder="Anything the next operator needs to know." /></label> : null}
          {error ? <p role="alert" className="fo-v2-detail-modal__error">{error}</p> : null}
        </div>
        <footer>
          <button className="fo-v2-detail-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="fo-v2-detail-button fo-v2-detail-button--dark" disabled={disabled} onClick={submit}>{busy ? 'Saving…' : 'Save'}</button>
        </footer>
      </div>
    </div>
  );
}
