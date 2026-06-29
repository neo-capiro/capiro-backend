import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Card,
  Empty,
  Input,
  Skeleton,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  FireOutlined,
  RiseOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useApi } from '../../../lib/use-api.js';
import { HBar, Sparkline } from '../../../components/charts.js';
import type { LobbyIntelSummary, LobbyOverview } from '../types.js';
import { formatMoney, surgeBadge, trajectoryTag } from '../utils.js';

const { Text, Paragraph } = Typography;

export function LobbyingPanel() {
  const api = useApi();
  const [search, setSearch] = useState('');

  const overview = useQuery<LobbyOverview>({
    queryKey: ['lobby-intel-overview'],
    queryFn: async () => (await api.get<LobbyOverview>('/api/lobby-intel/overview')).data,
    staleTime: 5 * 60 * 1000,
  });

  const searchResults = useQuery<LobbyIntelSummary[]>({
    queryKey: ['lobby-intel-search', search],
    queryFn: async () =>
      (await api.get<LobbyIntelSummary[]>('/api/lobby-intel/search', { params: { q: search } })).data,
    enabled: search.trim().length >= 2,
    staleTime: 30 * 1000,
  });

  const maxTopSpend = useMemo(() => Math.max(1, ...(overview.data?.topSpenders.map((s) => s.totalSpending ?? 0) ?? [])), [overview.data]);
  const maxIssueSpend = useMemo(() => Math.max(1, ...(overview.data?.hotIssues.map((s) => s.totalSpending ?? 0) ?? [])), [overview.data]);
  const data = overview.data;
  const isEmpty = !overview.isLoading && data && data.totalClients === 0;
  // Total federal lobbying $ tracked across surfaced top spenders (LDA-derived).
  // Now reflects actual aggregate from raw filings, not openlobby's pre-bucketed sum.
  const totalTrackedSpend = useMemo(
    () => (data?.topSpenders ?? []).reduce((sum, s) => sum + (s.totalSpending ?? 0), 0),
    [data],
  );

  return (
    <div>
      {overview.isError ? <Alert type="error" message="Could not load federal lobbying intelligence" description={(overview.error as Error)?.message} style={{ marginBottom: 16 }} /> : null}
      {isEmpty ? <Alert type="info" showIcon message="No data yet" description={<span>Run <Text code>pnpm --filter @capiro/api sync:openlobby</Text> to populate.</span>} style={{ marginBottom: 24 }} /> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Card size="small">
          <Statistic title="Tracked Clients" value={data?.totalClients ?? 0} loading={overview.isLoading} valueStyle={{ fontSize: 22 }} />
          <Text type="secondary" style={{ fontSize: 11 }}>of ~45.5K federal lobbying universe</Text>
        </Card>
        <Card size="small"><Statistic title="Total $ Tracked" value={totalTrackedSpend} loading={overview.isLoading} formatter={(v) => formatMoney(v as number)} valueStyle={{ fontSize: 22, color: '#2563eb' }} /></Card>
        <Card size="small"><Statistic title="Surging Issues" value={data?.surgingIssues.length ?? 0} loading={overview.isLoading} valueStyle={{ fontSize: 22, color: '#ef4444' }} prefix={<RiseOutlined />} /></Card>
        <Card size="small"><Statistic title="Exploding Clients" value={data?.exploding.length ?? 0} loading={overview.isLoading} valueStyle={{ fontSize: 22, color: '#f59e0b' }} prefix={<ThunderboltOutlined />} /></Card>
        <Card size="small"><Statistic title="Trending Terms" value={data?.trendingTopics.length ?? 0} loading={overview.isLoading} valueStyle={{ fontSize: 22 }} /></Card>
      </div>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Input.Search placeholder="Search 5,000+ federal lobbying clients by name…" allowClear enterButton size="middle" onChange={(e) => setSearch(e.target.value)} value={search} />
        {search.trim().length >= 2 ? (
          <div style={{ marginTop: 12 }}>
            {searchResults.isLoading ? <Spin /> : searchResults.data && searchResults.data.length > 0 ? (
              <Table size="small" rowKey="id" dataSource={searchResults.data} pagination={false}
                columns={[
                  { title: 'Client', dataIndex: 'name', render: (n: string, r: LobbyIntelSummary) => <Space><Text strong>{n}</Text>{trajectoryTag(r.trajectory)}</Space> },
                  { title: 'State', dataIndex: 'state', width: 70, render: (s: string | null) => s ?? '-' },
                  { title: 'Total Spend', dataIndex: 'totalSpending', width: 130, align: 'right', render: (v: number | null) => formatMoney(v) },
                  { title: 'Trajectory', dataIndex: 'yearlySpend', width: 180, render: (ys: { year: number; amount: number }[]) => <Sparkline data={ys ?? []} width={150} height={28} /> },
                  { title: 'Top LDA Issues', dataIndex: 'issues', render: (i: string[]) => <Space size={[2, 4]} wrap>{(i ?? []).slice(0, 6).map((c) => <Tag key={c} style={{ marginRight: 0, fontSize: 11 }}>{c}</Tag>)}{i && i.length > 6 ? <Text type="secondary" style={{ fontSize: 11 }}>+{i.length - 6}</Text> : null}</Space> },
                ]}
              />
            ) : <Empty description="No matches" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </div>
        ) : null}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1.4fr) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card size="small" title={<Space><FireOutlined style={{ color: '#ef4444' }} /><span>Surging LDA Issues (latest quarter)</span></Space>} extra={data?.surgingIssues[0]?.latestQuarter ? <Text type="secondary" style={{ fontSize: 12 }}>vs prior year • {data.surgingIssues[0].latestQuarter}</Text> : null}>
            {overview.isLoading ? <Skeleton active /> : data && data.surgingIssues.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.surgingIssues.map((iss) => (
                  <div key={iss.code} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 110px 90px', alignItems: 'center', gap: 12, padding: '8px 4px', borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                    <Tag color="default" style={{ margin: 0 }}>{iss.code}</Tag>
                    <Text>{iss.name}</Text>
                    <Text type="secondary" style={{ fontSize: 12, textAlign: 'right' }}>{formatMoney(iss.latestIncome)} /Q</Text>
                    <div style={{ textAlign: 'right' }}>{surgeBadge(iss.surgeTrend, iss.surgePct)}</div>
                  </div>
                ))}
              </div>
            ) : <Empty description="No surge data yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </Card>

          <Card size="small" title="Top Federal Lobbying Spenders" extra={<Text type="secondary" style={{ fontSize: 12 }}>2018–2025 • LDA-derived</Text>}>
            {overview.isLoading ? <Skeleton active /> : data && data.topSpenders.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 720, overflowY: 'auto' }}>
                {data.topSpenders.slice(0, 50).map((c, i) => (
                  <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '24px 1fr 140px 110px 60px', alignItems: 'center', gap: 10, padding: '6px 4px', borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                    <Text type="secondary" style={{ fontSize: 11 }}>{i + 1}</Text>
                    <Tooltip title={c.name}><Text ellipsis style={{ maxWidth: 360 }}>{c.name}</Text></Tooltip>
                    <HBar value={c.totalSpending ?? 0} max={maxTopSpend} width={140} />
                    <Text type="secondary" style={{ fontSize: 12, textAlign: 'right' }}>{formatMoney(c.totalSpending)}</Text>
                    <Sparkline data={c.yearlySpend ?? []} width={55} height={20} />
                  </div>
                ))}
              </div>
            ) : <Empty description="No data" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </Card>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card size="small" title="Hottest LDA Issues (cumulative)">
            {overview.isLoading ? <Skeleton active /> : data && data.hotIssues.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {data.hotIssues.map((iss) => (
                  <div key={iss.code} style={{ display: 'grid', gridTemplateColumns: '50px 1fr 80px 80px', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                    <Tag style={{ margin: 0 }}>{iss.code}</Tag>
                    <Tooltip title={iss.name}><Text ellipsis style={{ fontSize: 12 }}>{iss.name}</Text></Tooltip>
                    <HBar value={iss.totalSpending ?? 0} max={maxIssueSpend} width={80} />
                    <Text type="secondary" style={{ fontSize: 11, textAlign: 'right' }}>{formatMoney(iss.totalSpending)}</Text>
                  </div>
                ))}
              </div>
            ) : <Empty description="No data" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </Card>

          <Card size="small" title="Trending Terms in Filings" extra={<Text type="secondary" style={{ fontSize: 12 }}>AI-injected into drafts</Text>}>
            {overview.isLoading ? <Skeleton active /> : data && data.trendingTopics.length > 0 ? (
              <Space size={[6, 8]} wrap>
                {data.trendingTopics.slice(0, 30).map((t) => {
                  const grow = t.growthPct ?? 0;
                  const intensity = Math.min(1, Math.log10(Math.max(grow, 1)) / 4);
                  return (
                    <Tooltip key={t.word} title={t.growthPct != null ? `${Math.round(t.growthPct)}% growth vs prior years` : `${t.latestCount.toLocaleString()} mentions`}>
                      <Tag color="red" style={{ margin: 0, fontSize: 12 + intensity * 4, opacity: 0.6 + intensity * 0.4 }}>{t.word}</Tag>
                    </Tooltip>
                  );
                })}
              </Space>
            ) : <Empty description="No trending data" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </Card>

          <Card size="small" title="About this data">
            <Paragraph style={{ fontSize: 12, marginBottom: 6 }} type="secondary">
              Lobbying: derived directly from Senate <a href="https://lda.gov/" target="_blank" rel="noreferrer">LDA</a> filings (~512K records).
            </Paragraph>
            <Paragraph style={{ fontSize: 12, margin: 0 }} type="secondary">
              Contracting: <a href="https://www.openspending.us/" target="_blank" rel="noreferrer">OpenSpending</a> / <a href="https://www.usaspending.gov/" target="_blank" rel="noreferrer">USASpending.gov</a>.
            </Paragraph>
          </Card>
        </div>
      </div>
    </div>
  );
}
