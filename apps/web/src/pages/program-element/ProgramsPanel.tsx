import { Card, Empty, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type {
  PeProgramMatchRow,
  ProgramConfidenceBand,
  ProgramEvidenceItem,
  ProgramsForPeResponse,
} from './programs-api.js';
import { PeSecondaryFailed } from './PeSecondaryFailed.js';

const { Text, Paragraph } = Typography;

export interface ProgramsPanelProps {
  programs: ProgramsForPeResponse | null | undefined;
  loading?: boolean;

  errored?: boolean;
  onRetry?: () => void;
}

const BAND_COLOR: Record<ProgramConfidenceBand, string> = {
  high: 'green',
  medium: 'gold',
  low: 'orange',
  weak: 'default',
};

const BAND_LABEL: Record<ProgramConfidenceBand, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  weak: 'Weak signal',
};

/** Confidence band → colored tag. */
function bandTag(band: ProgramConfidenceBand) {
  return <Tag color={BAND_COLOR[band] ?? 'default'}>{BAND_LABEL[band] ?? band}</Tag>;
}

/** Open-at-page deep link for an evidence item ({ sourceUrl, pageNumber }). */
function evidenceHref(item: ProgramEvidenceItem): string | null {
  if (!item.sourceUrl) return null;
  return item.pageNumber ? `${item.sourceUrl}#page=${item.pageNumber}` : item.sourceUrl;
}

/** Render the source-evidence links for a match (deduped, deep-linked). */
function EvidenceLinks({ evidence }: { evidence: ProgramEvidenceItem[] }) {
  const linked = (Array.isArray(evidence) ? evidence : []).filter((e) => e.sourceUrl);
  if (linked.length === 0) return <Text type="secondary">—</Text>;
  return (
    <Space size={[4, 4]} wrap>
      {linked.map((e, i) => {
        const href = evidenceHref(e);
        const label = `${e.kind ?? 'source'}${e.pageNumber ? ` p.${e.pageNumber}` : ''}`;
        return href ? (
          <a key={`${href}-${i}`} href={href} target="_blank" rel="noreferrer">
            <Tooltip title={e.quote ?? e.sourceUrl}>
              <Tag color="green">{label}</Tag>
            </Tooltip>
          </a>
        ) : (
          <Tag key={`${label}-${i}`}>{label}</Tag>
        );
      })}
    </Space>
  );
}

function formatReviewed(value: string | null): string {
  if (!value) return 'Not yet reviewed';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Not yet reviewed';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildColumns(showCandidateBadge: boolean): ColumnsType<PeProgramMatchRow> {
  return [
    {
      title: 'Program',
      key: 'program',
      render: (_v, r) => (
        <div>
          <Text strong>{r.program?.canonicalName ?? '(unknown program)'}</Text>
          {showCandidateBadge ? (
            <Tag color="gold" style={{ marginLeft: 8 }}>
              Candidate — requires review
            </Tag>
          ) : null}
          <div style={{ fontSize: 12, color: '#888' }}>
            {[r.program?.mdapCode ? `MDAP ${r.program.mdapCode}` : null, r.program?.component]
              .filter(Boolean)
              .join(' · ') || '—'}
          </div>
        </div>
      ),
    },
    {
      title: 'Confidence',
      key: 'confidence',
      width: 150,
      render: (_v, r) => bandTag(r.confidenceBand),
    },
    {
      title: 'Why shown',
      key: 'whyShown',
      render: (_v, r) => (r.whyShown ? <Text>{r.whyShown}</Text> : <Text type="secondary">—</Text>),
    },
    {
      title: 'Evidence',
      key: 'evidence',
      width: 220,
      render: (_v, r) => <EvidenceLinks evidence={r.evidence} />,
    },
    {
      title: 'Status',
      key: 'status',
      width: 130,
      render: (_v, r) => (
        <div>
          <Tag color={r.status === 'accepted' ? 'green' : 'gold'}>{r.status}</Tag>
          <div style={{ fontSize: 11, color: '#999' }}>{formatReviewed(r.resolvedAt)}</div>
        </div>
      ),
    },
  ];
}

/**
 * Step 2.1 — PE profile "Programs" panel. Renders ACCEPTED PE→Program matches (program
 * name, confidence band, why-shown evidence line, source evidence links, status badge,
 * last reviewed) and CANDIDATE matches only behind a "Candidate — requires review" badge.
 * Quarantined / rejected / weak-signal matches are never returned by the API, so they are
 * never shown here. Guards against non-array data with Array.isArray. Honest empty state.
 */
export function ProgramsPanel({ programs, loading = false,
  errored = false,
  onRetry,
}: ProgramsPanelProps) {
  if (loading) {
    return (
      <Card title="Programs">
        <Skeleton active paragraph={{ rows: 3 }} />
      </Card>
    );
  }

  if (errored) {
    return (
      <PeSecondaryFailed label="programs" testId="pe-secondary-failed-programs" onRetry={onRetry} />
    );
  }


  const accepted = Array.isArray(programs?.acceptedMatches) ? programs!.acceptedMatches : [];
  const candidates = Array.isArray(programs?.candidateMatches) ? programs!.candidateMatches : [];

  if (accepted.length === 0 && candidates.length === 0) {
    return (
      <Card className="pe-programs-card" title="Programs">
        <Empty description="No programs linked to this Program Element yet. Matches appear here once the Program graph links this PE — accepted links show directly; proposed links wait for review." />
      </Card>
    );
  }

  return (
    <Card className="pe-programs-card" title={`Programs · ${accepted.length}`}>
      <Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
        Programs this Program Element rolls up to in the Capiro Program graph. Each row shows why
        the match was made, the source evidence, and the review status. Source chips open the exact
        exhibit page.
      </Paragraph>

      {accepted.length > 0 ? (
        <div className="pe-scroll-table">
          <Table<PeProgramMatchRow>
            rowKey="id"
            size="small"
            pagination={false}
            columns={buildColumns(false)}
            dataSource={accepted}
          />
        </div>
      ) : (
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          No accepted program links yet — see proposed candidates below.
        </Text>
      )}

      {candidates.length > 0 ? (
        <div style={{ marginTop: accepted.length > 0 ? 20 : 0 }}>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>
            Proposed candidates (awaiting review)
          </Text>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            Machine-proposed links that a reviewer has not yet confirmed. Shown for transparency —
            they are not treated as established until accepted in the review queue.
          </Text>
          <div className="pe-scroll-table">
            <Table<PeProgramMatchRow>
              rowKey="id"
              size="small"
              pagination={false}
              columns={buildColumns(true)}
              dataSource={candidates}
            />
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export default ProgramsPanel;
