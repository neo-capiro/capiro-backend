/**
 * Presentational AI usage panels (spend cards, by-day trend, workflow/model
 * breakdowns). Shared by the tenant Settings → AI Usage page and the
 * capiro-admin per-tenant drill-down — both feed it the same summary shape
 * from their respective endpoints. Costs are ESTIMATES from the
 * hand-maintained pricing table, and every label says so.
 */
import { Card, Col, Empty, Row, Skeleton, Statistic, Table, Typography } from 'antd';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// Types + formatters extracted to usage-summary-shared.ts (UI-free) so the
// vNext Settings module shares them. Re-exported here so existing importers
// (AiUsagePage, AiKeysAdminPanel) keep working unchanged.
export {
  fmtTokens,
  fmtUsd,
  type MaskedAiCredential,
  type TenantUsageSummary,
  type UsageBucket,
} from './usage-summary-shared.js';
import { fmtTokens, fmtUsd, type TenantUsageSummary, type UsageBucket } from './usage-summary-shared.js';

export function UsageSummaryPanels({
  summary,
  loading,
}: {
  summary?: TenantUsageSummary;
  loading?: boolean;
}) {
  if (loading || !summary) {
    return <Skeleton active paragraph={{ rows: 6 }} />;
  }

  const totalTokens = summary.totalInputTokens + summary.totalOutputTokens;
  const breakdownColumns = (keyLabel: string, keyField: 'workflow' | 'model') => [
    { title: keyLabel, dataIndex: keyField, key: keyField, ellipsis: true },
    {
      title: 'Est. cost',
      dataIndex: 'costUsd',
      key: 'costUsd',
      align: 'right' as const,
      render: (v: number) => fmtUsd(v),
    },
    {
      title: 'Tokens',
      key: 'tokens',
      align: 'right' as const,
      render: (_: unknown, row: UsageBucket) => fmtTokens(row.inputTokens + row.outputTokens),
    },
    { title: 'Runs', dataIndex: 'count', key: 'count', align: 'right' as const },
  ];

  return (
    <>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic title="Estimated spend" value={fmtUsd(summary.totalCostUsd)} />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic title="Tokens" value={fmtTokens(totalTokens)} />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic title="Generations" value={summary.eventCount} />
            {summary.tenantKeyEventCount > 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {summary.tenantKeyEventCount} billed to your own key
              </Typography.Text>
            ) : null}
          </Card>
        </Col>
      </Row>

      <Card size="small" title="Estimated cost by day" style={{ marginTop: 16 }}>
        {summary.byDay.length ? (
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={summary.byDay} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis
                  tickFormatter={(v: number) => fmtUsd(v)}
                  tick={{ fontSize: 11 }}
                  width={70}
                />
                <Tooltip formatter={(v) => fmtUsd(Number(v))} />
                <Line
                  type="monotone"
                  dataKey="costUsd"
                  name="Est. cost"
                  dot={false}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No AI usage in this period" />
        )}
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={12}>
          <Card size="small" title="By workflow">
            <Table
              size="small"
              rowKey="workflow"
              pagination={false}
              columns={breakdownColumns('Workflow', 'workflow')}
              dataSource={summary.byWorkflow}
              locale={{ emptyText: 'No usage yet' }}
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title="By model">
            <Table
              size="small"
              rowKey="model"
              pagination={false}
              columns={breakdownColumns('Model', 'model')}
              dataSource={summary.byModel}
              locale={{ emptyText: 'No usage yet' }}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}
