import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroDrawer, CapiroModal } from '../../components/overlays/index.js';
import { useApi } from '../../../lib/use-api.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import {
  HIERARCHY_LEVELS,
  LEVEL_META,
  placementLabel,
  type ClientPerson,
  type HierarchyLevel,
} from '../../adapters/legacy/useClientOrganizationModel.js';
import { LogActivityModal } from './ClientCrmHistory.js';
import { EmailComposeModal } from './EmailComposeModal.js';
import { listMailThreads, mailThreadsKey } from './mail-api.js';

/**
 * Person profile drawer — Figma `907:2919`.
 *
 * Contract §7 previously said this must NOT become a mini CRM activity
 * profile ("do not re-add redundant fields such as activity history…").
 * Reversed at Jordan's explicit request: a Mail action (opens
 * `EmailComposeModal`, pre-filled to this person), a Note action (opens the
 * Timeline's own `LogActivityModal` pre-set to this person), and a compact
 * message-history panel — the same `MailThread` data the client's Timeline
 * tab reads, filtered to this one person's address via the `recipientEmails`
 * param `listMailThreads` already accepts.
 */
export function ClientPersonDrawer({
  clientId,
  person,
  people,
  onClose,
  onSave,
  onPlace,
  onDelete,
}: {
  clientId: string;
  person: ClientPerson | null;
  people: ClientPerson[];
  onClose: () => void;
  onSave: (values: Record<string, unknown>) => Promise<unknown>;
  onPlace?: (values: {
    hierarchyLevel?: HierarchyLevel | null;
    reportsToPersonId?: string | null;
    resetToAutomatic?: boolean;
  }) => Promise<unknown>;
  onDelete?: () => Promise<unknown>;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const [mailOpen, setMailOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [form, setForm] = useState({
    name: person?.name ?? '',
    title: person?.title ?? '',
    email: person?.email ?? '',
    phone: person?.phone ?? '',
    role: person?.role ?? '',
    notes: person?.notes ?? '',
  });
  const [level, setLevel] = useState<HierarchyLevel | ''>(person?.hierarchyLevel ?? '');
  const [manager, setManager] = useState<string>(person?.reportsToPersonId ?? '');
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placementError, setPlacementError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const set = (key: keyof typeof form, value: string) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
  };

  const history = useQuery({
    enabled: Boolean(person?.email),
    queryKey: mailThreadsKey(clientId, person?.email ?? undefined),
    queryFn: () => listMailThreads(api, clientId, person!.email!),
    staleTime: 30_000,
  });

  const logNote = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.post(`/api/clients/${clientId}/activity`, { ...values, personId: person?.id }),
    onSuccess: () => {
      setNoteOpen(false);
      toast.success('Note logged');
      void qc.invalidateQueries({ queryKey: ['client-activity', clientId] });
    },
  });

  // A person cannot manage themselves, so they are not offered as an option.
  const managerOptions = useMemo(
    () => people.filter((entry) => entry.id !== person?.id),
    [people, person],
  );

  // Everyone on this client's org tree the Mail compose window may need an id
  // for — the whole roster, minus anyone with no email on file to send to.
  //
  // The addressee this drawer was opened for is deliberately INCLUDED. The
  // compose window derives `personIds` by matching each selected "To" address
  // against this list, so excluding the primary addressee meant an ordinary
  // single-recipient send persisted `metadata: { personIds: [] }` — dropping
  // the person association the old single-`personId` payload carried.
  //
  // This does not put them in the picker: `addableContacts` already drops
  // every contact whose email is in `selectedTo`, and `selectedTo` starts as
  // exactly the `to` prop passed below.
  const orgContacts = useMemo(
    () =>
      people
        .filter((entry) => entry.email)
        .map((entry) => ({ id: entry.id, name: entry.name, email: entry.email! })),
    [people],
  );

  const placementChanged =
    (person?.hierarchyLevel ?? '') !== level || (person?.reportsToPersonId ?? '') !== manager;

  const close = () => {
    // §6: Escape closes unless dirty; a dirty close prompts.
    if (dirty || placementChanged) setConfirmClose(true);
    else onClose();
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: form.name.trim(),
        title: form.title.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        role: form.role.trim() || null,
        notes: form.notes.trim() || null,
      });
      // Placement is a separate call so saving a phone number never converts an
      // automatic placement into a manual one.
      if (placementChanged && onPlace) {
        await onPlace({
          hierarchyLevel: level === '' ? null : level,
          reportsToPersonId: manager === '' ? null : manager,
        });
      }
      setDirty(false);
      onClose();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <CapiroDrawer
        open
        title={person ? person.name : 'Add contact'}
        onClose={close}
        width={640}
      >
        <div className="capiro-crm-form">
          <Field label="Name" required>
            <input
              className="capiro-crm-form__input"
              value={form.name}
              onChange={(event) => set('name', event.target.value)}
            />
          </Field>
          {person ? <p className="capiro-crm__foot">Saved titles may describe a current or historical role. Verify changes against a dated source; keep former roles and the source in Notes. Hierarchy placement does not verify employment.</p> : null}
          <Field label="Title">
            <input
              className="capiro-crm-form__input"
              value={form.title}
              onChange={(event) => set('title', event.target.value)}
              placeholder="e.g. VP Government Affairs"
            />
          </Field>
          <div className="capiro-crm-form__row">
            <Field label="Email">
              <input
                type="email"
                className="capiro-crm-form__input"
                value={form.email}
                onChange={(event) => set('email', event.target.value)}
              />
            </Field>
            <Field label="Phone">
              <input
                className="capiro-crm-form__input"
                value={form.phone}
                onChange={(event) => set('phone', event.target.value)}
              />
            </Field>
          </div>
          <Field label="Role">
            <input
              className="capiro-crm-form__input"
              value={form.role}
              onChange={(event) => set('role', event.target.value)}
            />
          </Field>

          {person ? (
            <>
              <div className="capiro-crm-person__quick-actions">
                <CapiroButton
                  variant="secondary"
                  size="compact"
                  disabled={!person.email}
                  onClick={() => setMailOpen(true)}
                >
                  Mail
                </CapiroButton>
                <CapiroButton variant="secondary" size="compact" onClick={() => setNoteOpen(true)}>
                  Note
                </CapiroButton>
              </div>
              {!person.email ? (
                <p className="capiro-crm__foot capiro-crm-person__no-email-note">
                  Add an email above to send mail to this person.
                </p>
              ) : null}

              <div className="capiro-crm-person__history">
                <p className="capiro-crm__meta capiro-crm__setting-head">Message history</p>
                {!person.email ? (
                  <p className="capiro-crm__foot">No email on file for this person yet.</p>
                ) : history.isLoading ? (
                  <p className="capiro-crm__foot">Loading…</p>
                ) : history.isError ? (
                  <p className="capiro-crm__foot capiro-crm__state--error">Could not load message history.</p>
                ) : !history.data?.length ? (
                  <p className="capiro-crm__foot">No emails on file with this person yet.</p>
                ) : (
                  <ul className="capiro-crm-person__history-list">
                    {history.data.map((thread) => (
                      <li key={thread.id} className="capiro-crm-person__history-row">
                        <span className="capiro-crm-person__history-subject">{thread.subject}</span>
                        {thread.snippet ? (
                          <span className="capiro-crm-person__history-snippet">{thread.snippet}</span>
                        ) : null}
                        {thread.lastMessageAt ? (
                          <span className="capiro-crm-person__history-date">
                            {new Date(thread.lastMessageAt).toLocaleDateString()}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <p className="capiro-crm__meta capiro-crm__setting-head">Hierarchy placement</p>
              <p className="capiro-crm__foot">{placementLabel(person)}</p>

              <div className="capiro-crm-form__row">
                <Field label="Level">
                  <select
                    className="capiro-crm-form__input"
                    value={level}
                    onChange={(event) => {
                      setLevel(event.target.value as HierarchyLevel | '');
                      setDirty(true);
                    }}
                  >
                    <option value="">Not placed</option>
                    {HIERARCHY_LEVELS.map((entry) => (
                      <option key={entry} value={entry}>
                        {LEVEL_META[entry].label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Reports to">
                  <select
                    className="capiro-crm-form__input"
                    value={manager}
                    onChange={(event) => {
                      setManager(event.target.value);
                      setDirty(true);
                    }}
                  >
                    <option value="">No manager</option>
                    {managerOptions.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                        {entry.title ? ` — ${entry.title}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              {person.placementSource === 'manual' && onPlace ? (
                <>
                  {/* Caught here, not voided: a failed reset (e.g. a 503 from the
                      hierarchy endpoint) used to escape as an uncaught page error
                      and silently leave the manual placement in place. Now it
                      reports under the button and offers the same write again. */}
                  <CapiroButton
                    variant="quiet"
                    size="compact"
                    loading={placing}
                    onClick={() => {
                      setPlacing(true);
                      setPlacementError(null);
                      void onPlace({ resetToAutomatic: true })
                        .then(() => onClose())
                        .catch((caught) => setPlacementError(messageOf(caught)))
                        .finally(() => setPlacing(false));
                    }}
                  >
                    Return to automatic placement
                  </CapiroButton>
                  {placementError ? (
                    <p className="capiro-crm__foot capiro-crm__state--error" role="alert">{placementError}</p>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}

          <Field label="Notes">
            <textarea
              className="capiro-crm-form__input"
              rows={4}
              value={form.notes}
              onChange={(event) => set('notes', event.target.value)}
            />
          </Field>

          {error ? <p className="capiro-crm__foot capiro-crm__state--error">{error}</p> : null}

          <div className="capiro-crm__form-actions">
            <CapiroButton
              variant="primary"
              size="compact"
              loading={saving}
              disabled={!form.name.trim()}
              onClick={() => void submit()}
            >
              Save
            </CapiroButton>
            <CapiroButton variant="secondary" size="compact" onClick={close}>
              Cancel
            </CapiroButton>
            {person && onDelete ? (
              <>
                <span className="capiro-crm__page-head-spacer" />
                <CapiroButton variant="quiet" size="compact" onClick={() => setConfirmDelete(true)}>
                  Remove
                </CapiroButton>
              </>
            ) : null}
          </div>
        </div>
      </CapiroDrawer>

      <CapiroModal
        open={confirmClose}
        title="Discard changes?"
        onClose={() => setConfirmClose(false)}
      >
        <p className="capiro-crm__foot">You have unsaved changes to this contact.</p>
        <div className="capiro-crm__form-actions">
          <CapiroButton variant="primary" size="compact" onClick={onClose}>
            Discard
          </CapiroButton>
          <CapiroButton variant="secondary" size="compact" onClick={() => setConfirmClose(false)}>
            Keep editing
          </CapiroButton>
        </div>
      </CapiroModal>

      <CapiroModal
        open={confirmDelete}
        title="Remove contact"
        onClose={() => setConfirmDelete(false)}
      >
        <p className="capiro-crm__foot">
          Remove <strong>{person?.name}</strong>? Anyone reporting to them becomes unattached.
        </p>
        {/* The Remove action's promise used to be voided — a failed DELETE
            surfaced as an uncaught page error with no visible feedback and the
            record silently still there. Kept inside the modal instead: the
            error renders under the prompt and Remove stays available to retry. */}
        {deleteError ? (
          <p className="capiro-crm__foot capiro-crm__state--error" role="alert">{deleteError}</p>
        ) : null}
        <div className="capiro-crm__form-actions">
          <CapiroButton
            variant="primary"
            size="compact"
            loading={deleting}
            onClick={() => {
              if (!onDelete) return;
              setDeleting(true);
              setDeleteError(null);
              void onDelete()
                .then(() => {
                  // Only dismiss once the delete actually succeeded.
                  setConfirmDelete(false);
                })
                .catch((caught) => setDeleteError(messageOf(caught)))
                .finally(() => setDeleting(false));
            }}
          >
            Remove
          </CapiroButton>
          <CapiroButton variant="secondary" size="compact" onClick={() => setConfirmDelete(false)}>
            Cancel
          </CapiroButton>
        </div>
      </CapiroModal>

      {person?.email ? (
        <EmailComposeModal
          open={mailOpen}
          onClose={() => setMailOpen(false)}
          to={[{ email: person.email, name: person.name }]}
          recipientTitle={person.title ?? undefined}
          clientId={clientId}
          orgContacts={orgContacts}
          onSent={() => void history.refetch()}
        />
      ) : null}

      {noteOpen ? (
        <LogActivityModal
          initialKind="note"
          pending={logNote.isPending}
          error={logNote.error}
          onClose={() => setNoteOpen(false)}
          onSubmit={(values) => logNote.mutate(values)}
        />
      ) : null}
    </>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="capiro-crm-form__field">
      <span className="capiro-crm__meta">
        {label}
        {required ? ' *' : ''}
      </span>
      {children}
    </label>
  );
}

function messageOf(error: unknown): string {
  const data = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data;
  if (typeof data?.message === 'string') return data.message;
  if (Array.isArray(data?.message)) return data.message.join(', ');
  return error instanceof Error ? error.message : 'Save failed';
}

