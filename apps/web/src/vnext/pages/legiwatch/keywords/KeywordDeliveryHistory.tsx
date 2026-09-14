import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput } from '../../../components/fields/index.js';
import { folderError } from '../bills/folder-api.js';
import { REPORT_BASE } from '../reports/report-api.js';
type History = {
  limit: number;
  controls: Array<{
    id: string;
    created_at: string;
    payload: { after: { state: string; version: number; config: { deliveryEnabled?: boolean } } };
  }>;
  deliveries: Array<{
    id: string;
    contentHash: string;
    composition: { title: string };
    recipients: Array<{
      id: string;
      state: string;
      channel: string;
      error?: string;
      recipient: { userId: string };
    }>;
  }>;
};
const names: Record<string, string> = {
  provider_accepted: 'Provider accepted',
  uncertain: 'Outcome unconfirmed',
  held: 'Held for review',
  suppressed: 'Included in a daily update',
  terminal: 'Stopped',
  queued: 'Queued',
  sending: 'Sending',
  claimed: 'Preparing delivery',
  retryable: 'Waiting to retry',
};
export function KeywordDeliveryHistory({ identity, ruleId }: { identity: string; ruleId: string }) {
  const api = useApi(),
    qc = useQueryClient(),
    alive = useRef(true),
    [open, setOpen] = useState(false),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const history = useQuery({
    queryKey: ['lw-keywords', identity, 'delivery-history', ruleId],
    enabled: open,
    queryFn: async () =>
      (
        await api.get<History>(
          '/intel-api/legiwatch/keyword-rules/' + encodeURIComponent(ruleId) + '/deliveries',
        )
      ).data,
    retry: false,
  });
  async function retry(id: string, contentHash: string) {
    setBusy(true);
    setError('');
    try {
      await api.post(REPORT_BASE + '/deliveries/' + encodeURIComponent(id) + '/retry', {
        contentHash,
        reason,
      });
      if (alive.current) {
        setReason('');
        await qc.invalidateQueries({
          queryKey: ['lw-keywords', identity, 'delivery-history', ruleId],
        });
      }
    } catch (e) {
      if (alive.current) setError(folderError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Staff delivery and control history</summary>
      <p>
        Latest 100 occurrences and changes. Provider acceptance is recorded separately from
        confirmed delivery. An unconfirmed outcome needs reconciliation before another attempt.
      </p>
      {history.isLoading ? <p role="status">Loading delivery history…</p> : null}
      {error || history.error ? <p role="alert">{error || folderError(history.error)}</p> : null}
      <CapiroInput
        label="Reason for a reviewed retry"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
      />
      {history.data?.deliveries.map((d) => (
        <article className="lw-keywords-run" key={d.id}>
          <h4>{d.composition.title}</h4>
          {d.recipients.map((r) => (
            <div key={r.id}>
              <p>
                {r.channel === 'in_app' ? 'In app' : 'Email'} · {names[r.state] ?? r.state}
              </p>
              {r.error ? <p>{r.error.replaceAll('_', ' ').toLowerCase()}</p> : null}
              {r.state === 'held' ? (
                <CapiroButton
                  size="compact"
                  disabled={busy || !reason.trim()}
                  onClick={() => void retry(r.id, d.contentHash)}
                >
                  Recheck and retry reviewed message
                </CapiroButton>
              ) : null}
            </div>
          ))}
        </article>
      ))}
      {history.data && !history.data.deliveries.length ? (
        <p>No delivery occurrences for this rule.</p>
      ) : null}
      {history.data?.controls.map((c) => (
        <p key={c.id}>
          {new Date(c.created_at).toLocaleString()} · version {c.payload.after.version} ·{' '}
          {c.payload.after.state.replaceAll('_', ' ')} · staff delivery{' '}
          {c.payload.after.config.deliveryEnabled ? 'enabled' : 'paused'}
        </p>
      ))}
    </details>
  );
}
