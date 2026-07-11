import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Empty, Input, Select, Skeleton } from 'antd';
import { ArrowLeftOutlined, CheckCircleFilled } from '@ant-design/icons';
import { useApi } from '../../../lib/use-api.js';
import { useMeetingLibrary } from './meetings-api.js';
import { formatDateShort } from './meetings-format.js';
import { artifactStatus, type ArtifactKind, type Meeting } from './meetings-types.js';

const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  prep: 'Prep',
  notes: 'Notes',
  debrief: 'Debrief',
};
const LIMIT = 100;

interface ClientOption {
  id: string;
  name: string;
}

/** The Meeting Library (spec §3, §6): approved prep/notes/debriefs, private +
 *  shared, filterable by client / artifact / visibility, searchable. */
export function MeetingLibraryView({
  onBack,
  onOpenMeeting,
}: {
  onBack: () => void;
  onOpenMeeting: (m: Meeting) => void;
}) {
  const api = useApi();
  const [clientId, setClientId] = useState<string | undefined>(undefined);
  const [artifactType, setArtifactType] = useState<ArtifactKind | undefined>(undefined);
  const [visibility, setVisibility] = useState<'shared' | 'private' | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const clients = useQuery<ClientOption[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<ClientOption[]>('/api/clients')).data,
    staleTime: 300_000,
  });

  const library = useMeetingLibrary({ clientId, artifactType, visibility, page, limit: LIMIT });

  const rows = (library.data?.data ?? []).filter((m) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return m.subject.toLowerCase().includes(q) || (m.client?.name ?? '').toLowerCase().includes(q);
  });
  const total = library.data?.total ?? 0;

  return (
    <div className="mtg-shell">
      <div className="mtg-toolbar">
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} size="small">
          Meetings
        </Button>
        <span style={{ color: 'var(--ink-3)' }}>/ Library</span>
        <div className="mtg-toolbar-title" style={{ marginLeft: 8 }}>
          Meeting Library
        </div>
      </div>
      <p className="mtg-lib-intro">
        Approved prep, notes, and debriefs — private and shared. Only materials you&apos;ve approved
        or saved appear here. Searchable by client and date.
      </p>
      <div className="mtg-library-filters">
        <Input.Search
          placeholder="Search meetings, clients…"
          allowClear
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 240 }}
        />
        <Select
          placeholder="All clients"
          allowClear
          loading={clients.isLoading}
          value={clientId}
          onChange={(v) => {
            setClientId(v);
            setPage(1);
          }}
          options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          style={{ minWidth: 180 }}
        />
        <div className="mtg-chipfilter">
          {([undefined, 'prep', 'notes', 'debrief'] as const).map((t) => (
            <button
              key={t ?? 'all'}
              type="button"
              className={artifactType === t ? 'active' : ''}
              onClick={() => {
                setArtifactType(t);
                setPage(1);
              }}
            >
              {t ? ARTIFACT_LABELS[t] : 'All'}
            </button>
          ))}
        </div>
        <div className="mtg-chipfilter">
          {([undefined, 'shared', 'private'] as const).map((v) => (
            <button
              key={v ?? 'all'}
              type="button"
              className={visibility === v ? 'active' : ''}
              onClick={() => {
                setVisibility(v);
                setPage(1);
              }}
            >
              {v ? v.charAt(0).toUpperCase() + v.slice(1) : 'All'}
            </button>
          ))}
        </div>
      </div>

      {library.isLoading ? (
        <div style={{ padding: 18 }}>
          <Skeleton active paragraph={{ rows: 4 }} />
        </div>
      ) : rows.length === 0 ? (
        <Empty description="No approved materials match these filters." style={{ padding: 40 }} />
      ) : (
        <table className="engagement-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 18px' }}>Date</th>
              <th style={{ textAlign: 'left', padding: '8px 18px' }}>Meeting</th>
              <th style={{ textAlign: 'left', padding: '8px 18px' }}>Materials</th>
              <th style={{ textAlign: 'left', padding: '8px 18px' }}>Visibility</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const status = artifactStatus(m);
              return (
                <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => onOpenMeeting(m)}>
                  <td style={{ padding: '10px 18px', whiteSpace: 'nowrap', color: 'var(--ink-2)' }}>
                    {formatDateShort(m.startsAt)}
                  </td>
                  <td style={{ padding: '10px 18px' }}>
                    <div style={{ fontWeight: 650 }}>{m.subject}</div>
                    <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                      {m.client?.name ?? '—'}
                    </div>
                  </td>
                  <td style={{ padding: '10px 18px' }}>
                    <div className="mtg-artifacts">
                      {(Object.keys(ARTIFACT_LABELS) as ArtifactKind[]).map((k) => (
                        <span
                          key={k}
                          className={`mtg-artifact-pill${status[k] ? ' is-complete' : ''}`}
                        >
                          {status[k] ? <CheckCircleFilled /> : null}
                          {ARTIFACT_LABELS[k]}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ padding: '10px 18px' }}>
                    <span
                      className={`mtg-vis-badge ${m.visibility === 'shared' ? 'is-shared' : 'is-private'}`}
                    >
                      {m.visibility === 'shared' ? 'SHARED' : 'PRIVATE'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {total > LIMIT ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: 14 }}>
          <Button size="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span style={{ alignSelf: 'center', color: 'var(--ink-3)', fontSize: 12 }}>
            Page {page} of {Math.ceil(total / LIMIT)}
          </span>
          <Button
            size="small"
            disabled={page >= Math.ceil(total / LIMIT)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
