import { useId, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import { CapiroButton } from '../components/actions/index.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { CapiroBellIcon } from '../components/icons/index.js';
import { useDialogFocus } from '../components/overlays/index.js';
import { broadcastKeys, type PendingBroadcast } from './broadcasts-api.js';
import './vnext-broadcast.css';

/**
 * VNextBroadcastAckGate — mounted once at the vNext app root. Fetches the
 * signed-in user's unacknowledged Capiro broadcasts and renders them one at a
 * time (oldest first) in a blocking dialog until each is acknowledged. Fails
 * open: a request error renders nothing rather than locking the user out.
 */
export function VNextBroadcastAckGate() {
  const api = useApi();
  const qc = useQueryClient();
  const me = useMe();
  const toast = useCapiroToast();

  const pending = useQuery<PendingBroadcast[]>({
    queryKey: broadcastKeys.pending,
    queryFn: async () => (await api.get<PendingBroadcast[]>('/api/me/broadcasts/pending')).data,
    enabled: Boolean(me.data),
    retry: false,
    staleTime: 30_000,
  });

  const acknowledge = useMutation({
    mutationFn: async (id: string) => (await api.post(`/api/me/broadcasts/${id}/acknowledge`)).data,
    onSuccess: (_data, id) => {
      qc.setQueryData<PendingBroadcast[]>(broadcastKeys.pending, (prev) =>
        (prev ?? []).filter((b) => b.id !== id),
      );
      void qc.invalidateQueries({ queryKey: broadcastKeys.pending });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const current = pending.data?.[0];
  if (!current) return null;

  return (
    <VNextBroadcastAckModal
      key={current.id}
      broadcast={current}
      remaining={pending.data?.length ?? 1}
      busy={acknowledge.isPending}
      onAcknowledge={() => acknowledge.mutate(current.id)}
    />
  );
}

export function VNextBroadcastAckModal({
  broadcast,
  remaining,
  busy,
  onAcknowledge,
}: {
  broadcast: PendingBroadcast;
  /** Total unacknowledged broadcasts including this one (for "1 of N"). */
  remaining: number;
  busy: boolean;
  onAcknowledge: () => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  // Focus trap + body scroll lock only; Escape is deliberately a no-op.
  useDialogFocus(dialogRef, () => {});

  return (
    <div className="vnext-bc-scrim" role="presentation">
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="vnext-bc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="vnext-bc-eyebrow">
          <span className="vnext-bc-eyebrow-puck" aria-hidden="true">
            <CapiroBellIcon size={1} />
          </span>
          Message from Capiro
          {remaining > 1 ? <span aria-label={`1 of ${remaining} messages`}>· 1 of {remaining}</span> : null}
        </div>
        <h2 id={titleId}>{broadcast.title}</h2>
        <p className="vnext-bc-meta">Sent {new Date(broadcast.createdAt).toLocaleString()}</p>
        <p className="vnext-bc-body">{broadcast.body}</p>
        <div className="vnext-bc-actions">
          <CapiroButton variant="primary" loading={busy} onClick={onAcknowledge}>
            Acknowledge
          </CapiroButton>
        </div>
        <p className="vnext-bc-footnote">
          This message stays here until you acknowledge it.
        </p>
      </section>
    </div>
  );
}
