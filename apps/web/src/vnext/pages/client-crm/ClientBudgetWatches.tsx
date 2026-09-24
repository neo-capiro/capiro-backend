import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';

type WatchEvent = { id: string; eventType: string; materialReason?: string | null; updateEventId?: string | null; createdAt: string };
type Watch = { id: string; targetType: string; targetKey: string; clientReason: string; events: WatchEvent[] };
const keyFor = (clientId: string) => ['client-budget-watches', clientId] as const;

export function ClientBudgetWatches({ clientId }: { clientId: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const [targetType, setTargetType] = useState('program');
  const [targetKey, setTargetKey] = useState('');
  const [reason, setReason] = useState('');
  const query = useQuery({
    queryKey: keyFor(clientId),
    queryFn: async () => (await api.get<Watch[]>(`/api/clients/${encodeURIComponent(clientId)}/defense-budget-watches`)).data,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: keyFor(clientId) });
  const subscribe = useMutation({
    mutationFn: async () => api.post(`/api/clients/${encodeURIComponent(clientId)}/defense-budget-watches`, { targetType, targetKey: targetKey.trim(), clientReason: reason.trim() }),
    onSuccess: () => { setTargetKey(''); setReason(''); void refresh(); },
  });
  const setActive = useMutation({
    mutationFn: async ({ watch, subscribed }: { watch: Watch; subscribed: boolean }) => api.post(`/api/clients/${encodeURIComponent(clientId)}/defense-budget-watches/${encodeURIComponent(watch.id)}/subscription`, { subscribed }),
    onSuccess: () => void refresh(),
  });
  const decide = useMutation({
    mutationFn: async ({ watch, event, decision }: { watch: Watch; event: WatchEvent; decision: 'acknowledged' | 'dismissed' }) => api.post(`/api/clients/${encodeURIComponent(clientId)}/defense-budget-watches/${encodeURIComponent(watch.id)}/updates/${encodeURIComponent(event.id)}/decision`, { decision }),
    onSuccess: () => void refresh(),
  });

  return <section aria-labelledby="client-budget-watches-title" className="cap-budget-watches">
    <h2 id="client-budget-watches-title">Defense budget watches</h2>
    <p>Track material funding changes for this client and keep an auditable response history.</p>
    <form className="cap-budget-watches__form" onSubmit={(event) => { event.preventDefault(); subscribe.mutate(); }}>
      <label>Target type<select value={targetType} onChange={(event) => setTargetType(event.target.value)}>
        <option value="program">Program</option><option value="pe">Program element</option><option value="project">Project</option><option value="capability">Capability</option>
      </select></label>
      <label>Target key<input required maxLength={160} value={targetKey} onChange={(event) => setTargetKey(event.target.value)} placeholder="e.g. 0603xx" /></label>
      <label>Why this matters to the client<input required maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <button type="submit" disabled={subscribe.isPending || !targetKey.trim() || !reason.trim()}>{subscribe.isPending ? 'Adding…' : 'Add watch'}</button>
    </form>
    {subscribe.isError ? <p role="alert">Could not add watch. {subscribe.error instanceof Error ? subscribe.error.message : ''}</p> : null}
    {query.isLoading ? <p role="status">Loading client watches…</p> : null}
    {query.isError ? <div role="alert">Could not load client watches. <button type="button" onClick={() => void query.refetch()}>Retry</button></div> : null}
    {query.isSuccess && query.data.length === 0 ? <p>No defense budget watches for this client yet.</p> : null}
    {query.data?.map((watch) => {
      const subscription = [...watch.events].reverse().find((event) => ['subscribed', 'unsubscribed', 'resubscribed'].includes(event.eventType));
      const active = subscription?.eventType !== 'unsubscribed';
      return <article className="cap-budget-watches__item" key={watch.id}>
        <div className="cap-budget-watches__heading"><h3>{watch.targetType.toUpperCase()} · {watch.targetKey}</h3><span>{active ? 'Active' : 'Unsubscribed'}</span></div>
        <p><strong>Client reason:</strong> {watch.clientReason}</p>
        <button type="button" onClick={() => setActive.mutate({ watch, subscribed: !active })} disabled={setActive.isPending}>{active ? 'Unsubscribe' : 'Resubscribe'}</button>
        <h4>History</h4>
        {watch.events.length === 0 ? <p>No events recorded.</p> : <ol>{watch.events.map((event) => <li key={event.id}>
          <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time> · {event.eventType.replaceAll('_', ' ')}{event.materialReason ? ` — ${event.materialReason}` : ''}
          {event.eventType === 'material_update' ? <div className="cap-budget-watches__actions">
            {(['acknowledged', 'dismissed'] as const).map((decision) => {
              const existing = watch.events.find((candidate) =>
                candidate.updateEventId === event.id &&
                (candidate.eventType === 'acknowledged' || candidate.eventType === 'dismissed'),
              );
              const label = decision === 'acknowledged' ? 'Acknowledge' : 'Dismiss';
              const selected = existing?.eventType === decision;
              return <button type="button" key={decision} disabled={Boolean(existing) || decide.isPending} aria-label={`${label} update ${event.id}`} onClick={() => decide.mutate({ watch, event, decision })}>{selected ? decision === 'acknowledged' ? 'Acknowledged' : 'Dismissed' : label}</button>;
            })}
          </div> : null}
        </li>)}</ol>}
      </article>;
    })}
    {setActive.isError || decide.isError ? <p role="alert">Could not save that watch action. Please retry.</p> : null}
  </section>;
}
