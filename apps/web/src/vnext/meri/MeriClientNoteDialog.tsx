import { useEffect, useRef, useState } from 'react';

export interface MeriClientNoteDraft {
  client: { id: string; name: string };
  title: string;
  body: string;
}

/** Prepare a request; only the canonical save_note action can report a saved note. */
export function clientNoteComposerText(note: MeriClientNoteDraft): string {
  return [
    `Save the following note under client ${JSON.stringify(note.client.name)}.`,
    `File this only under that client. If the conversation is scoped to a different client, ask me to switch back before saving. If the name identifies more than one client, ask me which record.`,
    note.title.trim() ? `Note title: ${note.title.trim()}` : '',
    `Note content:\n${note.body.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

interface MeriClientNoteDialogProps {
  clients: Array<{ id: string; name: string }>;
  initialClientId: string | null;
  onCancel: () => void;
  onPrepare: (note: MeriClientNoteDraft) => void;
  preparing: boolean;
  error: string | null;
  currentClientId: string | null;
  stagedAttachmentCount: number;
}

export function MeriClientNoteDialog({
  clients,
  initialClientId,
  onCancel,
  onPrepare,
  preparing,
  error,
  currentClientId,
  stagedAttachmentCount,
}: MeriClientNoteDialogProps) {
  // The target belongs to this note; a top-bar scope change must not retarget it.
  const [clientId, setClientId] = useState(initialClientId ?? '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const client = clients.find((candidate) => candidate.id === clientId);

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    bodyRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      );
      const first = focusable?.[0];
      const last = focusable?.[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
    };
  }, [onCancel]);

  return (
    <div className="vnext-meri__confirm-scrim" role="presentation">
      <div
        ref={dialogRef}
        className="vnext-meri__confirm-dialog vnext-meri__client-note-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meri-client-note-title"
        aria-describedby="meri-client-note-description"
      >
        <div id="meri-client-note-title" className="vnext-meri__confirm-title">
          File a client note
        </div>
        <div id="meri-client-note-description" className="vnext-meri__confirm-body">
          Choose the client and add your notes. This prepares an editable message to Meri. The note
          is saved only after the save action succeeds; any required review appears in the
          conversation.
        </div>
        <label className="vnext-meri__client-note-field">
          <span>Client</span>
          <select
            disabled={preparing}
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          >
            <option value="">Choose a client</option>
            {clients.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        {clients.length === 0 ? (
          <div role="status" className="vnext-meri__confirm-body">
            No client records are available. Select an available client before filing a note.
          </div>
        ) : null}
        <label className="vnext-meri__client-note-field">
          <span>Title (optional)</span>
          <input
            value={title}
            maxLength={160}
            disabled={preparing}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Sen. Wyden engagement"
          />
        </label>
        <label className="vnext-meri__client-note-field">
          <span>Notes</span>
          <textarea
            ref={bodyRef}
            value={body}
            rows={6}
            maxLength={40_000}
            disabled={preparing}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Add what happened, commitments, owners, and follow-up dates…"
          />
        </label>
        <div className="vnext-meri__confirm-body">
          Preparing the note also sets this conversation to the chosen client.
        </div>
        {client && client.id !== currentClientId && stagedAttachmentCount > 0 ? (
          <div className="vnext-meri__confirm-body">
            Changing the client removes the {stagedAttachmentCount} staged{' '}
            {stagedAttachmentCount === 1 ? 'attachment' : 'attachments'} from this draft. Attach
            them again under the intended client.
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="vnext-meri__confirm-body">
            {error}
          </div>
        ) : null}
        <div className="vnext-meri__confirm-actions">
          <button type="button" className="vnext-meri__confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="vnext-meri__confirm-ok"
            disabled={preparing || !client || !body.trim()}
            onClick={() => {
              if (client && body.trim()) onPrepare({ client, title, body });
            }}
          >
            {preparing ? 'Preparing…' : 'Add to message'}
          </button>
        </div>
      </div>
    </div>
  );
}
