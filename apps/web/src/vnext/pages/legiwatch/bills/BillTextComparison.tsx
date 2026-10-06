import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ComparisonLine, ResearchVersion } from '@capiro/shared';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroSelect } from '../../../components/fields/index.js';
import { orderedBillTexts, billTextLabel, readingBillChanges } from './bill-text-presentation.js';

type Version = Omit<ResearchVersion, 'sections'> & { title?: string };
type Comparison = { changes: ComparisonLine[]; warning?: string | null; classification: string };
const BASE = '/intel-api/legiwatch/research';

/** Exact retained revisions, explicitly selected: source order is not chronology. */
export function BillTextComparison({ billId }: { billId: string }) {
  const api = useApi(), identity = useApiScope();
  const key = /^([a-z]{2})-(\d{4}(?:x\d+)?)-/i.exec(billId);
  const scope = { jurisdiction: key?.[1]?.toUpperCase() ?? '', sessionKey: key?.[2] ?? '' };
  const [leftId, setLeftId] = useState(''), [rightId, setRightId] = useState('');
  const [raw, setRaw] = useState(false);
  const versions = useQuery({
    queryKey: ['bill-text-versions', identity, billId],
    enabled: Boolean(key), retry: false,
    queryFn: async () => (await api.get<{ versions: Version[]; complete: boolean }>(
      BASE + '/versions?' + new URLSearchParams({ ...scope, billId }),
    )).data,
  });
  const comparison = useMutation({
    mutationFn: async () => {
      const left = versions.data?.versions.find((v) => v.id === leftId);
      const right = versions.data?.versions.find((v) => v.id === rightId);
      if (!left?.complete || !right?.complete) throw new Error('Select two complete versions.');
      return (await api.post<Comparison>(BASE + '/compare', {
        ...scope, leftId, rightId, leftRevision: left.revision, rightRevision: right.revision,
      })).data;
    },
  });
  useEffect(() => { setLeftId(''); setRightId(''); comparison.reset(); }, [billId]);
  const reading = useMemo(() => readingBillChanges(comparison.data?.changes ?? []), [comparison.data]);
  if (!key) return null;
  const choices = orderedBillTexts(versions.data?.versions ?? []);
  const options = [{ value: '', label: 'Select a retained text version' }, ...choices.map((v) => ({
    value: v.id, label: billTextLabel(v),
  }))];
  const earlier = choices.find((v) => v.id === leftId), later = choices.find((v) => v.id === rightId);
  const reversed = Boolean(earlier?.publishedDate && later?.publishedDate && earlier.publishedDate > later.publishedDate);
  const changed = raw ? comparison.data?.changes.filter((line) => line.kind !== 'unchanged') ?? [] : reading.changes;
  return <section aria-label="Bill text comparison">
    <h3>Compare bill text</h3>
    {versions.isPending ? <p role="status">Loading retained versions…</p>
      : versions.isError ? <p role="alert">Retained text could not be loaded. <CapiroButton onClick={() => void versions.refetch()}>Retry</CapiroButton></p>
      : choices.length < 2 ? <p>Two complete text versions are needed for a comparison. Original bill text and published staff analyses are listed below when available.</p>
      : <>
        <p>Select the earlier and later published texts. Changes below compare exact wording; they do not infer legal effect.</p>
        {!versions.data?.complete && <p>Only the first 200 retained documents are listed.</p>}
        <CapiroSelect label="Earlier text" value={leftId} options={options} onChange={(e) => { setLeftId(e.target.value); comparison.reset(); }} />
        <CapiroSelect label="Later text" value={rightId} options={options} onChange={(e) => { setRightId(e.target.value); comparison.reset(); }} />
        {reversed && <p role="alert">Choose the earlier publication on the left and the later publication on the right.</p>}
        <CapiroButton disabled={!leftId || !rightId || leftId === rightId || reversed || comparison.isPending} onClick={() => comparison.mutate()}>Compare selected text</CapiroButton>
      </>}
    {comparison.isPending && <p role="status">Comparing exact revisions…</p>}
    {comparison.isError && <p role="alert">These revisions could not be compared. Re-select the versions or open their original documents below.</p>}
    {comparison.data && <>
      {comparison.data.warning && <p>{comparison.data.warning}</p>}
      <label><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Show exact extracted lines</label>
      {!raw && reading.normalized && <p>Reading view removes recognized Florida page headers and footers, and groups trailing-number differences for separate review. Those numbers may be printed line counters or substantive changes. It does not interpret legal effect. Use exact extracted lines to inspect every change.</p>}
      <p>{changed.length ? `${changed.filter((l) => l.kind === 'added').length} added lines · ${changed.filter((l) => l.kind === 'removed').length} removed lines` : !raw && reading.numericChanges.length ? 'Numeric differences require review below.' : 'No wording changes in this comparison view.'}</p>
      {!raw && reading.numericChanges.length > 0 && <details>
        <summary>Review numeric differences ({reading.numericChanges.length} lines): possible line numbering or substantive amendments</summary>
        <p>Original values are preserved. Do not assume these differences are formatting only.</p>
        {reading.numericChanges.map((line, i) => <p key={i}><strong>{line.kind === 'added' ? 'Added' : 'Removed'} · {(line.right ?? line.left)?.locator}: </strong>{line.kind === 'added' ? <ins>{line.text}</ins> : <del>{line.text}</del>}</p>)}
      </details>}
      <div style={{ maxHeight: 420, overflow: 'auto' }}>
        {changed.map((line, index) => <div key={index} style={{ marginBottom: 12 }}>
          <strong>{line.kind === 'added' ? 'Added' : 'Removed'} · {(line.right ?? line.left)?.locator}</strong>
          <div style={{ whiteSpace: 'pre-wrap' }}>{line.kind === 'added' ? <ins>{line.text}</ins> : <del>{line.text}</del>}</div>
        </div>)}
      </div>
    </>}
  </section>;
}
