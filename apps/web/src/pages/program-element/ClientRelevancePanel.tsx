import { Card, Empty, Skeleton, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { RelevanceEvidence } from '../clients/RelevanceEvidence.js';
import {
  formatScorePct,
  scoreBandColor,
  type RelevantClientRow,
} from '../clients/relevance-api.js';
import { PeSecondaryFailed } from './PeSecondaryFailed.js';

const { Text, Paragraph } = Typography;

export interface ClientRelevancePanelProps {
  /** Tenant clients relevant to this PE (already filtered to minScore by the API). */
  clients: RelevantClientRow[] | null | undefined;
  loading?: boolean;

  errored?: boolean;
  onRetry?: () => void;
}

function buildColumns(): ColumnsType<RelevantClientRow> {
  return [
    {
      title: 'Client',
      key: 'client',
      render: (_v, r) => <Text strong>{r.clientName || '(unnamed client)'}</Text>,
    },
    {
      title: 'Score',
      key: 'score',
      width: 110,
      render: (_v, r) => (
        <Tooltip title="Combined relevance score across all evidence paths">
          <Tag color={scoreBandColor(r.score)}>{formatScorePct(r.score)}</Tag>
        </Tooltip>
      ),
    },
    {
      title: 'Why relevant',
      key: 'evidence',
      render: (_v, r) => <RelevanceEvidence paths={r.paths} />,
    },
  ];
}

/**
 * Step 2.3 — PE profile "Client relevance" panel.
 *
 * Lists the caller's tenant clients that are relevant to this Program Element (score >= the API
 * floor, default 0.5), each with a score badge and the per-path evidence chips that explain WHY.
 * Honest empty state when no client clears the floor. Guards against non-array / malformed data
 * with Array.isArray so an error payload never throws.
 */
export function ClientRelevancePanel({ clients, loading = false,
  errored = false,
  onRetry,
}: ClientRelevancePanelProps) {
  if (loading) {
    return (
      <Card title="Client relevance">
        <Skeleton active paragraph={{ rows: 3 }} />
      </Card>
    );
  }

  if (errored) {
    return (
      <PeSecondaryFailed label="client relevance" testId="pe-secondary-failed-client-relevance" onRetry={onRetry} />
    );
  }


  const rows = Array.isArray(clients) ? clients.filter((c) => c && typeof c.clientId === 'string') : [];

  if (rows.length === 0) {
    return (
      <Card className="pe-client-relevance-card" title="Client relevance">
        <Empty description="No clients in your portfolio clear the relevance floor for this Program Element yet. Relevance is explained by capability PE numbers/keywords, prior awards, facility districts, or ecosystem ties." />
      </Card>
    );
  }

  return (
    <Card className="pe-client-relevance-card" title={`Client relevance · ${rows.length}`}>
      <Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
        Your portfolio clients relevant to this Program Element, scored across multiple evidence
        paths. Each chip shows the path and its score; hover a chip to see the supporting evidence.
      </Paragraph>
      <div className="pe-scroll-table">
        <Table<RelevantClientRow>
          rowKey="clientId"
          size="small"
          pagination={false}
          columns={buildColumns()}
          dataSource={rows}
        />
      </div>
    </Card>
  );
}

export default ClientRelevancePanel;
