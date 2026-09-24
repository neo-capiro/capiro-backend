import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroBadge } from '../../../components/badges/index.js';
import { CapiroErrorState, CapiroSkeleton } from '../../../components/feedback/index.js';
import { generateDistrictPrep, listDistrictPrepMeetings, updateDistrictPrep,
  type R5MeetingPrep, type R5PrepItem, type R5Fact } from './r5-api.js';

const editable = ['agenda', 'talkingPoints', 'questions', 'followUps'] as const;
type EditableKey = typeof editable[number];
function items(prep: R5MeetingPrep, key: EditableKey): R5PrepItem[] {
  return key === 'questions' ? prep.generatedFrom.questions : prep[key];
}
function source(f: R5Fact): string {
  return [f.source.label, f.asOf.date?.slice(0, 10) ?? (f.asOf.fiscalYear ? `FY${f.asOf.fiscalYear}` : null),
    f.amountStage, f.geography.scope === 'statewide' ? 'statewide' : null,
    f.basis === 'verified_client_nexus' ? 'verified client nexus' : 'public context',
    f.freshness.stale ? 'stale' : f.freshness.unavailable ? 'freshness unknown' : null,
    f.coverage === 'partial' ? 'partial coverage' : null].filter(Boolean).join(' · ');
}
export function DistrictMeetingPrepPanelVNext({ clientId, state, district }: { clientId: string; state: string; district: string }) {
  const api = useApi();
  const [meetingId, setMeetingId] = useState('');
  const [prep, setPrep] = useState<R5MeetingPrep | null>(null);
  const [draft, setDraft] = useState<Partial<Record<EditableKey, R5PrepItem[]>>>({});
  useEffect(() => { setMeetingId(''); setPrep(null); setDraft({}); }, [clientId, state, district]);
  const meetings = useQuery({ queryKey: ['district-nexus', 'r5', 'prep-meetings', clientId],
    queryFn: () => listDistrictPrepMeetings(api, clientId), enabled: Boolean(clientId), retry: false });
  const generate = useMutation({ mutationFn: () => generateDistrictPrep(api, { clientId, state, district, meetingId }),
    onSuccess: (result) => { setPrep(result); setDraft({}); } });
  const save = useMutation({ mutationFn: (reviewed: boolean) => updateDistrictPrep(api, prep!.id, { ...draft, reviewed }),
    onSuccess: (result) => { setPrep(result); setDraft({}); } });
  if (meetings.isPending) return <div aria-busy="true"><CapiroSkeleton height={14} /></div>;
  if (meetings.isError) return <CapiroErrorState title="Meetings could not load" description="This is an error, not an empty result." />;
  if (!meetings.data?.length) return <p>No linked meetings for this client. <Link to="/engagement/meetings">Open existing meetings</Link> to link one first.</p>;
  return <div className="dnx-priority">
    <label htmlFor="r5-prep-meeting">Existing meeting</label>{' '}
    <select id="r5-prep-meeting" value={meetingId} onChange={(e) => { setMeetingId(e.target.value); setPrep(null); setDraft({}); }}>
      <option value="">Select meeting</option>
      {meetings.data.map((m) => <option key={m.id} value={m.id}>{m.subject} · {new Date(m.startsAt).toLocaleString()}</option>)}
    </select>{' '}
    <CapiroButton size="compact" disabled={!meetingId || generate.isPending} onClick={() => generate.mutate()}>Generate</CapiroButton>
    {generate.isError ? <div role="alert">Generation failed: {generate.error.message}</div> : null}
    {prep ? <>
      <p><Link to={`/engagement/meetings/${encodeURIComponent(prep.meetingId)}`}>Open meeting →</Link> · {prep.status}</p>
      <p>Attendees / targets: {prep.generatedFrom.attendeesTargets.join(', ') || 'None recorded'}</p>
      {editable.map((key) => <div key={key} style={{ marginTop: 12 }}>
        <h5>{key === 'agenda' ? 'Objectives' : key === 'talkingPoints' ? 'Talking points' : key === 'followUps' ? 'Follow-ups' : 'Questions'}</h5>
        {(draft[key] ?? items(prep, key)).map((entry, index) => <div key={index}>
          <textarea aria-label={`${key} ${index + 1}`} style={{ width: '100%', minHeight: 55 }} value={entry.text}
            onChange={(e) => setDraft({ ...draft, [key]: (draft[key] ?? items(prep, key)).map((it, i) => i === index ? { ...it, text: e.target.value } : it) })} />
          {entry.factIds.map((id) => { const fact = prep.generatedFrom.evidence.find((f) => f.id === id);
            return fact ? <CapiroBadge key={id} tone={fact.basis === 'verified_client_nexus' ? 'info' : 'neutral'}>{source(fact)}</CapiroBadge> : null; })}
        </div>)}
        <CapiroButton size="compact" onClick={() => setDraft({ ...draft, [key]: [...(draft[key] ?? items(prep, key)), { text: '', factIds: [] }] })}>Add item</CapiroButton>
      </div>)}
      <h5>Risks / source gaps</h5>{prep.risks.map((risk, i) => <p key={i}>{risk.text}</p>)}
      <CapiroButton size="compact" disabled={!Object.keys(draft).length || save.isPending} onClick={() => save.mutate(false)}>Save edits</CapiroButton>{' '}
      <CapiroButton size="compact" disabled={save.isPending} onClick={() => save.mutate(true)}>Mark reviewed</CapiroButton>
      {save.isError ? <div role="alert">Save failed: {save.error.message}</div> : null}
    </> : null}
  </div>;
}
