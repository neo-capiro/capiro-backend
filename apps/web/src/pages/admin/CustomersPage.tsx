import { App, Button, Card, Popconfirm, Space, Statistic, Table, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BillingStatus } from '@capiro/shared';
import { useApi } from '../../lib/use-api.js';

interface CustomerRow {
  tenantId: string;
  slug: string;
  name: string;
  status: BillingStatus;
  slots: number;
  usedSlots: number;
  pricePerSlotUsd: number;
  mrrUsd: number;
  llmUsedUsd: number;
  llmOverageUsd: number;
  currentPeriodEnd: string | null;
  createdAt: string;
}

const STATUS_COLOR: Record<BillingStatus, string> = {
  none: 'default',
  trialing: 'blue',
  active: 'green',
  past_due: 'red',
  canceled: 'volcano',
  comped: 'gold',
};

interface ManagedImportRow {
  tenantId: string;
  name: string;
  slug: string;
  importStatus: 'none' | 'waiting' | 'verifying' | 'done';
  clientCount: number;
  createdAt: string;
}

const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/**
 * Capiro-admin "Customers" console: every tenant's billing posture, slot usage,
 * MRR and month-to-date AI spend, plus a comp toggle. Gated to capiro_admin in
 * SettingsLayout; every endpoint enforces RolesGuard server-side.
 */
export function CustomersPage() {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();

  const customers = useQuery<CustomerRow[]>({
    queryKey: ['admin', 'billing', 'customers'],
    queryFn: async () => (await api.get<CustomerRow[]>('/api/capiro-admin/billing/customers')).data,
  });

  const comp = useMutation({
    // Comp writes moved to onboard-api (the single billing writer, onboarding
    // v1) — same-origin path via the ALB /onboard-api/* rule.
    mutationFn: async (input: { tenantId: string; comped: boolean }) =>
      (
        await api.post(`/onboard-api/admin/billing/tenants/${input.tenantId}/comp`, {
          comped: input.comped,
        })
      ).data,
    onSuccess: () => {
      message.success('Updated');
      qc.invalidateQueries({ queryKey: ['admin', 'billing', 'customers'] });
    },
    onError: (err) => message.error((err as Error).message),
  });

  // Capiro-managed (white-glove) client imports awaiting completion.
  const managedImports = useQuery<ManagedImportRow[]>({
    queryKey: ['admin', 'managed-imports'],
    queryFn: async () =>
      (await api.get<ManagedImportRow[]>('/onboard-api/admin/setup/managed-imports')).data,
  });

  const markImportComplete = useMutation({
    mutationFn: async (tenantId: string) =>
      (await api.post(`/onboard-api/admin/setup/tenants/${tenantId}/mark-import-complete`)).data,
    onSuccess: () => {
      message.success('Client import marked complete');
      qc.invalidateQueries({ queryKey: ['admin', 'managed-imports'] });
    },
    onError: (err) => message.error((err as Error).message),
  });

  const rows = customers.data ?? [];
  const totalMrr = rows.reduce((sum, r) => sum + r.mrrUsd, 0);
  const totalOverage = rows.reduce((sum, r) => sum + r.llmOverageUsd, 0);
  const payingCount = rows.filter((r) => r.mrrUsd > 0).length;
  const managedRows = managedImports.data ?? [];
  const pendingManaged = managedRows.filter((r) => r.importStatus !== 'done');

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Space size={48} wrap>
          <Statistic title="Paying customers" value={payingCount} />
          <Statistic title="Monthly recurring revenue" value={money(totalMrr)} />
          <Statistic title="Overage (this period)" value={money(totalOverage)} />
        </Space>
      </Card>

      <Card
        title="Capiro-managed client imports"
        extra={
          pendingManaged.length > 0 ? (
            <Tag color="gold">{pendingManaged.length} awaiting completion</Tag>
          ) : null
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
          Firms that chose white-glove import. Once you've added a firm's clients, mark it complete
          to unblock their “Invite your team” step on the setup dashboard.
        </Typography.Paragraph>
        <Table<ManagedImportRow>
          rowKey="tenantId"
          loading={managedImports.isLoading}
          dataSource={managedRows}
          pagination={false}
          locale={{ emptyText: 'No Capiro-managed imports' }}
          columns={[
            {
              title: 'Tenant',
              dataIndex: 'name',
              render: (name, r) => (
                <span>
                  {name} <Typography.Text type="secondary">/{r.slug}</Typography.Text>
                </span>
              ),
            },
            {
              title: 'Clients added',
              dataIndex: 'clientCount',
              width: 130,
            },
            {
              title: 'Import step',
              dataIndex: 'importStatus',
              width: 130,
              render: (s: ManagedImportRow['importStatus']) =>
                s === 'done' ? (
                  <Tag color="green">complete</Tag>
                ) : (
                  <Tag color="gold">in progress</Tag>
                ),
            },
            {
              title: 'Action',
              width: 180,
              render: (_v, r) =>
                r.importStatus === 'done' ? (
                  <Typography.Text type="secondary">—</Typography.Text>
                ) : (
                  <Popconfirm
                    title="Mark client import complete?"
                    description={`This unblocks ${r.name}'s team-invite step. Do this only after their clients are added.`}
                    onConfirm={() => markImportComplete.mutate(r.tenantId)}
                  >
                    <Button size="small" type="primary">
                      Mark import complete
                    </Button>
                  </Popconfirm>
                ),
            },
          ]}
        />
      </Card>

      <Card title="Customers">
        <Table<CustomerRow>
          rowKey="tenantId"
          loading={customers.isLoading}
          dataSource={rows}
          pagination={{ pageSize: 25 }}
          columns={[
            {
              title: 'Tenant',
              dataIndex: 'name',
              render: (name, r) => (
                <span>
                  {name} <Typography.Text type="secondary">/{r.slug}</Typography.Text>
                </span>
              ),
            },
            {
              title: 'Status',
              dataIndex: 'status',
              width: 130,
              render: (status: BillingStatus) => <Tag color={STATUS_COLOR[status]}>{status}</Tag>,
              filters: (
                ['active', 'trialing', 'past_due', 'canceled', 'comped', 'none'] as BillingStatus[]
              ).map((s) => ({ text: s, value: s })),
              onFilter: (value, r) => r.status === value,
            },
            {
              title: 'Slots',
              width: 110,
              render: (_v, r) => `${r.usedSlots} / ${r.slots}`,
            },
            {
              title: '$/slot',
              dataIndex: 'pricePerSlotUsd',
              width: 90,
              render: (v: number) => money(v),
            },
            {
              title: 'MRR',
              dataIndex: 'mrrUsd',
              width: 110,
              sorter: (a, b) => a.mrrUsd - b.mrrUsd,
              defaultSortOrder: 'descend',
              render: (v: number) => money(v),
            },
            {
              title: 'AI used',
              dataIndex: 'llmUsedUsd',
              width: 110,
              render: (v: number) => money(v),
            },
            {
              title: 'Overage',
              dataIndex: 'llmOverageUsd',
              width: 110,
              render: (v: number) =>
                v > 0 ? <Typography.Text type="danger">{money(v)}</Typography.Text> : money(0),
            },
            {
              title: 'Renews',
              dataIndex: 'currentPeriodEnd',
              width: 120,
              render: (v: string | null) => (v ? new Date(v).toLocaleDateString() : '—'),
            },
            {
              title: 'Actions',
              width: 130,
              render: (_v, r) =>
                r.status === 'comped' ? (
                  <Popconfirm
                    title="Remove complimentary access?"
                    description="They will need to subscribe to keep using Capiro."
                    onConfirm={() => comp.mutate({ tenantId: r.tenantId, comped: false })}
                  >
                    <Button size="small">Un-comp</Button>
                  </Popconfirm>
                ) : (
                  <Popconfirm
                    title="Grant complimentary access?"
                    description="This tenant will bypass payment and usage limits."
                    onConfirm={() => comp.mutate({ tenantId: r.tenantId, comped: true })}
                  >
                    <Button size="small">Comp</Button>
                  </Popconfirm>
                ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
