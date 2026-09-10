import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroSelect, CapiroTextarea } from '../../../components/fields/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { FOLDER_BASE, folderError, folderKey, type FolderContext } from './folder-api.js';
import './folder-tracker.css';

export const importanceOptions = ['normal', 'low', 'medium', 'high'].map((value) => ({
  value,
  label: value[0]!.toUpperCase() + value.slice(1),
}));
export const positionOptions = ['none', 'support', 'oppose', 'monitor', 'neutral'].map((value) => ({
  value,
  label: value[0]!.toUpperCase() + value.slice(1),
}));
export function FolderContextEditor({
  initial,
  onSave,
  onClose,
  onReload,
  label,
}: {
  initial: FolderContext;
  onSave: (data: Omit<FolderContext, 'version'> & { expectedVersion: number }) => Promise<void>;
  onClose: () => void;
  onReload: () => Promise<FolderContext>;
  label?: string;
}) {
  const [draft, setDraft] = useState(initial),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [discard, setDiscard] = useState(false);
  const [baseline, setBaseline] = useState(initial),
    [reload, setReload] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const change = (key: keyof FolderContext, value: string | boolean) =>
    setDraft({ ...draft, [key]: value });
  const close = () => (dirty ? setDiscard(true) : onClose());
  return (
    <CapiroModal open title="Edit folder context" onClose={close}>
      <form
        className="lw-folder-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const {
              version,
              topPriority,
              importance,
              position,
              internalComments,
              externalComments,
            } = draft;
            await onSave({
              topPriority,
              importance,
              position,
              internalComments,
              externalComments,
              expectedVersion: version,
            });
            onClose();
          } catch (err) {
            setError(folderError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          {label}. These values belong to this folder. Public legislative status is shown
          separately.
        </p>
        <label>
          <input
            type="checkbox"
            checked={draft.topPriority}
            onChange={(e) => change('topPriority', e.target.checked)}
          />{' '}
          Top priority
        </label>
        <CapiroSelect
          label="Importance"
          value={draft.importance}
          options={importanceOptions}
          onChange={(e) => change('importance', e.target.value)}
        />
        <CapiroSelect
          label="Position"
          value={draft.position}
          options={positionOptions}
          onChange={(e) => change('position', e.target.value)}
        />
        <CapiroTextarea
          label="Folder internal comments"
          value={draft.internalComments}
          maxLength={10000}
          rows={4}
          onChange={(e) => change('internalComments', e.target.value)}
          help="Included in exports only when explicitly selected."
        />
        <CapiroTextarea
          label="Folder external comments"
          value={draft.externalComments}
          maxLength={10000}
          rows={4}
          onChange={(e) => change('externalComments', e.target.value)}
          help="Saving a comment does not send or publish it."
        />
        {error && <p role="alert">{error}</p>}
        {error && (
          <CapiroButton onClick={() => setReload(true)}>Reload current context</CapiroButton>
        )}
        {reload && (
          <div role="alert">
            <p>Discard this draft and load the latest saved context?</p>
            <CapiroButton onClick={() => setReload(false)}>Keep draft</CapiroButton>
            <CapiroButton
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const current = await onReload();
                  setDraft(current);
                  setBaseline(current);
                  setReload(false);
                  setError('');
                } catch (err) {
                  setError(folderError(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Discard draft and reload
            </CapiroButton>
          </div>
        )}
        {discard ? (
          <div role="alert">
            <p>Discard your unsaved changes?</p>
            <CapiroButton onClick={() => setDiscard(false)}>Keep editing</CapiroButton>
            <CapiroButton onClick={onClose}>Discard changes</CapiroButton>
          </div>
        ) : (
          <div className="lw-folder-actions">
            <CapiroButton onClick={close}>Cancel</CapiroButton>
            <CapiroButton type="submit" variant="primary" loading={busy}>
              Save context
            </CapiroButton>
          </div>
        )}
      </form>
    </CapiroModal>
  );
}

export function FolderContextPanel({ folderId, billId }: { folderId: string; billId: string }) {
  const api = useApi(),
    identity = useApiScope(),
    qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const key = [...folderKey(identity), 'context', folderId, billId];
  const data = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await api.get<{
          folder: { id: string; name: string; clientId: string | null };
          assignment: FolderContext | null;
          canEdit: boolean;
        }>(
          `${FOLDER_BASE}/${encodeURIComponent(folderId)}/bills/${encodeURIComponent(billId)}/context`,
        )
      ).data,
    retry: false,
  });
  if (data.isPending) return <p role="status">Loading folder context…</p>;
  if (data.isError) return <p role="alert">This folder is unavailable in the current workspace.</p>;
  const d = data.data;
  return (
    <section className="lw-folder-context" aria-label="In this folder">
      <h3>In this folder · {d.folder.name}</h3>
      {d.assignment ? (
        <>
          <p>
            {d.assignment.topPriority ? 'Top priority · ' : ''}
            {d.assignment.importance} importance · {d.assignment.position} position
          </p>
          <dl>
            <dt className="lw-folder-internal">Folder internal comments</dt>
            <dd className="lw-folder-internal">
              {d.assignment.internalComments || 'No internal comments'}
            </dd>
            <dt>Folder external comments</dt>
            <dd>{d.assignment.externalComments || 'No external comments'}</dd>
          </dl>
          {d.canEdit && (
            <CapiroButton size="compact" onClick={() => setEditing(true)}>
              Edit folder context
            </CapiroButton>
          )}
        </>
      ) : (
        <p>This bill is not assigned to the selected folder.</p>
      )}
      {editing && d.assignment && (
        <FolderContextEditor
          initial={d.assignment}
          label={`${billId} · ${d.folder.name}`}
          onReload={async () => {
            const result = await data.refetch();
            if (!result.data?.assignment) throw new Error('Assignment unavailable');
            return result.data.assignment;
          }}
          onClose={() => setEditing(false)}
          onSave={async (values) => {
            await api.put(
              `${FOLDER_BASE}/${encodeURIComponent(folderId)}/bills/${encodeURIComponent(billId)}/context`,
              values,
            );
            await qc.invalidateQueries({ queryKey: folderKey(identity) });
          }}
        />
      )}
    </section>
  );
}
