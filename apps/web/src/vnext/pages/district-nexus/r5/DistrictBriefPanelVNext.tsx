import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { CapiroSkeleton, CapiroErrorState } from '../../../components/feedback/index.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroBadge } from '../../../components/badges/index.js';
import {
  getDistrictBrief, exportDistrictBriefDocx, saveDistrictBrief,
  type R5Brief, type R5BriefSection, type R5Fact, type R5BriefSaveInput,
  type R5BriefSaveResult,
} from './r5-api.js';

function sourceLabel(f: R5Fact): string {
  const date = f.asOf.date?.slice(0, 10) ?? (f.asOf.fiscalYear ? `FY${f.asOf.fiscalYear}` : null);
  return [f.source.label, date, f.amountStage,
    f.freshness.unavailable ? 'freshness unknown' : f.freshness.stale ? 'stale' : null,
    f.coverage === 'partial' ? 'partial' : null,
    f.basis === 'verified_client_nexus' ? 'verified client nexus' : 'public context',
  ].filter(Boolean).join(' · ');
}

export function DistrictBriefPanelVNext({ clientId, state, district }: {
  clientId: string; state: string; district: string;
}) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [editedSections, setEditedSections] = useState<R5BriefSection[] | null>(null);
  const [saveResult, setSaveResult] = useState<R5BriefSaveResult | null>(null);
  const brief = useQuery<R5Brief>({
    queryKey: ['district-nexus', 'r5', 'brief', clientId, state, district],
    queryFn: () => getDistrictBrief(api, clientId, state, district),
    enabled: Boolean(clientId && state && district), retry: false, staleTime: 60_000,
  });
  const sections = editedSections ?? brief.data?.sections ?? [];
  const inputFor = (items: R5BriefSection[]): R5BriefSaveInput => ({
    clientId, state, district,
    sections: items.map((s) => ({ key: s.key, title: s.title, paragraphs: s.paragraphs })),
    factIds: [...new Set(items.flatMap((s) => s.factIds))],
  });
  const exportMut = useMutation({
    mutationFn: (items: R5BriefSection[]) => exportDistrictBriefDocx(api, inputFor(items)),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `district-brief-${state}-${district}.docx`;
      link.click();
      URL.revokeObjectURL(url);
    },
  });
  const saveMut = useMutation({
    mutationFn: (items: R5BriefSection[]) => saveDistrictBrief(api, inputFor(items)),
    onSuccess: (result) => setSaveResult(result),
  });

  if (brief.isPending) return <div className="dnx-skel-rows" aria-busy="true"><CapiroSkeleton height={14} /><CapiroSkeleton height={14} /></div>;
  if (brief.isError) return <CapiroErrorState title="District Brief could not load" description="This is an error, not an empty result." />;
  const data = brief.data;
  if (!data) return null;

  return <div className="dnx-priority">
    <div className="dnx-dr-l3">
      {editing ? <>
        <CapiroButton size="compact" variant="primary" onClick={() => setEditing(false)}>Done editing</CapiroButton>
        <CapiroButton size="compact" onClick={() => setEditedSections(structuredClone(data.sections))}>Reset to draft</CapiroButton>
      </> : <CapiroButton size="compact" onClick={() => { setEditedSections(structuredClone(data.sections)); setEditing(true); }}>Edit</CapiroButton>}
      <CapiroButton size="compact" disabled={exportMut.isPending} onClick={() => exportMut.mutate(sections)}>Export .docx</CapiroButton>
      <CapiroButton size="compact" variant="primary" disabled={saveMut.isPending} onClick={() => saveMut.mutate(sections)}>Save to client</CapiroButton>
    </div>
    {exportMut.isError ? <div className="dnx-hint dnx-warning">Export failed: {exportMut.error.message}</div> : null}
    {saveMut.isError ? <div className="dnx-hint dnx-warning">Save failed: {saveMut.error.message}</div> : null}
    {saveResult ? <div className="dnx-hint dnx-info">Saved as <strong>{saveResult.fileName}</strong> (ID: {saveResult.attachmentId})</div> : null}
    {sections.map((section) => <div key={section.key} className="dnx-kv" style={{ marginTop: 12 }}>
      <h5>{section.title}</h5>
      {editing ? <textarea aria-label={`Edit ${section.title}`} style={{ width: '100%', minHeight: 100 }}
        value={section.paragraphs.join('\n')} onChange={(event) => {
          setEditedSections(sections.map((s) => s.key === section.key
            ? { ...s, paragraphs: event.target.value.split('\n') } : s));
        }} /> : section.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
      <div className="dnx-dr-l2">{data.facts.filter((f) => section.factIds.includes(f.id)).map((f) =>
        <CapiroBadge key={f.id} tone={f.basis === 'verified_client_nexus' ? 'info' : 'neutral'}>{sourceLabel(f)}</CapiroBadge>)}</div>
    </div>)}
    {data.gaps.length ? <div className="dnx-hint dnx-info">{data.gaps.map((g, i) => <div key={i}>{g.reason}</div>)}</div> : null}
    <div className="dnx-muted" style={{ fontSize: 11 }}>Generated {new Date(data.generatedAt).toLocaleString('en-US')}</div>
  </div>;
}
