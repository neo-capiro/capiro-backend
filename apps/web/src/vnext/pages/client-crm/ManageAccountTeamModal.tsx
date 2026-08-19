import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { initialsFor } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import {
  addClientTeamMember,
  clientTeamKey,
  getClientTeam,
  removeClientTeamMember,
  teamMemberLabel,
  type ClientTeamMember,
} from './client-team-api.js';
import {
  clientAccountOwnerLabel,
  type ClientAccountOwner,
} from './useClientAccountOwner.js';
import './manage-account-team-modal.css';

/**
 * "Manage team" — put the firm's own people on a client's account team.
 *
 * Until now there was nothing to manage: Capiro stored a single
 * `clients.account_owner_user_id` and no roster table, so the Overview Account
 * card rendered "ACCOUNT TEAM / No roster" and pointed at firm-wide team
 * settings, which is a different thing entirely. `client_team_members` is the
 * roster; this is its editor.
 *
 * The candidate list is the SAME `/api/client-account-owners/options` endpoint
 * the account-owner picker already uses — the active members of this tenant.
 * Anyone already on the roster is filtered out of it, so the picker cannot offer
 * a duplicate.
 *
 * The account owner appears on the roster (`isOwner`) but has no Remove control:
 * they are a `clients` column, not a membership row, and dropping them is the
 * separate, deliberate act of reassigning ownership.
 */

export function ManageAccountTeamModal({
  open,
  clientId,
  clientName,
  onClose,
}: {
  open: boolean;
  clientId: string;
  clientName: string;
  onClose: () => void;
}) {
  return (
    <CapiroModal open={open} title={`Account team — ${clientName}`} onClose={onClose}>
      <ManageAccountTeamBody clientId={clientId} onClose={onClose} />
    </CapiroModal>
  );
}

function ManageAccountTeamBody({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const [pickedUserId, setPickedUserId] = useState('');
  const [role, setRole] = useState('');

  const teamQ = useQuery({
    // The same key the Overview model reads, so an edit here refreshes the card.
    queryKey: clientTeamKey(clientId),
    queryFn: () => getClientTeam(api, clientId),
  });

  const optionsQ = useQuery({
    queryKey: ['client-account-owner-options'],
    queryFn: async () =>
      (await api.get<ClientAccountOwner[]>('/api/client-account-owners/options')).data,
    staleTime: 5 * 60 * 1000,
  });

  const team = teamQ.data ?? [];
  const onTeam = useMemo(() => new Set(team.map((member) => member.userId)), [team]);
  const candidates = useMemo(
    () => (optionsQ.data ?? []).filter((option) => !onTeam.has(option.id)),
    [optionsQ.data, onTeam],
  );

  /** Both mutations return the refreshed roster, so seed the cache from it. */
  const applyRoster = (roster: ClientTeamMember[]) => {
    qc.setQueryData(clientTeamKey(clientId), roster);
    void qc.invalidateQueries({ queryKey: clientTeamKey(clientId) });
  };

  const add = useMutation({
    mutationFn: () => addClientTeamMember(api, clientId, pickedUserId, role.trim() || null),
    onSuccess: (roster) => {
      toast.success('Added to the account team');
      setPickedUserId('');
      setRole('');
      applyRoster(roster);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => removeClientTeamMember(api, clientId, userId),
    onSuccess: (roster) => {
      toast.success('Removed from the account team');
      applyRoster(roster);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="capiro-team">
      <p className="capiro-team__hint">
        Who at the firm works this account. The account owner is always on the team — change that from
        the header’s Account owner picker.
      </p>

      {teamQ.isLoading ? (
        <p className="capiro-team__empty">Loading the team…</p>
      ) : teamQ.isError ? (
        <div className="capiro-team__error">
          <span>Could not read the account team.</span>
          <CapiroButton variant="secondary" size="compact" onClick={() => void teamQ.refetch()}>
            Retry
          </CapiroButton>
        </div>
      ) : (
        <ul className="capiro-team__list">
          {team.length === 0 ? (
            <li className="capiro-team__empty">
              Nobody is on this account team yet, and no account owner is assigned.
            </li>
          ) : (
            team.map((member) => {
              const label = teamMemberLabel(member);
              return (
                <li key={member.userId} className="capiro-team__row">
                  <span className="capiro-team__avatar" aria-hidden>
                    {initialsFor(label)}
                  </span>
                  <span className="capiro-team__who">
                    <span className="capiro-team__name">{label}</span>
                    <span className="capiro-team__meta">
                      {[member.isOwner ? 'Account owner' : null, member.role, member.email]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {member.isOwner ? (
                    // No Remove: the owner is a `clients` column, and clearing it
                    // is the separate account-owner reassignment.
                    <span className="capiro-team__owner-tag">Owner</span>
                  ) : (
                    <button
                      type="button"
                      className="capiro-team__remove"
                      disabled={remove.isPending && remove.variables === member.userId}
                      onClick={() => remove.mutate(member.userId)}
                    >
                      {remove.isPending && remove.variables === member.userId ? 'Removing…' : 'Remove'}
                    </button>
                  )}
                </li>
              );
            })
          )}
        </ul>
      )}

      <form
        className="capiro-team__add"
        onSubmit={(event) => {
          event.preventDefault();
          if (pickedUserId) add.mutate();
        }}
      >
        <div className="capiro-team__add-grid">
          <CapiroSelect
            label="Add a teammate"
            value={pickedUserId}
            disabled={optionsQ.isLoading || candidates.length === 0}
            options={[
              {
                value: '',
                label: optionsQ.isLoading
                  ? 'Loading firm members…'
                  : candidates.length === 0
                    ? 'Everyone at the firm is already on this team'
                    : 'Pick someone',
              },
              ...candidates.map((option) => ({
                value: option.id,
                label: clientAccountOwnerLabel(option) ?? option.email,
              })),
            ]}
            onChange={(event) => setPickedUserId(event.target.value)}
          />
          <CapiroInput
            label="Role (optional)"
            placeholder="e.g. Lead lobbyist"
            maxLength={120}
            value={role}
            onChange={(event) => setRole(event.target.value)}
          />
        </div>
        {optionsQ.isError ? (
          <p className="capiro-team__error-line">
            Could not load the firm’s members, so there is nobody to pick from.
          </p>
        ) : null}
        <div className="capiro-team__form-actions">
          <CapiroButton
            variant="primary"
            size="compact"
            type="submit"
            disabled={!pickedUserId}
            loading={add.isPending}
          >
            Add to team
          </CapiroButton>
        </div>
      </form>

      <div className="capiro-team__footer">
        <span className="capiro-team__spacer" />
        <CapiroButton variant="secondary" size="compact" onClick={onClose}>
          Done
        </CapiroButton>
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { status?: number; data?: { message?: unknown } } }).response;
    const data = response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
    // The mutations are user_admin-gated, same as account-owner assignment.
    if (response?.status === 403) return 'You need admin rights to change the account team.';
  }
  return error instanceof Error ? error.message : 'Could not update the account team';
}
