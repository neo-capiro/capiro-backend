import { useState } from 'react';
import { Paperclip } from 'lucide-react';
import type { PlannerTask } from '@capiro/strategy-verifier';
import { usePlannerAttachments, plannerError, usePlannerBootstrap } from './planner-api.js';
export function PlannerAttachments({ task }: { task: PlannerTask }) {
  const { query, upload, archive, download } = usePlannerAttachments(task.id);
  const bootstrap = usePlannerBootstrap();
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canComment = ['admin', 'editor', 'commenter'].includes(task.access);
  const canEdit = ['admin', 'editor'].includes(task.access);
  return (
    <section className="planner-attachments">
      <h3>
        <Paperclip size={16} />
        Attachments
      </h3>
      {canComment && !task.archived && (
        <label className="planner-field">
          <span>Attach a file (up to 25 MB)</span>
          <input
            type="file"
            disabled={upload.isPending}
            onChange={async (e) => {
              const file = e.currentTarget.files?.[0];
              const input = e.currentTarget;
              if (!file) return;
              setError(null);
              if (!file.size || file.size > 25 * 1024 * 1024) {
                setError(new Error('Choose a file between 1 byte and 25 MB.'));
                input.value = '';
                return;
              }
              try {
                await upload.mutateAsync(file);
                input.value = '';
              } catch {}
            }}
          />
        </label>
      )}
      {upload.isPending && <p role="status">Uploading attachment…</p>}
      <button type="button" onClick={() => setShowArchived(!showArchived)}>
        {showArchived ? 'Active files' : 'Archived files'}
      </button>
      {Boolean(error || query.error || upload.error || archive.error || download.error) && (
        <p role="alert" className="planner-error">
          {plannerError(error || query.error || upload.error || archive.error || download.error)}
        </p>
      )}
      {query.isPending ? (
        <p role="status">Loading attachments…</p>
      ) : (
        query.data
          ?.filter((file) => file.archived === showArchived)
          .map((file) => (
            <div className="planner-attachment-row" key={file.id}>
              <button
                type="button"
                disabled={file.archived || download.isPending}
                onClick={() => download.mutate(file)}
              >
                {file.fileName}
              </button>
              <small>
                {file.sizeBytes >= 1024 * 1024
                  ? `${(file.sizeBytes / 1024 / 1024).toFixed(1)} MB`
                  : `${Math.ceil(file.sizeBytes / 1024)} KB`}
              </small>
              {(canEdit || (canComment && file.uploadedBy === bootstrap.data?.me.id)) && (
                <button
                  type="button"
                  disabled={archive.isPending}
                  onClick={() => archive.mutate({ id: file.id, archived: !file.archived })}
                >
                  {file.archived ? 'Restore' : 'Archive'}
                </button>
              )}
            </div>
          ))
      )}
      {query.data?.filter((file) => file.archived === showArchived).length === 0 && (
        <p className="planner-muted">No {showArchived ? 'archived ' : ''}attachments.</p>
      )}
    </section>
  );
}
