import { Card, Empty, Segmented, Skeleton, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import type { ProcurementLinesResponse, ProcurementLineRecipient } from './types.js';
import { PeSecondaryFailed } from './PeSecondaryFailed.js';

const { Text } = Typography;

export interface SecondaryDistributionPanelProps {
  data: ProcurementLinesResponse | null | undefined;
  loading?: boolean;
  /** Request failed — must not paint honesty Empty. */
  errored?: boolean;
  onRetry?: () => void;
}

/** Compact USD: $1.59M / $2.04B from a full-dollar value. */
export function fmtDollars(v: number | null): string {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function fmtQty(v: number | null): string {
  if (v == null) return '—';
  return v.toLocaleString('en-US');
}

interface RecipientRow {
  key: string;
  recipient: string;
  byFy: Record<number, { quantity: number | null; dollars: number | null }>;
}

/**
 * P-40 Secondary Distribution — per-recipient (Army/ANG/AR/…) quantity +
 * obligation authority across fiscal years. Toggle between quantity and dollars.
 * Honest empty state for PEs with no procurement lines (RDT&E, or PROC books
 * without a Secondary Distribution block).
 */
export function SecondaryDistributionPanel({
  data,
  loading = false,
  errored = false,
  onRetry,
}: SecondaryDistributionPanelProps) {
  const [metric, setMetric] = useState<'quantity' | 'dollars'>('dollars');

  if (loading) {
    return (
      <Card title="Secondary Distribution">
        <Skeleton active paragraph={{ rows: 3 }} />
      </Card>
    );
  }

  if (errored) {
    return (
      <Card className="pe-sd-card" title="Secondary Distribution">
        <PeSecondaryFailed
          label="secondary distribution"
          testId="pe-secondary-failed-procurement-lines"
          onRetry={onRetry}
        />
      </Card>
    );
  }

  const recipients: ProcurementLineRecipient[] = data?.recipients ?? [];
  const years = data?.years ?? [];
  if (recipients.length === 0 || years.length === 0) {
    return (
      <Card className="pe-sd-card" title="Secondary Distribution">
        <Empty description="No per-recipient procurement breakdown for this PE — it may be RDT&E, or its procurement book had no Secondary Distribution block." />
      </Card>
    );
  }

  const rows: RecipientRow[] = recipients.map((r) => {
    const byFy: RecipientRow['byFy'] = {};
    for (const fr of r.fyRows) byFy[fr.fy] = { quantity: fr.quantity, dollars: fr.dollars };
    return { key: r.recipient, recipient: r.recipient, byFy };
  });

  const columns: ColumnsType<RecipientRow> = [
    {
      title: 'Recipient',
      dataIndex: 'recipient',
      key: 'recipient',
      fixed: 'left',
      width: 120,
      render: (v: string) => <Text strong>{v}</Text>,
    },
    ...years.map((y) => ({
      title: <Tag>FY{String(y).slice(-2)}</Tag>,
      key: `fy${y}`,
      align: 'right' as const,
      render: (_v: unknown, row: RecipientRow) => {
        const cell = row.byFy[y];
        if (!cell) return <Text type="secondary">—</Text>;
        const val = metric === 'dollars' ? fmtDollars(cell.dollars) : fmtQty(cell.quantity);
        return <span>{val}</span>;
      },
    })),
  ];

  const sourceHref = data?.sourceUrl ?? null;

  return (
    <Card
      className="pe-sd-card"
      title={`Secondary Distribution · ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`}
      extra={
        <Segmented
          size="small"
          value={metric}
          onChange={(v) => setMetric(v as 'quantity' | 'dollars')}
          options={[
            { label: 'Obligation $', value: 'dollars' },
            { label: 'Quantity', value: 'quantity' },
          ]}
        />
      }
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
        Per-recipient {metric === 'dollars' ? 'obligation authority' : 'procurement quantity'} from
        the P-40 Secondary Distribution block, by fiscal year (request year + prior actuals + FYDP).
        {sourceHref ? (
          <>
            {' '}
            <a href={sourceHref} target="_blank" rel="noreferrer">
              Source (P-40)
            </a>
          </>
        ) : null}
      </Text>
      <Table<RecipientRow>
        rowKey="key"
        size="small"
        pagination={false}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 'max-content' }}
      />
    </Card>
  );
}

export default SecondaryDistributionPanel;
