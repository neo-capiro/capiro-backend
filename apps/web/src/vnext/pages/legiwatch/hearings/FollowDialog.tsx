/**
 * LegiWatch V2 Wave 1 (W1-1) — the Follow dialog.
 *
 * Follow and Attend are DIFFERENT products and this dialog says so explicitly.
 * Following a hearing tracks it for selected clients and turns on the
 * notifications the user picks; it never asks Capiro to attend, and the server
 * never creates capture demand from it.
 *
 * Reuses LwModal, which already provides Escape-to-close, a focus trap and a
 * dirty-state guard, so keyboard behavior matches every other module dialog.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import { LwModal } from '../overlays/LwModal.js';
import {
  useFollowConfig,
  useSaveFollow,
  useUnfollow,
  w1Error,
  type FollowConfig,
} from '../lib/wave1-api.js';

/** The user-selectable notification categories, in the order they read best. */
const NOTIFICATION_OPTIONS = [
  {
    key: 'notifyOnScheduleChange' as const,
    label: 'Schedule changes',
    hint: 'The date, time, location or witness list changes.',
  },
  {
    key: 'notifyOnHearingStarting' as const,
    label: 'Hearing starting',
    hint: 'The proceeding begins.',
  },
  {
    key: 'notifyOnTranscriptReady' as const,
    label: 'Transcript ready',
    hint: 'The canonical transcript becomes available.',
  },
  {
    key: 'notifyOnHighPriorityMatch' as const,
    label: 'High-priority client match',
    hint: 'A HIGH-relevance finding is detected for a selected client.',
  },
];

export function FollowDialog({
  hearingId,
  hearingTitle,
  onClose,
}: {
  hearingId: string;
  hearingTitle: string;
  onClose: () => void;
}) {
  const api = useApi();
  const existing = useFollowConfig(hearingId);
  const save = useSaveFollow(hearingId);
  const unfollow = useUnfollow(hearingId);

  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const [selected, setSelected] = useState<string[]>([]);
  const [prefs, setPrefs] = useState({
    notifyOnScheduleChange: true,
    notifyOnHearingStarting: true,
    notifyOnTranscriptReady: true,
    notifyOnHighPriorityMatch: true,
  });
  const [hydrated, setHydrated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rehydrate from the PERSISTED configuration, once. Editing a follow must
  // show what is actually saved, not the defaults.
  useEffect(() => {
    const data: FollowConfig | undefined = existing.data;
    if (!data || hydrated) return;
    setSelected(data.clientIds);
    setPrefs({
      notifyOnScheduleChange: data.notifyOnScheduleChange,
      notifyOnHearingStarting: data.notifyOnHearingStarting,
      notifyOnTranscriptReady: data.notifyOnTranscriptReady,
      notifyOnHighPriorityMatch: data.notifyOnHighPriorityMatch,
    });
    setHydrated(true);
  }, [existing.data, hydrated]);

  const following = existing.data?.following ?? false;

  // Client ids the follow references but this tenant can no longer resolve (or
  // that are archived). Kept visible rather than dropped, so the user can see
  // exactly what the follow covers.
  const unresolvable = useMemo(
    () => (existing.data?.clients ?? []).filter((c) => c.archived),
    [existing.data],
  );

  const activeClients = useMemo(
    () => (clients.data ?? []).filter((c) => c.status !== 'archived'),
    [clients.data],
  );

  const toggleClient = (id: string) => {
    setDirty(true);
    setSelected((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  };

  const onSave = () => {
    setError(null);
    save.mutate(
      { clientIds: selected, ...prefs },
      {
        onSuccess: () => onClose(),
        // Never report success when the backend failed.
        onError: (err) => setError(w1Error(err)),
      },
    );
  };

  const onUnfollow = () => {
    setError(null);
    unfollow.mutate(undefined, {
      onSuccess: () => onClose(),
      onError: (err) => setError(w1Error(err)),
    });
  };

  const busy = save.isPending || unfollow.isPending;

  return (
    <LwModal
      kind="watch"
      eyebrow="Follow"
      title={following ? 'Edit follow' : 'Follow this hearing'}
      subtitle={hearingTitle}
      note="Following notifies you. It does not ask Capiro to attend."
      primaryLabel={busy ? 'Saving…' : following ? 'Save changes' : 'Follow'}
      onPrimary={onSave}
      primaryDisabled={busy || selected.length === 0}
      primaryTitle={
        selected.length === 0 ? 'Select at least one client to follow this hearing for.' : undefined
      }
      onClose={onClose}
      dirty={dirty && !busy}
      width={560}
    >
      {existing.isLoading ? (
        <p className="lw-card__meta">Loading your follow settings…</p>
      ) : existing.isError ? (
        <p role="alert" className="lw-card__meta">
          Your follow settings could not be loaded. {w1Error(existing.error)}
        </p>
      ) : (
        <>
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="lw-eyebrow" style={{ marginBottom: 8 }}>
              Clients
            </legend>
            <p className="lw-card__meta" style={{ marginTop: 0 }}>
              Choose which clients this hearing is being tracked for.
            </p>
            {clients.isLoading ? (
              <p className="lw-card__meta">Loading clients…</p>
            ) : clients.isError ? (
              <p role="alert" className="lw-card__meta">
                Your client list could not be loaded, so clients cannot be selected right now.
              </p>
            ) : activeClients.length === 0 ? (
              <p className="lw-card__meta">
                There are no active clients in this workspace to follow this hearing for.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
                {activeClients.map((client) => (
                  <li key={client.id}>
                    <label
                      style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0' }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(client.id)}
                        onChange={() => toggleClient(client.id)}
                      />
                      <span>{client.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}

            {unresolvable.length > 0 ? (
              // Explicit rather than silent: the follow still covers these ids.
              <p className="lw-card__meta" style={{ marginTop: 8 }}>
                This follow also references {unresolvable.length} archived or unavailable{' '}
                {unresolvable.length === 1 ? 'client' : 'clients'}. Saving will drop{' '}
                {unresolvable.length === 1 ? 'it' : 'them'}.
              </p>
            ) : null}
          </fieldset>

          <fieldset style={{ border: 0, margin: '18px 0 0', padding: 0 }}>
            <legend className="lw-eyebrow" style={{ marginBottom: 8 }}>
              Notify me about
            </legend>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {NOTIFICATION_OPTIONS.map((opt) => (
                <li key={opt.key}>
                  <label
                    style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0' }}
                  >
                    <input
                      type="checkbox"
                      checked={prefs[opt.key]}
                      onChange={() => {
                        setDirty(true);
                        setPrefs((prev) => ({ ...prev, [opt.key]: !prev[opt.key] }));
                      }}
                    />
                    <span>
                      <span style={{ display: 'block' }}>{opt.label}</span>
                      <span className="lw-card__meta" style={{ fontSize: 12 }}>
                        {opt.hint}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          {following ? (
            <div style={{ marginTop: 18 }}>
              <button
                type="button"
                className="lw-btn"
                onClick={onUnfollow}
                disabled={busy}
              >
                {unfollow.isPending ? 'Removing…' : 'Unfollow'}
              </button>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="lw-card__meta" style={{ marginTop: 12, color: 'var(--lw-danger, #b42318)' }}>
              {error}
            </p>
          ) : null}
        </>
      )}
    </LwModal>
  );
}
