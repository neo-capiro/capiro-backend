import { useMemo, useState } from 'react';
import { Alert, Button, Empty, Input, Spin, Tooltip } from 'antd';
import {
  AimOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  FileSearchOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import { liveHearingApiError } from './live-hearings-api.js';
import { LiveHearingsPhase7Surface } from './LiveHearingsPhase7Surface.js';
import {
  usePhase8Intelligence,
  type Phase8ClientGroup,
  type Phase8Insight,
} from './live-hearings-phase8-api.js';
import './LiveHearingsPhase8Surface.css';

const TYPE_LABELS: Record<string, string> = {
  QUESTION: 'Question',
  COMMITMENT: 'Commitment',
  DEADLINE: 'Deadline',
  FUNDING_AMOUNT: 'Funding',
  BILL_REFERENCE: 'Bill',
  PROGRAM_ELEMENT_REFERENCE: 'Program Element',
  AGENCY_REFERENCE: 'Agency',
  POLICY_POSITION: 'Policy position',
  KEY_QUOTE: 'Key quote',
  MENTION: 'Mention',
};

function titleCase(value?: string): string {
  return (value ?? 'Unknown')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTranscriptTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function phase8InsightTone(type: string): string {
  if (type === 'COMMITMENT') return 'commitment';
  if (type === 'DEADLINE') return 'deadline';
  if (type === 'FUNDING_AMOUNT' || type === 'PROGRAM_ELEMENT_REFERENCE') return 'funding';
  if (type === 'POLICY_POSITION') return 'position';
  if (type === 'QUESTION') return 'question';
  if (type === 'KEY_QUOTE') return 'quote';
  return 'reference';
}

function statusLabel(status: string): string {
  if (status === 'READY') return 'Current';
  if (status === 'PROCESSING') return 'Processing';
  if (status === 'DEGRADED') return 'Partially available';
  if (status === 'FAILED') return 'Extraction failed';
  return 'Awaiting transcript';
}

function Confidence({ value }: { value?: number }) {
  if (value == null) return null;
  return (
    <Tooltip title="Extraction confidence; not a probability that the underlying public statement is true.">
      <span className="lh8-confidence">{Math.round(value * 100)}% extraction confidence</span>
    </Tooltip>
  );
}

function EvidenceBlock({ insight }: { insight: Phase8Insight }) {
  return (
    <div className="lh8-evidence">
      <div className="lh8-evidence__header">
        <span>
          <FileSearchOutlined /> Transcript evidence
        </span>
        <code>{formatTranscriptTime(insight.evidence.startMs)}</code>
      </div>
      {insight.evidence.text ? <blockquote>{insight.evidence.text}</blockquote> : null}
      <small>
        Segment {insight.evidence.sequence} · {insight.evidence.segmentId}
      </small>
    </div>
  );
}

function RelevanceChips({ insight }: { insight: Phase8Insight }) {
  if (!insight.relevance.length) return null;
  return (
    <div className="lh8-relevance-chips">
      {insight.relevance.map((match) => (
        <Tooltip key={match.id} title={match.rationale}>
          <span>
            <TeamOutlined /> {match.clientName ?? 'Client'} · {Math.round(match.score)}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

function InsightCard({ insight }: { insight: Phase8Insight }) {
  return (
    <article className="lh8-insight" data-tone={phase8InsightTone(insight.insightType)}>
      <div className="lh8-insight__topline">
        <span className="lh8-type">{TYPE_LABELS[insight.insightType] ?? titleCase(insight.insightType)}</span>
        {insight.preliminary ? <span className="lh8-preliminary">Preliminary</span> : null}
        <Confidence value={insight.confidence} />
      </div>
      <h4>{insight.title}</h4>
      <p>{insight.summary}</p>
      {insight.speakerName ? <small className="lh8-speaker">Speaker: {insight.speakerName}</small> : null}
      {insight.entities.length ? (
        <div className="lh8-entities">
          {insight.entities.map((entity, index) => (
            <span key={`${entity.entityType}:${entity.canonicalId ?? entity.label}:${index}`}>
              {entity.label}
              {entity.canonicalId && entity.canonicalId !== entity.label ? (
                <small>{entity.canonicalId}</small>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      <RelevanceChips insight={insight} />
      <EvidenceBlock insight={insight} />
    </article>
  );
}

function ClientGroupCard({ group }: { group: Phase8ClientGroup }) {
  return (
    <article className="lh8-client-card">
      <div>
        <span className="lh8-client-card__icon"><AimOutlined /></span>
        <div>
          <strong>{group.clientName ?? 'Client'}</strong>
          <small>{group.matchCount} relevant finding{group.matchCount === 1 ? '' : 's'}</small>
        </div>
      </div>
      <span className="lh8-score">{Math.round(group.maxScore)}</span>
      {group.matchedOn.length ? (
        <div className="lh8-client-card__signals">
          {group.matchedOn.slice(0, 8).map((match) => (
            <span key={`${match.kind}:${match.value}`}>{titleCase(match.kind)} · {match.value}</span>
          ))}
        </div>
      ) : null}
      {group.rationales[0] ? <p>{group.rationales[0]}</p> : null}
    </article>
  );
}

function IntelligenceRail({ hearingId }: { hearingId: string }) {
  const intelligence = usePhase8Intelligence(hearingId, { limit: 500 });
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [clientFilter, setClientFilter] = useState('ALL');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (intelligence.data?.items ?? []).filter((item) => {
      if (typeFilter !== 'ALL' && item.insightType !== typeFilter) return false;
      if (
        clientFilter !== 'ALL' &&
        !item.relevance.some((match) => match.clientId === clientFilter)
      ) {
        return false;
      }
      if (!query) return true;
      return [
        item.title,
        item.summary,
        item.speakerName ?? '',
        item.evidence.text ?? '',
        ...item.entities.map((entity) => `${entity.label} ${entity.canonicalId ?? ''}`),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [clientFilter, intelligence.data?.items, search, typeFilter]);

  if (intelligence.isLoading) {
    return (
      <aside className="lh8-rail" aria-label="Live hearing intelligence">
        <div className="lh8-loading"><Spin /><span>Deriving source-grounded intelligence…</span></div>
      </aside>
    );
  }
  if (intelligence.isError) {
    return (
      <aside className="lh8-rail" aria-label="Live hearing intelligence">
        <Alert
          type="error"
          showIcon
          message="Live intelligence could not be loaded"
          description={liveHearingApiError(intelligence.error)}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void intelligence.refetch()}>Retry</Button>}
        />
      </aside>
    );
  }

  const data = intelligence.data;
  if (!data) return null;
  const types = Object.keys(data.summary.byType).sort();

  return (
    <aside className="lh8-rail" aria-label="Live hearing intelligence">
      <header className="lh8-rail__header">
        <div>
          <span className="lh8-eyebrow"><BulbOutlined /> Phase 8 · evidence bound</span>
          <h2>Live Intelligence</h2>
        </div>
        <span className={`lh8-state lh8-state--${data.status.toLowerCase()}`}>
          {data.status === 'READY' ? <CheckCircleOutlined /> : <ClockCircleOutlined />}
          {statusLabel(data.status)}
        </span>
      </header>

      <div className="lh8-boundary">
        <SafetyCertificateOutlined />
        <span>
          Public findings come only from the canonical transcript. Client matches remain tenant-private.
        </span>
      </div>

      <section className="lh8-recap">
        <div className="lh8-recap__heading">
          <span>{data.recap.state === 'FINAL' ? 'Final hearing recap' : 'Live recap'}</span>
          <small>{data.summary.total} findings · {data.summary.evidenceSegments} evidence segments</small>
        </div>
        <p>{data.recap.overview}</p>
        <div className="lh8-recap__counts">
          {Object.entries(data.summary.byType).map(([type, count]) => (
            <button key={type} type="button" onClick={() => setTypeFilter(type)}>
              <strong>{count}</strong>
              <span>{TYPE_LABELS[type] ?? titleCase(type)}</span>
            </button>
          ))}
        </div>
      </section>

      {data.clientGroups.length ? (
        <section className="lh8-section">
          <div className="lh8-section__heading">
            <div><span className="lh8-eyebrow">Tenant-private layer</span><h3>What matters to your clients</h3></div>
            <span>{data.clientGroups.length}</span>
          </div>
          <div className="lh8-client-list">
            {data.clientGroups.map((group) => (
              <button
                className={clientFilter === group.clientId ? 'is-active' : ''}
                key={group.clientId}
                type="button"
                onClick={() => setClientFilter((current) => current === group.clientId ? 'ALL' : group.clientId)}
              >
                <ClientGroupCard group={group} />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="lh8-section">
        <div className="lh8-section__heading">
          <div><span className="lh8-eyebrow">Canonical public record</span><h3>Source-grounded findings</h3></div>
          <span>{filtered.length}</span>
        </div>
        <div className="lh8-filters">
          <Input
            allowClear
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search findings or evidence"
          />
          <div className="lh8-filter-row">
            <button type="button" className={typeFilter === 'ALL' ? 'is-active' : ''} onClick={() => setTypeFilter('ALL')}>All</button>
            {types.map((type) => (
              <button key={type} type="button" className={typeFilter === type ? 'is-active' : ''} onClick={() => setTypeFilter(type)}>
                {TYPE_LABELS[type] ?? titleCase(type)}
              </button>
            ))}
          </div>
          {(typeFilter !== 'ALL' || clientFilter !== 'ALL' || search) ? (
            <Button size="small" onClick={() => { setTypeFilter('ALL'); setClientFilter('ALL'); setSearch(''); }}>Clear filters</Button>
          ) : null}
        </div>

        {data.status === 'FAILED' ? (
          <Alert type="error" showIcon message="Intelligence extraction failed" description="The canonical transcript remains available. The durable job can be retried without duplicating the public record." />
        ) : null}
        {data.status === 'DEGRADED' ? (
          <Alert type="warning" showIcon message="Some intelligence jobs need attention" description="Available findings remain usable and evidence-bound; failed batches stay visible in queue health." />
        ) : null}
        {!filtered.length ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              data.summary.total
                ? 'No persisted finding matches these filters.'
                : 'Final transcript segments have not produced a source-grounded finding yet.'
            }
          />
        ) : (
          <div className="lh8-insight-list">{filtered.map((item) => <InsightCard key={item.id} insight={item} />)}</div>
        )}
      </section>

      <footer className="lh8-rail__footer">
        <span>{data.disclaimer}</span>
        <small>
          Public jobs: {Object.entries(data.jobs.public).map(([status, count]) => `${status} ${count}`).join(' · ') || 'none'}<br />
          Tenant jobs: {Object.entries(data.jobs.tenant).map(([status, count]) => `${status} ${count}`).join(' · ') || 'none'}
        </small>
      </footer>
    </aside>
  );
}

/**
 * Phase 8 composes rather than replaces the validated Phase 7 product. Calendar,
 * committee rooms, scheduling, browser fallback and transcript behavior stay on
 * the exact Phase 7 surface; only an event room receives the new intelligence rail.
 */
export function LiveHearingsPhase8Surface() {
  const [searchParams] = useSearchParams();
  const hearingView = searchParams.get('hearingView') ?? 'calendar';
  const hearingId = searchParams.get('event') ?? '';
  const showRail = hearingView === 'event' && Boolean(hearingId);

  return (
    <div className={`lh8-layout${showRail ? ' is-event' : ''}`}>
      <div className="lh8-layout__product"><LiveHearingsPhase7Surface /></div>
      {showRail ? <IntelligenceRail hearingId={hearingId} /> : null}
    </div>
  );
}

export default LiveHearingsPhase8Surface;
