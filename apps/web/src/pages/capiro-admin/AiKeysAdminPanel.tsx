/**
 * Capiro-admin "AI Keys & Usage" console: every tenant's estimated AI spend
 * (sortable), with a per-tenant drawer to drill into usage and enter/rotate/
 * remove that tenant's own provider key. Server-side capiro_admin guard is
 * the security boundary. Key handling is identical to the tenant settings
 * page: write-only, validated before save, displayed as last-4 only.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useApi } from '../../lib/use-api.js';
import {
  UsageSummaryPanels,
  fmtTokens,
  fmtUsd,
  type MaskedAiCredential,
  type TenantUsageSummary,
} from '../../components/ai-usage/UsageSummaryPanels.js';
import { apiErrorMessage } from '../settings/AiUsagePage.js';

interface AdminTenantUsageRow {
  tenantId: string;
  tenantName: string;
  totalCostUsd: number;
  totalTokens: number;
  eventCount: number;
  tenantKeyEventCount: number;
}

/** Subset of GET /api/capiro-admin/tenants we need for the roster. */
interface TenantListRow {
  id: string;
  name: string;
}

interface SaveKeyFormValues {
  provider: 'openai' | 'anthropic';
  apiKey: string;
  modelOverride?: string;
}

const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
];

// Model choices offered per provider. Leaving the field blank uses the platform
// default for that provider. (Keep IDs in sync with what the providers accept;
// an unsupported model is rejected by the save-time validation call.)
const MODELS_BY_PROVIDER: Record<'openai' | 'anthropic', { value: string; label: string }[]> = {
  openai: [
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini (default)' },
    { value: 'gpt-4.1-nano', label: 'GPT-4.1 nano' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4-mini' },
  ],
  anthropic: [
    { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
};

export function AiKeysAdminPanel() {
  const api = useApi();
  const [rangeDays, setRangeDays] = useState<number>(30);
  const [selected, setSelected] = useState<AdminTenantUsageRow | null>(null);

  const from = useMemo(
    () => new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString(),
    [rangeDays],
  );

  const usage = useQuery<AdminTenantUsageRow[]>({
    queryKey: ['capiro-admin', 'ai-usage', rangeDays],
    queryFn: async () =>
      (await api.get<AdminTenantUsageRow[]>('/api/capiro-admin/ai-usage', { params: { from } }))
        .data,
  });

  // The roster comes from the TENANTS list, not from usage rows — a tenant
  // with zero generations (e.g. right after onboarding, or right after this
  // feature shipped) must still appear so an admin can set their key.
  const tenants = useQuery<TenantListRow[]>({
    queryKey: ['capiro-admin', 'tenants'],
    queryFn: async () => (await api.get<TenantListRow[]>('/api/capiro-admin/tenants')).data,
  });

  const rows = useMemo<AdminTenantUsageRow[]>(() => {
    const usageByTenant = new Map((usage.data ?? []).map((r) => [r.tenantId, r]));
    return (tenants.data ?? []).map(
      (t) =>
        usageByTenant.get(t.id) ?? {
          tenantId: t.id,
          tenantName: t.name,
          totalCostUsd: 0,
          totalTokens: 0,
          eventCount: 0,
          tenantKeyEventCount: 0,
        },
    );
  }, [tenants.data, usage.data]);

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Text type="secondary">
          Estimated AI spend per tenant (hand-maintained pricing table). Open a tenant to manage
          their own provider key.
        </Typography.Text>
        <Segmented
          options={[
            { label: '7 days', value: 7 },
            { label: '30 days', value: 30 },
            { label: '90 days', value: 90 },
          ]}
          value={rangeDays}
          onChange={(v) => setRangeDays(Number(v))}
        />
      </Space>

      {tenants.isError || usage.isError ? (
        <Alert
          type="error"
          showIcon
          message="Couldn't load tenant AI usage."
          description={apiErrorMessage(tenants.error ?? usage.error)}
        />
      ) : (
        <Table<AdminTenantUsageRow>
          size="small"
          rowKey="tenantId"
          loading={tenants.isLoading || usage.isLoading}
          dataSource={rows}
          locale={{ emptyText: 'No tenants yet' }}
          columns={[
            { title: 'Tenant', dataIndex: 'tenantName', key: 'tenantName', ellipsis: true },
            {
              title: 'Est. spend',
              dataIndex: 'totalCostUsd',
              key: 'totalCostUsd',
              align: 'right',
              defaultSortOrder: 'descend',
              sorter: (a, b) => a.totalCostUsd - b.totalCostUsd,
              render: (v: number) => fmtUsd(v),
            },
            {
              title: 'Tokens',
              dataIndex: 'totalTokens',
              key: 'totalTokens',
              align: 'right',
              sorter: (a, b) => a.totalTokens - b.totalTokens,
              render: (v: number) => fmtTokens(v),
            },
            {
              title: 'Generations',
              dataIndex: 'eventCount',
              key: 'eventCount',
              align: 'right',
              sorter: (a, b) => a.eventCount - b.eventCount,
            },
            {
              title: 'Key',
              key: 'ownKey',
              render: (_, row) =>
                row.tenantKeyEventCount > 0 ? (
                  <Tag color="green">own key</Tag>
                ) : (
                  <Tag>Capiro shared</Tag>
                ),
            },
            {
              title: '',
              key: 'actions',
              render: (_, row) => (
                <Button size="small" onClick={() => setSelected(row)}>
                  Manage
                </Button>
              ),
            },
          ]}
        />
      )}

      <Drawer
        title={selected ? `${selected.tenantName} — AI usage & key` : ''}
        width={720}
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        destroyOnClose
      >
        {selected ? <TenantDrawer tenantId={selected.tenantId} from={from} /> : null}
      </Drawer>
    </div>
  );
}

function TenantDrawer({ tenantId, from }: { tenantId: string; from: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<SaveKeyFormValues>();
  // Drive the model dropdown's options off the chosen provider.
  const selectedProvider = (Form.useWatch('provider', form) ?? 'openai') as 'openai' | 'anthropic';

  const usage = useQuery<TenantUsageSummary>({
    queryKey: ['capiro-admin', 'tenant-ai-usage', tenantId, from],
    queryFn: async () =>
      (
        await api.get<TenantUsageSummary>(`/api/capiro-admin/tenants/${tenantId}/ai-usage`, {
          params: { from },
        })
      ).data,
  });

  const credentials = useQuery<MaskedAiCredential[]>({
    queryKey: ['capiro-admin', 'tenant-ai-credential', tenantId],
    queryFn: async () =>
      (await api.get<MaskedAiCredential[]>(`/api/capiro-admin/tenants/${tenantId}/ai-credential`))
        .data,
  });

  const saveKey = useMutation({
    mutationFn: async (values: SaveKeyFormValues) =>
      (
        await api.post<MaskedAiCredential>(
          `/api/capiro-admin/tenants/${tenantId}/ai-credential`,
          values,
          // Validation makes a real provider call before storing.
          { timeout: 45_000 },
        )
      ).data,
    onSuccess: (saved) => {
      message.success(`${saved.provider} key validated and saved for this tenant`);
      form.resetFields(['apiKey']);
      qc.invalidateQueries({ queryKey: ['capiro-admin', 'tenant-ai-credential', tenantId] });
      qc.invalidateQueries({ queryKey: ['capiro-admin', 'ai-usage'] });
    },
    onError: (err) => message.error(apiErrorMessage(err)),
  });

  const removeKey = useMutation({
    mutationFn: async (provider: string) =>
      (await api.delete(`/api/capiro-admin/tenants/${tenantId}/ai-credential/${provider}`)).data,
    onSuccess: (_data, provider) => {
      message.success(`${provider} key removed — tenant falls back to the Capiro shared key`);
      qc.invalidateQueries({ queryKey: ['capiro-admin', 'tenant-ai-credential', tenantId] });
      qc.invalidateQueries({ queryKey: ['capiro-admin', 'ai-usage'] });
    },
    onError: (err) => message.error(apiErrorMessage(err)),
  });

  return (
    <div>
      <Card size="small" title="Provider key" style={{ marginBottom: 16 }}>
        {(credentials.data ?? []).map((cred) => (
          <Space key={cred.provider} style={{ display: 'flex', marginBottom: 8 }} wrap>
            <Tag color="blue">{cred.provider}</Tag>
            <Typography.Text code>•••• {cred.last4}</Typography.Text>
            {cred.modelOverride ? <Tag>{cred.modelOverride}</Tag> : null}
            <Tag color={cred.status === 'active' ? 'green' : 'orange'}>{cred.status}</Tag>
            <Popconfirm
              title={`Remove the ${cred.provider} key?`}
              description="The tenant falls back to the Capiro shared key."
              onConfirm={() => removeKey.mutate(cred.provider)}
            >
              <Button size="small" danger loading={removeKey.isPending}>
                Remove
              </Button>
            </Popconfirm>
          </Space>
        ))}

        <Form<SaveKeyFormValues>
          form={form}
          layout="inline"
          initialValues={{ provider: 'openai' }}
          onFinish={(values) => saveKey.mutate(values)}
          style={{ marginTop: 8, rowGap: 8 }}
        >
          <Form.Item name="provider" rules={[{ required: true }]}>
            <Select
              options={PROVIDER_OPTIONS}
              style={{ width: 130 }}
              // The model list is provider-specific, so clear any picked model
              // when the provider changes.
              onChange={() => form.setFieldValue('modelOverride', undefined)}
            />
          </Form.Item>
          <Form.Item
            name="apiKey"
            rules={[{ required: true, message: 'API key is required' }, { min: 8 }]}
          >
            <Input.Password
              placeholder="Paste API key (write-only)"
              autoComplete="off"
              style={{ width: 260 }}
            />
          </Form.Item>
          <Form.Item
            name="modelOverride"
            tooltip="Which model this key should use. Leave as Default to use the platform default for this provider."
          >
            <Select
              allowClear
              placeholder="Default model"
              style={{ width: 200 }}
              options={MODELS_BY_PROVIDER[selectedProvider]}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={saveKey.isPending}>
              Validate &amp; save
            </Button>
          </Form.Item>
        </Form>
      </Card>

      {usage.isError ? (
        <Alert
          type="error"
          showIcon
          message="Couldn't load this tenant's usage."
          description={apiErrorMessage(usage.error)}
        />
      ) : (
        <UsageSummaryPanels summary={usage.data} loading={usage.isLoading} />
      )}
    </div>
  );
}
