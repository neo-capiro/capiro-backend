import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  DatePicker,
  Drawer,
  Empty,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  notification,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AlertOutlined } from '@ant-design/icons';
import { useApi } from '../../lib/use-api.js';
import type {
  IntelligenceChange,
  PortfolioAlertsResponse,
} from './types.js';
import { PORTFOLIO_ALERT_CATEGORY_LABELS } from './types.js';

const { Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

const SEVERITY_COLOR: Record<string, string> = {
  info: 'blue',
  notable: 'gold',
  critical: 'red',
};

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function ChangesInboxPage() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [notifApi, contextHolder] = notification.useNotification();

  const [selectedSource, setSelectedSource] = useState<string | undefined>();
  const [selectedSeverity, setSelectedSeverity] = useState<string | undefined>();
  const [dateRange, setDateRange] = useState<[string | null, string | null]>([null, null]);
  const [drawerRecord, setDrawerRecord] = useState<IntelligenceChange | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  const changesQuery = useQuery<IntelligenceChange[]>({
    queryKey: ['intel-changes-inbox', selectedSource, selectedSeverity, dateRange],
    queryFn: async () =>
      (
        await api.get<IntelligenceChange[]>('/api/intelligence/changes', {
          params: {
            // Inbox semantics: only show changes the user hasn't cleared. A
            // mark-read PATCH persists consumed=true, so cleared rows stay gone
            // across reloads instead of resurfacing.
            consumed: false,
            ...(selectedSource ? { source: selectedSource } : {}),
            ...(dateRange[0] ? { since: dateRange[0] } : {}),
          },
        })
      ).data,
    staleTime: 2 * 60 * 1000,
  });

  // Cross-client alert roll-up — same taxonomy as the client Intelligence tab
  // Top Alerts and the dashboard Needs-Attention banner. These are
  // compute-on-read alerts (NOT intelligence_change rows), so we merge them
  // into the inbox as synthetic rows and expose their categories as source
  // filters. Keeps the inbox in lockstep with the other two surfaces.
  // No try/catch: a caught failure here used to silently drop out of the merge
  // below, so a real outage rendered identically to "no portfolio alerts" —
  // and if changesQuery's own rows were also empty, the table's "No changes
  // found" text asserted a specific, wrong claim. `.isError` lets that text
  // distinguish the two.
  const portfolioAlertsQuery = useQuery<PortfolioAlertsResponse>({
    queryKey: ['portfolio-alerts-inbox'],
    queryFn: async () =>
      (
        await api.get<PortfolioAlertsResponse>('/api/intelligence/portfolio-alerts', {
          params: { limit: 50 },
        })
      ).data,
    staleTime: 2 * 60 * 1000,
  });

  const markReadMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.patch(`/api/intelligence/changes/${id}`, { consumed: true });
    },
    // Optimistically flag the row read so the UI responds instantly, but treat
    // the server PATCH as the source of truth: roll the optimistic flag back on
    // failure and tell the user, so "I cleared it but it came back" can never be
    // a silent lie. The persisted `consumed` column is what survives reloads.
    onMutate: (id: string) => {
      setReadIds((prev) => new Set([...prev, id]));
      return { id };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['intel-changes-inbox'] });
      void qc.invalidateQueries({ queryKey: ['intel-changes-unread'] });
    },
    onError: (_err, _id, context) => {
      if (context?.id) {
        setReadIds((prev) => {
          const next = new Set(prev);
          next.delete(context.id);
          return next;
        });
      }
      notifApi.error({
        message: "Couldn't mark as read",
        description: 'The change was reopened. Check your connection and try again.',
      });
    },
  });

  // Convert the cross-client portfolio alerts into inbox rows so the inbox
  // reflects the SAME alert categories as the dashboard + client tab. These are
  // synthetic (compute-on-read) rows: the `source` is the alert category so the
  // existing Source filter works, and `consumed` is left undefined (they can't
  // be persistently cleared like real change rows, but they age out on their
  // own as the underlying signal expires).
  const portfolioAlertRows = useMemo<IntelligenceChange[]>(() => {
    const alerts = portfolioAlertsQuery.data?.alerts ?? [];
    return alerts.map((a) => ({
      id: `pa-${a.id}`,
      source: a.type,
      changeType: a.type,
      severity: a.severity === 'critical' || a.severity === 'notable' ? a.severity : 'info',
      title: a.title,
      description: [a.clientName, a.subtitle, a.countdownLabel].filter(Boolean).join(' · '),
      relatedClientIds: a.clientId ? [a.clientId] : [],
      relatedIssues: [],
      data: { portfolioAlert: true, href: a.href ?? null, clientName: a.clientName },
      detectedAt: a.when || new Date().toISOString(),
      consumed: false,
    }));
  }, [portfolioAlertsQuery.data]);

  const allChanges = useMemo(
    () => [...(changesQuery.data ?? []), ...portfolioAlertRows],
    [changesQuery.data, portfolioAlertRows],
  );

  const filteredChanges = useMemo(() => {
    let data = allChanges;
    if (selectedSource) data = data.filter((c) => c.source === selectedSource);
    if (selectedSeverity) data = data.filter((c) => c.severity === selectedSeverity);
    if (dateRange[1]) {
      const end = new Date(dateRange[1]).getTime();
      data = data.filter((c) => new Date(c.detectedAt).getTime() <= end);
    }
    return [...data].sort(
      (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
    );
  }, [allChanges, selectedSource, selectedSeverity, dateRange]);

  const distinctSources = useMemo(() => {
    // Always offer the portfolio-alert categories as filter options (even when
    // none are currently present) so the inbox advertises the full taxonomy,
    // then union with whatever sources the live change/alert rows carry.
    const curated = Object.keys(PORTFOLIO_ALERT_CATEGORY_LABELS);
    return [...new Set([...curated, ...allChanges.map((c) => c.source)])].sort();
  }, [allChanges]);

  const unreadCount = filteredChanges.filter(
    (c) => !readIds.has(c.id) && !(c as IntelligenceChange & { consumed?: boolean }).consumed,
  ).length;

  function handleRowClick(record: IntelligenceChange) {
    // Synthetic portfolio-alert rows (compute-on-read) aren't persisted change
    // rows: don't PATCH mark-read (the id has no DB row). Navigate to the
    // alert's deep link when present, otherwise just open the drawer.
    const isPortfolioAlert = record.id.startsWith('pa-');
    if (isPortfolioAlert) {
      const href = (record.data as { href?: string | null } | undefined)?.href;
      if (href) {
        navigate(href);
        return;
      }
      setDrawerRecord(record);
      return;
    }
    setDrawerRecord(record);
    if (!readIds.has(record.id)) {
      markReadMutation.mutate(record.id);
    }
  }

  function handleResolveAll() {
    notifApi.info({ message: 'Use the Intelligence Mappings page to resolve entity mappings.' });
  }

  const columns: ColumnsType<IntelligenceChange> = [
    {
      title: 'Severity',
      dataIndex: 'severity',
      width: 100,
      render: (sev: string) => (
        <Tag color={SEVERITY_COLOR[sev] ?? 'default'} style={{ textTransform: 'capitalize' }}>
          {sev}
        </Tag>
      ),
    },
    {
      title: 'Source',
      dataIndex: 'source',
      width: 140,
      render: (src: string) => <Tag>{PORTFOLIO_ALERT_CATEGORY_LABELS[src] ?? src}</Tag>,
    },
    {
      title: 'Title',
      dataIndex: 'title',
      render: (title: string, record) => {
        const isRead =
          readIds.has(record.id) ||
          (record as IntelligenceChange & { consumed?: boolean }).consumed;
        return (
          <Text strong={!isRead} style={{ color: isRead ? '#8c8c8c' : undefined }}>
            {title}
          </Text>
        );
      },
    },
    {
      title: 'Description',
      dataIndex: 'description',
      ellipsis: true,
      render: (desc: string) => (
        <Tooltip title={desc}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            {desc.length > 120 ? desc.slice(0, 120) + '…' : desc}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: 'Detected',
      dataIndex: 'detectedAt',
      width: 130,
      render: (dt: string) => (
        <Tooltip title={new Date(dt).toLocaleString()}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {relativeTime(dt)}
          </Text>
        </Tooltip>
      ),
    },
  ];

  return (
    <div
      className="redesign"
      style={{ padding: '24px 32px', overflow: 'auto', height: '100%', background: 'var(--bg-canvas)' }}
    >
      {contextHolder}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <AlertOutlined style={{ fontSize: 22, color: '#faad14' }} />
        <Typography.Title level={4} style={{ margin: 0 }}>
          Changes Inbox
        </Typography.Title>
        <Badge count={unreadCount} overflowCount={99} />
        <span style={{ flex: 1 }} />
        <Button size="small" type="default" onClick={handleResolveAll}>
          Resolve All Clients
        </Button>
      </div>

      {/* Filter bar */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            allowClear
            mode="multiple"
            placeholder="Source"
            style={{ minWidth: 200 }}
            value={selectedSource ? [selectedSource] : []}
            onChange={(vals: string[]) => setSelectedSource(vals[0])}
            options={distinctSources.map((s) => ({
              label: PORTFOLIO_ALERT_CATEGORY_LABELS[s] ?? s,
              value: s,
            }))}
          />
          <Select
            allowClear
            placeholder="Severity"
            style={{ width: 140 }}
            value={selectedSeverity}
            onChange={(v) => setSelectedSeverity(v ?? undefined)}
            options={[
              { label: 'All', value: '' },
              { label: 'Info', value: 'info' },
              { label: 'Notable', value: 'notable' },
              { label: 'Critical', value: 'critical' },
            ]}
          />
          <RangePicker
            onChange={(_, strs) => setDateRange([strs[0] || null, strs[1] || null])}
          />
        </Space>
      </Card>

      <Table<IntelligenceChange>
        rowKey="id"
        dataSource={filteredChanges}
        columns={columns}
        loading={changesQuery.isLoading}
        pagination={{ pageSize: 25, showSizeChanger: false }}
        onRow={(record) => ({ onClick: () => handleRowClick(record), style: { cursor: 'pointer' } })}
        locale={{
          emptyText: (
            <Empty
              description={
                changesQuery.isError || portfolioAlertsQuery.isError
                  ? "Couldn't load some sources — this list may be incomplete. Try refreshing."
                  : 'No changes found'
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ),
        }}
        rowClassName={(record) => {
          const isRead =
            readIds.has(record.id) ||
            (record as IntelligenceChange & { consumed?: boolean }).consumed;
          return isRead ? 'changes-inbox-row--read' : '';
        }}
      />

      <Drawer
        title={drawerRecord?.title ?? 'Change Detail'}
        open={!!drawerRecord}
        onClose={() => setDrawerRecord(null)}
        width={520}
        extra={
          drawerRecord && (
            <Tag color={SEVERITY_COLOR[drawerRecord.severity] ?? 'default'} style={{ textTransform: 'capitalize' }}>
              {drawerRecord.severity}
            </Tag>
          )
        }
      >
        {drawerRecord && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Source</Text>
              <div><Tag>{drawerRecord.source}</Tag></div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Detected</Text>
              <div>
                <Text>{new Date(drawerRecord.detectedAt).toLocaleString()}</Text>
              </div>
            </div>
            {drawerRecord.relatedIssues.length > 0 && (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>Related Issues</Text>
                <div style={{ marginTop: 4 }}>
                  {drawerRecord.relatedIssues.map((iss) => (
                    <Tag key={iss} style={{ marginBottom: 4 }}>{iss}</Tag>
                  ))}
                </div>
              </div>
            )}
            {Array.isArray((drawerRecord as IntelligenceChange & { relatedPeCodes?: string[] }).relatedPeCodes) &&
              ((drawerRecord as IntelligenceChange & { relatedPeCodes?: string[] }).relatedPeCodes?.length ?? 0) > 0 && (
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>Program Elements</Text>
                  <div style={{ marginTop: 4 }}>
                    {(drawerRecord as IntelligenceChange & { relatedPeCodes?: string[] }).relatedPeCodes?.map((peCode) => (
                      <Tag
                        key={peCode}
                        color="blue"
                        role="button"
                        style={{ cursor: 'pointer', marginBottom: 4 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/program-elements/${encodeURIComponent(peCode)}`);
                        }}
                      >
                        PE {peCode}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Description</Text>
              <Paragraph style={{ marginTop: 4, fontSize: 13 }}>{drawerRecord.description}</Paragraph>
            </div>
            {Object.keys(drawerRecord.data).length > 0 && (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>Raw Data</Text>
                <pre
                  style={{
                    marginTop: 4,
                    padding: 12,
                    background: '#f5f5f5',
                    borderRadius: 4,
                    fontSize: 11,
                    overflow: 'auto',
                    maxHeight: 320,
                  }}
                >
                  {JSON.stringify(drawerRecord.data, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
