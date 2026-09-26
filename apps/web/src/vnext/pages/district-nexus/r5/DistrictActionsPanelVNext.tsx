import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useMe } from '../../../../lib/me.js';
import { CapiroBadge } from '../../../components/badges/index.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroErrorState, CapiroSkeleton } from '../../../components/feedback/index.js';
import { changeDistrictActionStatus, editDistrictAction, getDistrictActions, stageDistrictAction,
  type ActionScope, type ActionText, type DistrictAction } from './r5-actions-api.js';

function ownerLabel(userId: string | null | undefined, meUserId: string | undefined): string {
  if (!userId) return 'Unassigned';
  if (meUserId && userId === meUserId) return 'You';
  return 'Assigned';
}

export function DistrictActionsPanelVNext(scope: ActionScope) {
  const api = useApi();
  const me = useMe();
  const queryClient = useQueryClient();
  const key = ['district-nexus', 'r5', 'actions', scope.clientId, scope.state, scope.district];
  const query = useQuery({ queryKey: key, queryFn: () => getDistrictActions(api, scope), retry: false });
  const [drafts, setDrafts] = useState<Record<string, Partial<ActionText>>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [reason, setReason] = useState<Record<string, string>>({});
  const stage = useMutation({ mutationFn: (actionKey: string) => stageDistrictAction(api, scope, actionKey, drafts[actionKey] ?? {}),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: key }); void queryClient.invalidateQueries({ queryKey: ['actions'] }); } });
  const edit = useMutation({ mutationFn: (id: string) => editDistrictAction(api, scope, id, drafts[id] ?? {}),
    onSuccess: () => { setEditing(null); void queryClient.invalidateQueries({ queryKey: key }); void queryClient.invalidateQueries({ queryKey: ['actions'] }); } });
  const dismiss = useMutation({ mutationFn: (id: string) => changeDistrictActionStatus(api, scope, id, 'dismissed', reason[id]),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: key }); void queryClient.invalidateQueries({ queryKey: ['actions'] }); } });
  if (query.isPending) return <div aria-busy="true"><CapiroSkeleton height={14} /></div>;
  if (query.isError) return <CapiroErrorState title="District actions could not load" description="This is an error, not an empty result." />;
  const setText = (id: string, field: keyof ActionText, value: string) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  const fields: Array<keyof ActionText> = ['issueTitle', 'whatChanged', 'whyItMatters', 'recommendedAction'];
  const textEditor = (id: string, item: ActionText) => <div>{fields.map((field) =>
    <label key={field} style={{ display: 'block' }}>{field}<textarea aria-label={`${id} ${field}`}
      style={{ width: '100%' }} value={drafts[id]?.[field] ?? item[field]}
      onChange={(e) => setText(id, field, e.target.value)} /></label>)}</div>;
  const sourceChips = (item: { facts?: Array<{ id: string; source: { label: string }; basis: string; coverage: string; freshness: { stale: boolean } }> }) =>
    item.facts?.map((fact) => <CapiroBadge key={fact.id} tone={fact.basis === 'verified_client_nexus' ? 'info' : 'neutral'}>
      {fact.source.label} · {fact.basis === 'verified_client_nexus' ? 'verified client nexus' : 'public context'}
      {fact.coverage === 'partial' ? ' · partial' : ''}{fact.freshness.stale ? ' · stale' : ''}
    </CapiroBadge>);
  const card = (item: DistrictAction & { key?: string; facts?: Array<{ id: string; source: { label: string }; basis: string; coverage: string; freshness: { stale: boolean } }> }, id: string, staged: boolean) =>
    <div key={id} className="dnx-kv" style={{ marginTop: 12 }}>
      <h5>{drafts[id]?.issueTitle ?? item.issueTitle} {staged ? <CapiroBadge tone="info">{item.status}</CapiroBadge> : null}</h5>
      {editing === id ? textEditor(id, item) : <><p>{item.whatChanged}</p><p>{item.whyItMatters}</p><p>Next step: {item.recommendedAction}</p></>}
      <p>Target: {item.targetAudience.length ? item.targetAudience.map((t) => t.label).join(', ') : 'No source-backed office target'}</p>
      <p>Proposed owner: {ownerLabel(item.ownerUserId, me.data?.user?.id)} · Deliverable: {item.suggestedArtifactType ?? 'Not specified'}</p>
      <p>Confidence: {item.confidence.clientRelevance ?? 'not assessed'}{item.uncertainty ? ` · ${item.uncertainty}` : ''}</p>
      <div className="dnx-dr-l2">{sourceChips(item)}</div>
      <div className="dnx-dr-l3">
        <CapiroButton size="compact" onClick={() => setEditing(editing === id ? null : id)}>{editing === id ? 'Cancel edit' : 'Edit'}</CapiroButton>
        {staged ? <CapiroButton size="compact" disabled={edit.isPending || editing !== id} onClick={() => edit.mutate(id)}>Save edit</CapiroButton>
          : <><CapiroButton size="compact" variant="primary" disabled={stage.isPending} onClick={() => stage.mutate(id)}>Stage</CapiroButton>
            <CapiroButton size="compact" onClick={() => setHidden((prev) => [...prev, id])}>Dismiss suggestion</CapiroButton></>}
      </div>
      {staged && item.status !== 'dismissed' ? <div><input aria-label={`Dismissal reason ${id}`} value={reason[id] ?? ''}
        onChange={(e) => setReason((prev) => ({ ...prev, [id]: e.target.value }))} placeholder="Reason required" />
        <CapiroButton size="compact" disabled={!reason[id]?.trim() || dismiss.isPending} onClick={() => dismiss.mutate(id)}>Dismiss staged</CapiroButton></div> : null}
    </div>;
  return <div className="dnx-priority">
    {(stage.isError || edit.isError || dismiss.isError) ? <div role="alert">Action could not be saved. Review and retry.</div> : null}
    <h5>Suggestions (not sent or staged automatically)</h5>
    {query.data.candidates.filter((c) => !hidden.includes(c.key) && !query.data.staged.some((s) => s.actionType === c.actionType && s.evidence[0]?.note === c.evidence[0]?.note)).map((c) => card({ ...c, id: c.key, districtKey: null, status: 'suggested' }, c.key, false))}
    <h5>Staged actions</h5>
    {query.data.staged.length ? query.data.staged.map((s) => card(s, s.id, true)) : <p>No staged actions yet.</p>}
  </div>;
}
