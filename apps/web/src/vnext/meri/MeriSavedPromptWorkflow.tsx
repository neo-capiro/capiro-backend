import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { meriEffectiveIdentityKey } from '../../components/chat/meri-route-guards.js';
import { useApi } from '../../lib/use-api.js';
import { useImpersonation } from '../../state/impersonation.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { MeriIcon } from './meri-icons.js';
import {
  createMeriSavedPrompt,
  deleteMeriSavedPrompt,
  listMeriSavedPrompts,
  updateMeriSavedPrompt,
  type MeriSavedPrompt,
} from './meri-vnext-api.js';

function usePromptIdentity() {
  const { orgId, userId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  return meriEffectiveIdentityKey(actAsTenantSlug, orgId, userId);
}

function PromptDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (dialogRef.current?.querySelector<HTMLElement>('input, button') ?? dialogRef.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const fields = dialogRef.current?.querySelectorAll<HTMLElement>(
        ':is(button, input, textarea):not(:disabled)',
      );
      const first = fields?.[0];
      const last = fields?.[fields.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current?.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialogRef.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, []);
  return (
    <div className="vnext-meri__confirm-scrim" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        style={{ textAlign: 'left', color: '#101828' }}
        className="vnext-meri__confirm-dialog vnext-meri__client-note-dialog"
      >
        <div id={headingId} className="vnext-meri__confirm-title">
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

function PromptEditor({
  identityKey,
  prompt,
  body: initialBody,
  onClose,
}: {
  identityKey: string;
  prompt?: MeriSavedPrompt;
  body?: string;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useCapiroToast();
  const [title, setTitle] = useState(prompt?.title ?? '');
  const [body, setBody] = useState(prompt?.body ?? initialBody ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
    };
  }, []);
  const valid = Boolean(
    title.trim() && body.trim() && title.trim().length <= 160 && body.trim().length <= 24_000,
  );
  const save = async () => {
    if (!valid || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const request = new AbortController();
    requestRef.current = request;
    try {
      const input = { title: title.trim(), body: body.trim() };
      if (prompt) await updateMeriSavedPrompt(api, prompt.id, input, request.signal);
      else await createMeriSavedPrompt(api, input, request.signal);
      if (request.signal.aborted || !mountedRef.current) return;
      void queryClient.invalidateQueries({
        queryKey: ['meri-vnext', identityKey, 'saved-prompts'],
      });
      if (mountedRef.current) {
        toast.success(
          prompt
            ? 'Saved prompt updated.'
            : 'Prompt saved. Find it in Saved prompts or Start work.',
        );
        onClose();
      }
    } catch {
      if (mountedRef.current)
        setError('The prompt could not be saved. Your changes are still here. Try again.');
    } finally {
      if (requestRef.current === request) requestRef.current = null;
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };
  return (
    <PromptDialog
      title={prompt ? 'Edit saved prompt' : 'Save prompt'}
      onClose={() => {
        if (!savingRef.current) onClose();
      }}
    >
      <div className="vnext-meri__confirm-body">
        Save reusable instructions for your account. Reusing a prompt fills the message box for you
        to review and send. Client scope, files, and source selections are not saved with the
        prompt.
      </div>
      <label className="vnext-meri__client-note-field">
        <span>Prompt name</span>
        <input
          value={title}
          maxLength={160}
          disabled={saving}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="vnext-meri__client-note-field">
        <span>Prompt text</span>
        <textarea
          value={body}
          rows={7}
          disabled={saving}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      {body.trim().length > 24_000 ? (
        <div role="alert" className="vnext-meri__confirm-body">
          Shorten the prompt to 24,000 characters before saving.
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="vnext-meri__confirm-body">
          {error}
        </div>
      ) : null}
      <div className="vnext-meri__confirm-actions">
        <button
          type="button"
          className="vnext-meri__confirm-cancel"
          disabled={saving}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="vnext-meri__confirm-ok"
          disabled={saving || !valid}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : prompt ? 'Save changes' : 'Save prompt'}
        </button>
      </div>
    </PromptDialog>
  );
}

/** Keyed by effective identity: an account switch discards another account's editor. */
export function MeriSavePromptButton({ body }: { body: string }) {
  const identityKey = usePromptIdentity();
  return <SavePromptButton key={identityKey} identityKey={identityKey} body={body} />;
}

function SavePromptButton({ body, identityKey }: { body: string; identityKey: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="Save prompt"
        disabled={!body.trim()}
        onClick={() => setOpen(true)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          border: 0,
          background: 'transparent',
          padding: 0,
          fontSize: 11.5,
          fontWeight: 500,
          color: '#667085',
          cursor: 'pointer',
        }}
      >
        <MeriIcon name="Bookmark" size={13} />
        Save prompt
      </button>
      {open ? (
        <PromptEditor identityKey={identityKey} body={body} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

export function MeriSavedPromptManager(props: {
  onClose: () => void;
  onReuse: (body: string) => void;
  disabled?: boolean;
}) {
  const identityKey = usePromptIdentity();
  return <SavedPromptManager key={identityKey} identityKey={identityKey} {...props} />;
}

function SavedPromptManager({
  identityKey,
  onClose,
  onReuse,
  disabled = false,
}: {
  identityKey: string;
  onClose: () => void;
  onReuse: (body: string) => void;
  disabled?: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<MeriSavedPrompt | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deletingRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
    };
  }, []);
  const queryKey = ['meri-vnext', identityKey, 'saved-prompts'];
  const promptsQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => listMeriSavedPrompts(api, signal),
    staleTime: 30_000,
  });
  const closeEditor = useCallback(() => setEditing(null), []);
  const remove = async (prompt: MeriSavedPrompt) => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(prompt.id);
    setError(null);
    const request = new AbortController();
    requestRef.current = request;
    try {
      await deleteMeriSavedPrompt(api, prompt.id, request.signal);
      if (request.signal.aborted || !mountedRef.current) return;
      queryClient.setQueryData<MeriSavedPrompt[]>(queryKey, (current) =>
        current?.filter((row) => row.id !== prompt.id),
      );
      void queryClient.invalidateQueries({ queryKey });
    } catch {
      if (mountedRef.current) setError(`“${prompt.title}” could not be deleted. Try again.`);
    } finally {
      if (requestRef.current === request) requestRef.current = null;
      deletingRef.current = false;
      if (mountedRef.current) setDeleting(null);
    }
  };
  if (editing)
    return <PromptEditor identityKey={identityKey} prompt={editing} onClose={closeEditor} />;
  return (
    <PromptDialog
      title="Manage saved prompts"
      onClose={() => {
        if (!deletingRef.current) onClose();
      }}
    >
      <div className="vnext-meri__confirm-body">
        Rename or edit your prompts here. Use a prompt to fill an editable message with your current
        client and attachments.
      </div>
      {promptsQuery.isLoading ? <div role="status">Loading saved prompts…</div> : null}
      {promptsQuery.isError ? (
        <div role="alert">
          Saved prompts could not be loaded.{' '}
          <button type="button" onClick={() => void promptsQuery.refetch()}>
            Retry
          </button>
        </div>
      ) : null}
      {!promptsQuery.isLoading && !promptsQuery.isError && !promptsQuery.data?.length ? (
        <div className="vnext-meri__confirm-body">
          No saved prompts yet. Use Save prompt below one of your messages.
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="vnext-meri__confirm-body">
          {error}
        </div>
      ) : null}
      {(promptsQuery.data ?? []).map((prompt) => (
        <div key={prompt.id} style={{ borderTop: '1px solid #EAECF0', padding: '12px 0' }}>
          <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{prompt.title}</div>
          <p className="vnext-meri__confirm-body" style={{ overflowWrap: 'anywhere' }}>
            {prompt.body.slice(0, 180)}
            {prompt.body.length > 180 ? '…' : ''}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="vnext-meri__confirm-cancel"
              aria-label={`Use ${prompt.title}`}
              disabled={disabled || Boolean(deleting)}
              onClick={() => {
                onReuse(prompt.body);
                onClose();
              }}
            >
              Use prompt
            </button>
            <button
              type="button"
              className="vnext-meri__confirm-cancel"
              aria-label={`Edit ${prompt.title}`}
              disabled={Boolean(deleting)}
              onClick={() => {
                setError(null);
                setEditing(prompt);
              }}
            >
              Rename / edit
            </button>
            <button
              type="button"
              className="vnext-meri__confirm-cancel"
              aria-label={`Delete ${prompt.title}`}
              disabled={Boolean(deleting)}
              onClick={() => void remove(prompt)}
            >
              {deleting === prompt.id ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      ))}
      <div className="vnext-meri__confirm-actions">
        <button
          type="button"
          className="vnext-meri__confirm-cancel"
          disabled={Boolean(deleting)}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </PromptDialog>
  );
}
