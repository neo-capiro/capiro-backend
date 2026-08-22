import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ListPlus, Loader2, Save } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import type { OutreachV3ResolvedTargetRef, OutreachV3TargetLocator } from '../../../pages/engagement/outreach/v3/contracts.js';
import { savedAudienceMemberLocator } from '../../../pages/engagement/outreach/v3/TargetWorkspace.js';
import {
  createSavedOutreachAudience,
  listSavedOutreachAudiences,
  type CreateSavedOutreachAudienceMemberInput,
  type SavedAudience,
} from './engagement-api.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailable(target: OutreachV3ResolvedTargetRef): boolean {
  return Boolean(target.email && EMAIL_RE.test(target.email));
}

/**
 * Mirrors Outreach 2.0's `toAudienceMemberInput` (StepRecipientsSelect /
 * audiences.ts), adapted for the V3 resolved-target shape. `source` only
 * matters as a hint for how `savedAudienceMemberLocator` re-resolves the
 * member later — it does not need to equal the original locator's `source`
 * verbatim, the same way the V2 path already collapses several V2 recipient
 * origins into 'congress' | 'client_contact' | 'manual'.
 */
function targetToAudienceMemberInput(
  target: OutreachV3ResolvedTargetRef,
): CreateSavedOutreachAudienceMemberInput {
  const source: CreateSavedOutreachAudienceMemberInput['source'] =
    target.locator.source === 'directory_member' || target.locator.source === 'directory_staff'
      ? 'congress'
      : target.clientId
        ? 'client_contact'
        : 'manual';
  return {
    source,
    sourceRefId: typeof target.locator.id === 'string' ? target.locator.id : undefined,
    name: target.displayName || undefined,
    email: target.email ?? '',
    title: target.title ?? undefined,
    office: target.organization ?? undefined,
  };
}

export function SavedTargetListsPanel({
  selected,
  busy,
  onAddLocators,
}: {
  selected: OutreachV3ResolvedTargetRef[];
  busy: boolean;
  onAddLocators: (locators: OutreachV3TargetLocator[]) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [browseOpen, setBrowseOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');

  const lists = useQuery({
    queryKey: ['outreach-v3', 'saved-target-lists'],
    queryFn: () => listSavedOutreachAudiences(api),
    enabled: browseOpen,
  });

  const emailableSelected = selected.filter(emailable);

  const save = useMutation({
    mutationFn: () =>
      createSavedOutreachAudience(api, {
        kind: 'list',
        name: name.trim(),
        members: emailableSelected.map(targetToAudienceMemberInput),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['outreach-v3', 'saved-target-lists'] });
      setSaveOpen(false);
      setName('');
    },
  });

  const addAll = (audience: SavedAudience) => {
    if (!audience.members.length) return;
    onAddLocators(audience.members.map(savedAudienceMemberLocator));
    setBrowseOpen(false);
  };

  return (
    <div className="outreach-guided__saved-lists">
      <div className="outreach-guided__saved-lists-bar">
        <span>Reusable lists</span>
        <button
          type="button"
          disabled={busy}
          data-active={browseOpen || undefined}
          onClick={() => {
            setBrowseOpen((current) => !current);
            setSaveOpen(false);
          }}
        >
          <ListPlus size={14} />
          Load a saved list
          <ChevronDown size={13} />
        </button>
        <button
          type="button"
          disabled={busy || !selected.length}
          data-active={saveOpen || undefined}
          onClick={() => {
            setSaveOpen((current) => !current);
            setBrowseOpen(false);
          }}
        >
          <Save size={14} />
          Save current selection as a list
        </button>
      </div>

      {browseOpen ? (
        <div className="outreach-guided__saved-lists-panel">
          {lists.isLoading ? (
            <span className="outreach-guided__saved-lists-status">
              <Loader2 size={14} className="outreach-guided__spin" /> Loading saved lists…
            </span>
          ) : lists.isError ? (
            <p className="outreach-guided__saved-lists-status">Saved lists could not load.</p>
          ) : !lists.data?.filter((audience) => audience.kind === 'list').length ? (
            <p className="outreach-guided__saved-lists-status">
              No saved lists yet. Select targets and save them as a reusable list.
            </p>
          ) : (
            lists.data
              .filter((audience) => audience.kind === 'list')
              .map((audience) => (
                <div key={audience.id} className="outreach-guided__saved-list-row">
                  <span>
                    <strong>{audience.name}</strong>
                    <small>
                      {audience.members.length} {audience.members.length === 1 ? 'contact' : 'contacts'}
                    </small>
                  </span>
                  <button
                    type="button"
                    disabled={busy || !audience.members.length}
                    onClick={() => addAll(audience)}
                  >
                    Add all
                  </button>
                </div>
              ))
          )}
        </div>
      ) : null}

      {saveOpen ? (
        <div className="outreach-guided__saved-lists-panel">
          <label className="outreach-guided__saved-lists-name">
            <span>List name</span>
            <input
              autoFocus
              value={name}
              onChange={(event: { target: { value: string } }) => setName(event.target.value)}
              placeholder="e.g. Defense Appropriations subcommittee"
              maxLength={120}
            />
          </label>
          {emailableSelected.length < selected.length ? (
            <p className="outreach-guided__saved-lists-status">
              {selected.length - emailableSelected.length} selected{' '}
              {selected.length - emailableSelected.length === 1 ? 'target has' : 'targets have'} no usable
              email and will not be saved.
            </p>
          ) : null}
          {save.isError ? (
            <p className="outreach-guided__saved-lists-status" role="alert">
              The list could not be saved.
            </p>
          ) : null}
          <div className="outreach-guided__saved-lists-actions">
            <button type="button" onClick={() => setSaveOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="is-primary"
              disabled={save.isPending || !name.trim() || !emailableSelected.length}
              onClick={() => void save.mutateAsync()}
            >
              {save.isPending ? <Loader2 size={14} className="outreach-guided__spin" /> : <Save size={14} />}
              Save {emailableSelected.length} {emailableSelected.length === 1 ? 'contact' : 'contacts'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
