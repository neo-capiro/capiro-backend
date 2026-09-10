import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroSelect } from '../../../components/fields/index.js';
import { folderKey } from './folder-api.js';

interface RecordPage {
  rows: Array<{
    id: string;
    date: string;
    text?: string;
    label?: string;
    url?: string | null;
    yeas?: number;
    nays?: number;
    providerDocumentId?: number;
  }>;
  total: number;
  nextCursor: string | null;
  reason: string | null;
  coverage: string;
}
const safeSource = (url: string | null | undefined) => {
  try {
    const u = new URL(url ?? '');
    return ['https:', 'http:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};
export function BillSourceRecords({
  billId,
  initialSection = 'history',
}: {
  billId: string;
  initialSection?: 'history' | 'documents' | 'votes';
}) {
  const api = useApi(),
    identity = useApiScope();
  const [section, setSection] = useState(initialSection),
    [cursor, setCursor] = useState<string | undefined>(),
    [history, setHistory] = useState<Array<string | undefined>>([]);
  const [voteId, setVoteId] = useState<string | null>(null);
  const records = useQuery({
    queryKey: [...folderKey(identity), 'source-records', billId, section, cursor],
    queryFn: async () =>
      (
        await api.get<RecordPage>(`/intel-api/bills/${encodeURIComponent(billId)}/records`, {
          params: { section, cursor },
        })
      ).data,
    enabled: /^[a-z]{2}-/i.test(billId),
    retry: false,
  });
  const members = useQuery({
    queryKey: [...folderKey(identity), 'vote-members', billId, voteId],
    queryFn: async () =>
      (
        await api.get<
          Array<{
            providerPersonId: number;
            legislatorId: string | null;
            name: string | null;
            voteCast: string;
          }>
        >(
          `/intel-api/bills/${encodeURIComponent(billId)}/votes/${encodeURIComponent(voteId!)}/members`,
        )
      ).data,
    enabled: Boolean(voteId),
    retry: false,
  });
  if (!/^[a-z]{2}-/i.test(billId)) return null;
  return (
    <section className="lw-folder-context" aria-label="Original legislative records">
      <h3>Original legislative records</h3>
      <CapiroSelect
        label="Record section"
        value={section}
        options={[
          { value: 'history', label: 'Complete action history' },
          { value: 'documents', label: 'Bill documents and versions' },
          { value: 'votes', label: 'Recorded roll-call votes' },
        ]}
        onChange={(e) => {
          setSection(e.target.value as typeof section);
          setCursor(undefined);
          setHistory([]);
          setVoteId(null);
        }}
      />
      {records.isPending ? (
        <p role="status">Loading records…</p>
      ) : records.isError ? (
        <p role="alert">
          The source records are unavailable.{' '}
          <CapiroButton onClick={() => void records.refetch()}>Retry</CapiroButton>
        </p>
      ) : (
        <>
          <p>
            {records.data.total} records · {records.data.coverage}
          </p>
          {records.data.reason && <p>{records.data.reason}</p>}
          <ol>
            {records.data.rows.map((r) => (
              <li key={r.id}>
                <time>{r.date?.slice(0, 10)}</time> · {r.text ?? r.label}
                {r.yeas !== undefined && ` · ${r.yeas}–${r.nays}`}
                {safeSource(r.url) ? (
                  <>
                    {' '}
                    ·{' '}
                    <a href={safeSource(r.url)!} target="_blank" rel="noreferrer">
                      Open original source
                    </a>
                  </>
                ) : section === 'documents' ? (
                  <span> · Source link unavailable</span>
                ) : null}
                {section === 'votes' && (
                  <CapiroButton size="compact" onClick={() => setVoteId(r.id)}>
                    Member votes
                  </CapiroButton>
                )}
              </li>
            ))}
          </ol>
          <div className="lw-folder-actions">
            <CapiroButton
              disabled={!history.length}
              onClick={() => {
                setCursor(history[history.length - 1]);
                setHistory(history.slice(0, -1));
              }}
            >
              Previous records
            </CapiroButton>
            <CapiroButton
              disabled={!records.data.nextCursor}
              onClick={() => {
                setHistory([...history, cursor]);
                setCursor(records.data.nextCursor ?? undefined);
              }}
            >
              Next records
            </CapiroButton>
          </div>
        </>
      )}
      {voteId && (
        <div>
          <h4>Recorded member votes</h4>
          {members.isPending ? (
            <p>Loading members…</p>
          ) : members.isError ? (
            <p role="alert">Member detail unavailable.</p>
          ) : members.data?.length ? (
            <ul>
              {members.data.map((m) => (
                <li key={m.providerPersonId}>
                  {m.legislatorId ? (
                    <a href={`/directory/state-legislators/${encodeURIComponent(m.legislatorId)}`}>
                      {m.name ?? 'Legislator profile'}
                    </a>
                  ) : (
                    (m.name ?? 'Unresolved legislator')
                  )}{' '}
                  · {m.voteCast}
                </li>
              ))}
            </ul>
          ) : (
            <p>No member detail has been ingested.</p>
          )}
          <CapiroButton onClick={() => setVoteId(null)}>Close member detail</CapiroButton>
        </div>
      )}
    </section>
  );
}
