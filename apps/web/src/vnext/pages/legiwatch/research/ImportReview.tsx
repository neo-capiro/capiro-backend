import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { StatuteMonitors } from './StatuteMonitors.js';
import { useApi } from '../../../../lib/use-api.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput, CapiroSelect } from '../../../components/fields/index.js';

type Row = {
  id: string;
  sourceId: string;
  version: number;
  sourceHash: string;
  targetFolderId: string | null;
  payload: Record<string, any>;
};
type Scope = {
  jurisdiction: string;
  sessionKey: string;
  folderId: string | null;
  clientId: string | null;
};
const BASE = '/intel-api/legiwatch/research';
export function ImportReview({
  rows,
  rules,
  scope,
  refresh,
}: {
  rows: Row[];
  rules: any[];
  scope: Scope;
  refresh: () => Promise<unknown>;
}) {
  const [page, setPage] = useState(0);
  return (
    <section aria-label="Review imported statutes and alerts">
      <h3>Statute assignments</h3>
      <p>
        {rows.length} preserved source rows. Review the captured label, official edition and current
        folder before importing.
      </p>
      {rows.slice(page * 10, page * 10 + 10).map((row) => (
        <MembershipReview key={row.id} row={row} scope={scope} refresh={refresh} />
      ))}
      <CapiroButton disabled={!page} onClick={() => setPage(page - 1)}>
        Previous assignments
      </CapiroButton>
      <CapiroButton disabled={(page + 1) * 10 >= rows.length} onClick={() => setPage(page + 1)}>
        More assignments
      </CapiroButton>
      <h3>
        {rules.length === 0
          ? 'No source alert definitions'
          : `${rules.length} source alert ${rules.length === 1 ? 'definition' : 'definitions'}`}
      </h3>
      {rules.map((rule) => (
        <RuleReview key={rule.id} rule={rule} scope={scope} refresh={refresh} />
      ))}
      <StatuteMonitors sessionKey={scope.sessionKey} />
    </section>
  );
}
function MembershipReview({
  row,
  scope,
  refresh,
}: {
  row: Row;
  scope: Scope;
  refresh: () => Promise<unknown>;
}) {
  const api = useApi(),
    [citation, setCitation] = useState(String(row.payload.statute_label ?? '')),
    [edition, setEdition] = useState('2026'),
    [reason, setReason] = useState(''),
    [candidates, setCandidates] = useState<any[]>([]),
    [selected, setSelected] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  const action = async (statusValue: 'imported' | 'unresolved' | 'excluded') => {
    setBusy(true);
    setStatus('');
    try {
      const candidate = candidates.find((c) => c.id === selected);
      const targetScope = { ...scope, folderId: row.targetFolderId, clientId: null };
      let membershipVersion = 0;
      if (statusValue === 'imported') {
        if (!candidate?.revision_id || !candidate.complete || !row.targetFolderId)
          throw Error('Choose a qualified source and mapped folder.');
        const current = await api.get<Array<{ reference_id: string; version: number }>>(
          BASE +
            '/memberships?' +
            new URLSearchParams(
              Object.entries(targetScope).filter(([, v]) => v !== null) as string[][],
            ),
        );
        membershipVersion = current.data.find((m) => m.reference_id === selected)?.version ?? 0;
      }
      const response = await api.post<{ status: string; reason: string }>(
        BASE + '/imports/decide',
        {
          ...targetScope,
          stagedId: row.id,
          sourceHash: row.sourceHash,
          expectedVersion: row.version,
          status: statusValue,
          reason,
          requestKey: crypto.randomUUID(),
          edition,
          referenceId: selected,
          revisionId: candidate?.revision_id,
          expectedMembershipVersion: membershipVersion,
          resolutionBasis: reason,
        },
      );
      setStatus(`${response.data.status}: ${response.data.reason}`);
      await refresh();
    } catch {
      setStatus(
        'Decision could not be applied. Review the source, reason, current folder access and membership version.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <article>
      <h4>
        {String(row.payload.folder_name ?? row.payload.folder_id)} ·{' '}
        {String(row.payload.statute_label)}
      </h4>
      <p>{String(row.payload.title ?? '')}</p>
      <p>
        Captured edition: not supplied. Mapped folder:{' '}
        {row.targetFolderId ? 'available' : 'requires review'}
      </p>
      <details>
        <summary>Captured source identity</summary>
        <p>{row.sourceId}</p>
        <p>{String(row.payload.statute_url ?? 'No source link captured')}</p>
      </details>
      <CapiroInput
        label="Official citation to review"
        value={citation}
        onChange={(e) => setCitation(e.target.value)}
      />
      <CapiroInput
        label="Source edition to review"
        value={edition}
        onChange={(e) => setEdition(e.target.value)}
      />
      <CapiroButton
        disabled={busy}
        onClick={async () => {
          setStatus('');
          try {
            const result = await api.get<{ rows: any[] }>(
              BASE +
                '/references?' +
                new URLSearchParams({
                  jurisdiction: scope.jurisdiction,
                  sessionKey: scope.sessionKey,
                  citation,
                  edition,
                  code: 'statute',
                }),
            );
            setCandidates(result.data.rows);
            setSelected('');
            if (!result.data.rows.length)
              setStatus('No qualified source has been retained for that citation and edition.');
          } catch {
            setStatus('Official source lookup is unavailable.');
          }
        }}
      >
        Find retained official source
      </CapiroButton>
      {candidates.length ? (
        <CapiroSelect
          label="Reviewed canonical target"
          value={selected}
          options={[
            { value: '', label: 'Choose an exact source' },
            ...candidates.map((c) => ({
              value: c.id,
              label: `${c.section ?? 'Chapter ' + c.chapter} · ${c.title ?? 'Text unavailable'} · ${c.complete ? 'source retained' : 'incomplete'}`,
            })),
          ]}
          onChange={(e) => setSelected(e.target.value)}
        />
      ) : null}
      <CapiroInput
        label="Resolution evidence or decision reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <CapiroButton
        disabled={busy || reason.length < 8 || !selected}
        onClick={() => action('imported')}
      >
        Import reviewed target
      </CapiroButton>
      <CapiroButton disabled={busy || reason.length < 3} onClick={() => action('unresolved')}>
        Record unresolved
      </CapiroButton>
      <CapiroButton disabled={busy || reason.length < 3} onClick={() => action('excluded')}>
        Exclude with reason
      </CapiroButton>
      {status ? <p role="status">{status}</p> : null}
    </article>
  );
}
function RuleReview({
  rule,
  scope,
  refresh,
}: {
  rule: any;
  scope: Scope;
  refresh: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const api = useApi(),
    [preview, setPreview] = useState<any>(null),
    [status, setStatus] = useState(''),
    [descendants, setDescendants] = useState(false);
  return (
    <article>
      <h4>{rule.interpretedName ?? 'Unnamed statute alert'}</h4>
      <p>{rule.sourceId} · Cadence not captured · Delivery inactive</p>
      <label>
        <input
          type="checkbox"
          checked={descendants}
          onChange={(e) => {
            setDescendants(e.target.checked);
            setPreview(null);
          }}
        />
        Preview descendants of chapter and section targets
      </label>
      <CapiroButton
        onClick={async () => {
          try {
            setPreview(
              (
                await api.post(BASE + '/imports/preview', {
                  ...scope,
                  stagedId: rule.id,
                  descendants,
                })
              ).data,
            );
            setStatus('');
          } catch {
            setStatus('Preview requires current administrator and folder access.');
          }
        }}
      >
        Preview actual folder targets
      </CapiroButton>
      {preview ? (
        <>
          <p>
            {preview.targets.length} current legal targets · {preview.matches.length} retained
            evidence matches · Search incomplete
          </p>
          <ul>
            {preview.targets.map((t: any, i: number) => (
              <li key={i}>
                {t.reference.kind} {t.reference.section ?? t.reference.chapter} · folder{' '}
                {t.sourceFolderId}
              </li>
            ))}
          </ul>
          <ul>
            {preview.gaps.map((g: any, i: number) => (
              <li key={i}>
                {g.sourceFolderId ?? 'Definition'}: {g.reason.replaceAll('_', ' ').toLowerCase()}
              </li>
            ))}
          </ul>
          <p>
            Current staff and channel mapping requires review. Historical matches establish a review
            baseline.
          </p>
        </>
      ) : null}
      <CapiroButton
        onClick={async () => {
          try {
            await api.post(BASE + '/imports/promote', {
              ...scope,
              stagedId: rule.id,
              expectedVersion: rule.version,
              sourceHash: rule.sourceHash,
            });
            setStatus('Definition saved for review. Matching and delivery remain paused.');
            await refresh();
            await queryClient.invalidateQueries({ queryKey: ['statute-monitors'] });
          } catch {
            setStatus('The captured source changed or promotion requires administrator access.');
          }
        }}
      >
        Create reviewable definition
      </CapiroButton>
      {status ? <p role="status">{status}</p> : null}
    </article>
  );
}
