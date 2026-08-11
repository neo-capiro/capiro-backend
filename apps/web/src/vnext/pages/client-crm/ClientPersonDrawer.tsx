import { useMemo, useState } from 'react';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroDrawer, CapiroModal } from '../../components/overlays/index.js';
import {
  HIERARCHY_LEVELS,
  LEVEL_META,
  placementLabel,
  type ClientPerson,
  type HierarchyLevel,
} from '../../adapters/legacy/useClientOrganizationModel.js';

/**
 * Person profile drawer — Figma `907:2919`.
 *
 * Contract §7 is explicit about what this is NOT: "Person drawer must NOT
 * become a mini CRM activity profile… Do not re-add redundant fields such as
 * activity history, last meeting, relationship owner, relationship strength,
 * related activities." So this carries contact details, hierarchy placement,
 * notes and identity — and deliberately nothing else. Relationship history
 * lives on its own tab.
 */
export function ClientPersonDrawer({
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

  const set = (key: keyof typeof form, value: string) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
  };

  // A person cannot manage themselves, so they are not offered as an option.
  const managerOptions = useMemo(
    () => people.filter((entry) => entry.id !== person?.id),
    [people, person],
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
      >
        <div className="capiro-crm-form">
          <Field label="Name" required>
            <input
              className="capiro-crm-form__input"
              value={form.name}
              onChange={(event) => set('name', event.target.value)}
            />
          </Field>
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
                <CapiroButton
                  variant="quiet"
                  size="compact"
                  onClick={() => void onPlace({ resetToAutomatic: true }).then(onClose)}
                >
                  Return to automatic placement
                </CapiroButton>
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

          <div className="capiro-crm-fill__actions">
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
        <div className="capiro-crm-fill__actions">
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
        <div className="capiro-crm-fill__actions">
          <CapiroButton variant="primary" size="compact" onClick={() => void onDelete?.()}>
            Remove
          </CapiroButton>
          <CapiroButton variant="secondary" size="compact" onClick={() => setConfirmDelete(false)}>
            Cancel
          </CapiroButton>
        </div>
      </CapiroModal>
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
