import { useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { Link } from 'react-router-dom';
import { CapiroButton } from '../../components/actions/index.js';
import { folderError } from '../legiwatch/bills/folder-api.js';
import { useLegiWatchFolders, useSaveArticleToFolder } from './legiwatch-save-api.js';

const stopClick = (event: SyntheticEvent) => event.stopPropagation();
// The news row is itself a button that opens on click, Enter and Space.
const stopRowKeys = (event: KeyboardEvent) => {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
};

export function SaveToLegiWatchFolder({ articleId }: { articleId: string }) {
  const [open, setOpen] = useState(false);
  const [folderId, setFolderId] = useState('');
  const folders = useLegiWatchFolders(open);
  const save = useSaveArticleToFolder();
  const folder = folders.data?.find((f) => f.id === folderId);

  return (
    <span className="xp-news-save" onClick={stopClick} onKeyDown={stopRowKeys}>
      {save.isSuccess ? (
        <span role="status">
          Saved to{' '}
          <Link to={`/legiwatch?tab=bills&folder=${encodeURIComponent(save.data.id)}`}>
            {save.data.name}
          </Link>
        </span>
      ) : !open ? (
        <CapiroButton variant="quiet" size="compact" onClick={() => setOpen(true)}>
          Save to LegiWatch
        </CapiroButton>
      ) : folders.isError ? (
        <>
          <span className="xp-danger" role="alert">
            {folderError(folders.error)}
          </span>
          <CapiroButton variant="quiet" size="compact" onClick={() => void folders.refetch()}>
            Retry
          </CapiroButton>
        </>
      ) : folders.data?.length === 0 ? (
        <span role="status">Create a folder in LegiWatch first.</span>
      ) : (
        <>
          <select
            className="capiro-select"
            aria-label="LegiWatch folder"
            value={folderId}
            disabled={!folders.data || save.isPending}
            onChange={(event) => {
              setFolderId(event.target.value);
              save.reset();
            }}
          >
            <option value="">{folders.data ? 'Choose a folder' : 'Loading folders…'}</option>
            {(folders.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <CapiroButton
            size="compact"
            disabled={!folder}
            loading={save.isPending}
            onClick={() => folder && save.mutate({ articleId, folder })}
          >
            {save.isError ? 'Retry' : 'Save'}
          </CapiroButton>
          {save.isError ? (
            <span className="xp-danger" role="alert">
              {folderError(save.error)}
            </span>
          ) : null}
        </>
      )}
    </span>
  );
}
