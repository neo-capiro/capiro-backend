/**
 * LegiWatch V2 Wave 2 (W2-2) — Saved Views.
 *
 * Real persistence, replacing the "no backend" placeholder (GAPS LW-G8).
 * A saved view captures the CURRENT URL (pathname + query string) for one of
 * the six LegiWatch surfaces; applying a view is a real navigation to that
 * URL, so the restored state is address-bar visible, not hidden in React
 * component state.
 *
 * Personal views are mutable only by their owner; a tenant-shared view widens
 * READ (anyone can list/apply it) but never write — rename/duplicate-source/
 * default/delete still require ownership, and "duplicate" is the path for
 * someone who wants their own editable copy of someone else's shared view.
 */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LwModal } from './LwModal.js';
import { LwButton, LwPill } from '../lib/primitives.js';
import {
  captureCurrentViewState,
  currentSurface,
  urlForViewState,
  useApplySavedView,
  useCreateSavedView,
  useDeleteSavedView,
  useDuplicateSavedView,
  useSavedViews,
  useSetDefaultSavedView,
  useUpdateSavedView,
  w2Error,
  SAVED_VIEW_SURFACE_LABEL,
  type SavedView,
  type SavedViewSurface,
} from '../lib/wave2-api.js';

export function SavedViewsOverlay({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [surface, setSurface] = useState<SavedViewSurface>(() =>
    currentSurface(window.location.pathname, searchParams),
  );
  const [scope, setScope] = useState<'all' | 'personal' | 'tenant'>('all');
  const [newName, setNewName] = useState('');
  const [shareNew, setShareNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const views = useSavedViews({ surface, scope });
  const create = useCreateSavedView();
  const update = useUpdateSavedView();
  const duplicate = useDuplicateSavedView();
  const setDefault = useSetDefaultSavedView();
  const apply = useApplySavedView();
  const remove = useDeleteSavedView();

  const busy =
    create.isPending ||
    update.isPending ||
    duplicate.isPending ||
    setDefault.isPending ||
    apply.isPending ||
    remove.isPending;

  const onSaveCurrent = () => {
    if (!newName.trim()) {
      setError('Name the view before saving it.');
      return;
    }
    setError(null);
    const captured = captureCurrentViewState();
    create.mutate(
      {
        surface,
        name: newName.trim(),
        scope: shareNew ? 'tenant' : 'personal',
        config: { filters: captured },
      },
      {
        onSuccess: () => setNewName(''),
        onError: (err) => setError(w2Error(err)),
      },
    );
  };

  const onApply = (view: SavedView) => {
    setError(null);
    apply.mutate(
      { id: view.id },
      {
        onSuccess: (applied) => {
          if (applied.clientWarning) setError(applied.clientWarning);
          const captured = applied.config.filters;
          if (captured) {
            navigate(urlForViewState(captured));
            onClose();
          } else {
            setError('This view has no restorable state.');
          }
        },
        onError: (err) => setError(w2Error(err)),
      },
    );
  };

  return (
    <LwModal
      kind="views"
      eyebrow="LegiWatch view presets"
      title="Saved views"
      subtitle="Reusable combinations of scope, work state, source, sort, and arrangement."
      note="Saved views persist per user. Team-shared views remain read-only until duplicated."
      primaryLabel="Close"
      onPrimary={onClose}
      onClose={onClose}
      width={620}
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <label style={{ flex: 1 }}>
          <span className="lw-eyebrow" style={{ display: 'block', marginBottom: 4 }}>
            Surface
          </span>
          <select
            aria-label="Surface"
            value={surface}
            onChange={(e) => setSurface(e.target.value as SavedViewSurface)}
            style={{ width: '100%' }}
          >
            {Object.entries(SAVED_VIEW_SURFACE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="lw-eyebrow" style={{ display: 'block', marginBottom: 4 }}>
            Show
          </span>
          <select
            aria-label="Show"
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            <option value="all">Personal + shared</option>
            <option value="personal">Personal only</option>
            <option value="tenant">Shared only</option>
          </select>
        </label>
      </div>

      <fieldset style={{ border: 0, margin: '0 0 16px', padding: 0 }}>
        <legend className="lw-eyebrow" style={{ marginBottom: 6 }}>
          Save the current view
        </legend>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            aria-label="New view name"
            placeholder={`Name this ${SAVED_VIEW_SURFACE_LABEL[surface].toLowerCase()} view`}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ flex: 1 }}
          />
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={shareNew} onChange={(e) => setShareNew(e.target.checked)} />
            Share with tenant
          </label>
          <LwButton variant="primary" onClick={onSaveCurrent} disabled={busy}>
            {create.isPending ? 'Saving…' : 'Save current view'}
          </LwButton>
        </div>
      </fieldset>

      {error ? (
        <p role="alert" className="lw-card__meta" style={{ color: 'var(--lw-danger, #b42318)', marginBottom: 10 }}>
          {error}
        </p>
      ) : null}

      {views.isLoading ? (
        <p className="lw-card__meta">Loading saved views…</p>
      ) : views.isError ? (
        <p role="alert" className="lw-card__meta">
          Saved views could not be loaded. {w2Error(views.error)}
        </p>
      ) : views.data && views.data.rows.length === 0 ? (
        <p className="lw-card__meta" style={{ fontSize: 13 }}>
          No saved views yet for {SAVED_VIEW_SURFACE_LABEL[surface].toLowerCase()}.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {views.data?.rows.map((view) => (
            <li
              key={view.id}
              className="lw-card"
              style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {view.isDefault ? (
                  <LwPill tone="brand" size="22">
                    Default
                  </LwPill>
                ) : null}
                <LwPill tone="gray" size="22">
                  {view.scope === 'tenant' ? 'Shared' : 'Personal'}
                </LwPill>
                {renamingId === view.id ? (
                  <input
                    aria-label="Rename view"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    style={{ flex: 1, minWidth: 120 }}
                  />
                ) : (
                  <strong style={{ fontSize: 14 }}>{view.name}</strong>
                )}
                {!view.isOwnedByCaller ? (
                  <span className="lw-card__meta" style={{ fontSize: 11 }}>
                    (owned by someone else)
                  </span>
                ) : null}
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <LwButton onClick={() => onApply(view)} disabled={busy}>
                  Apply
                </LwButton>
                {view.isOwnedByCaller ? (
                  renamingId === view.id ? (
                    <>
                      <LwButton
                        onClick={() => {
                          if (!renameValue.trim()) return;
                          update.mutate(
                            { id: view.id, name: renameValue.trim() },
                            { onSuccess: () => setRenamingId(null), onError: (err) => setError(w2Error(err)) },
                          );
                        }}
                        disabled={busy}
                      >
                        Save name
                      </LwButton>
                      <LwButton onClick={() => setRenamingId(null)} disabled={busy}>
                        Cancel
                      </LwButton>
                    </>
                  ) : (
                    <LwButton
                      onClick={() => {
                        setRenamingId(view.id);
                        setRenameValue(view.name);
                      }}
                      disabled={busy}
                    >
                      Rename
                    </LwButton>
                  )
                ) : null}
                <LwButton
                  onClick={() =>
                    duplicate.mutate(
                      { id: view.id },
                      { onError: (err) => setError(w2Error(err)) },
                    )
                  }
                  disabled={busy}
                >
                  Duplicate
                </LwButton>
                {view.isOwnedByCaller ? (
                  <>
                    <LwButton
                      onClick={() =>
                        setDefault.mutate(
                          { id: view.id, isDefault: !view.isDefault },
                          { onError: (err) => setError(w2Error(err)) },
                        )
                      }
                      disabled={busy}
                    >
                      {view.isDefault ? 'Unset default' : 'Make default'}
                    </LwButton>
                    <LwButton
                      onClick={() =>
                        remove.mutate({ id: view.id }, { onError: (err) => setError(w2Error(err)) })
                      }
                      disabled={busy}
                    >
                      Delete
                    </LwButton>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </LwModal>
  );
}
