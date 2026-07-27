import { useEffect, useState, type ReactNode } from 'react';
import {
  ApiOutlined,
  CloudSyncOutlined,
  GoogleOutlined,
  MailOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Form, Input, Modal, Space, Tag, Typography } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { McpServersCard } from './McpServersCard.js';

type Provider = 'microsoft_365' | 'google_workspace' | 'imap_caldav';

interface IntegrationConnection {
  id: string;
  provider: Provider;
  accountEmail: string | null;
  displayName: string | null;
  status: 'needs_configuration' | 'connected' | 'error' | 'disabled';
  scopes: string[];
  lastSyncAt: string | null;
  lastError: string | null;
}

interface IntegrationFormValues {
  accountEmail?: string;
  displayName?: string;
}

interface ProviderCapabilities {
  configured: boolean;
  redirectUri: string;
  scopes: string[];
}

const providers: Array<{
  key: Provider;
  title: string;
  icon: ReactNode;
  description: string;
}> = [
  {
    key: 'microsoft_365',
    title: 'Microsoft 365',
    icon: <CloudSyncOutlined />,
    description: 'Graph calendar and mail normalization.',
  },
  {
    key: 'google_workspace',
    title: 'Google Workspace',
    icon: <GoogleOutlined />,
    description: 'Gmail and Google Calendar normalization.',
  },
  {
    key: 'imap_caldav',
    title: 'IMAP / CalDAV',
    icon: <MailOutlined />,
    description: 'Fallback mail and calendar ingestion.',
  },
];

export function IntegrationsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [form] = Form.useForm<IntegrationFormValues>();

  const integrations = useQuery<IntegrationConnection[]>({
    queryKey: ['engagement-integrations'],
    queryFn: async () =>
      (await api.get<IntegrationConnection[]>('/api/engagement/integrations')).data,
  });

  // Both providers expose GET .../capabilities returning { configured }. Until
  // this was wired, an unconfigured provider rendered an enabled Connect button
  // that 503'd on click ("Google OAuth is not fully configured") instead of
  // saying so up front.
  const microsoftCapabilities = useQuery<ProviderCapabilities>({
    queryKey: ['integration-capabilities', 'microsoft'],
    queryFn: async () =>
      (
        await api.get<ProviderCapabilities>(
          '/api/engagement/integrations/microsoft/capabilities',
        )
      ).data,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const googleCapabilities = useQuery<ProviderCapabilities>({
    queryKey: ['integration-capabilities', 'google'],
    queryFn: async () =>
      (await api.get<ProviderCapabilities>('/api/engagement/integrations/google/capabilities')).data,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const createIntegration = useMutation({
    mutationFn: async (values: IntegrationFormValues) =>
      (
        await api.post('/api/engagement/integrations', {
          provider: selectedProvider,
          accountEmail: values.accountEmail,
          displayName: values.displayName,
        })
      ).data,
    onSuccess: () => {
      message.success('Integration record created');
      setSelectedProvider(null);
      form.resetFields();
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
    },
    onError: (err) => message.error(err instanceof Error ? err.message : 'Request failed'),
  });

  const startMicrosoftOAuth = useMutation({
    mutationFn: async (connectionId?: string) =>
      (
        await api.post<{ authUrl: string; connectionId: string }>(
          '/api/engagement/integrations/microsoft/start',
          connectionId ? { connectionId } : {},
        )
      ).data,
    onSuccess: ({ authUrl }) => {
      window.location.href = authUrl;
    },
    onError: (err) => message.error(err instanceof Error ? err.message : 'OAuth start failed'),
  });

  const syncMicrosoft = useMutation({
    mutationFn: async (connectionId: string) =>
      // Mailbox/calendar sync pages through Graph + persists per item; a fresh
      // reset-sync legitimately runs longer than the global 20s axios timeout
      // (the API still returns hasMore so it can be re-run). Give this specific
      // call generous headroom (just under the 180s ALB idle timeout) so the
      // client doesn't abort a sync the server is completing successfully —
      // users on slow connections were hitting the 120s abort mid-sync.
      (
        await api.post(`/api/engagement/integrations/microsoft/${connectionId}/sync`, undefined, {
          timeout: 170_000,
        })
      ).data,
    onSuccess: () => {
      message.success('Microsoft sync complete');
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-mail-threads'] });
      qc.invalidateQueries({ queryKey: ['client-meetings'] });
      qc.invalidateQueries({ queryKey: ['client-mail-threads'] });
    },
    onError: (err) => message.error(err instanceof Error ? err.message : 'Sync failed'),
  });

  const enableMicrosoftRealtime = useMutation({
    mutationFn: async (connectionId: string) =>
      (await api.post(`/api/engagement/integrations/microsoft/${connectionId}/subscriptions`)).data,
    onSuccess: () => {
      message.success('Graph subscriptions configured');
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
    },
    onError: (err) =>
      message.error(err instanceof Error ? err.message : 'Subscription setup failed'),
  });

  const startGoogleOAuth = useMutation({
    mutationFn: async (connectionId?: string) =>
      (
        await api.post<{ authUrl: string; connectionId: string }>(
          '/api/engagement/integrations/google/start',
          connectionId ? { connectionId } : {},
        )
      ).data,
    onSuccess: ({ authUrl }) => {
      window.location.href = authUrl;
    },
    onError: (err) => message.error(err instanceof Error ? err.message : 'OAuth start failed'),
  });

  const syncGoogle = useMutation({
    mutationFn: async (connectionId: string) =>
      // Same reasoning as syncMicrosoft: Gmail/Calendar sync pages + persists per
      // item and a reset-sync can exceed the default 20s axios timeout (the API
      // returns hasMore so it can be re-run). Give it headroom under the 180s ALB
      // idle timeout.
      (
        await api.post(`/api/engagement/integrations/google/${connectionId}/sync`, undefined, {
          timeout: 170_000,
        })
      ).data,
    onSuccess: () => {
      message.success('Google sync complete');
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-mail-threads'] });
      qc.invalidateQueries({ queryKey: ['client-meetings'] });
      qc.invalidateQueries({ queryKey: ['client-mail-threads'] });
    },
    onError: (err) => message.error(err instanceof Error ? err.message : 'Sync failed'),
  });

  const disconnectGoogle = useMutation({
    mutationFn: async (connectionId: string) =>
      (await api.delete(`/api/engagement/integrations/google/${connectionId}`)).data,
    onSuccess: () => {
      message.success('Google Workspace disconnected');
      // The connection is gone and previously synced meetings/mail have had their
      // connectionId cleared, so refresh the integrations list and the engagement
      // views that surface synced items.
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-mail-threads'] });
      qc.invalidateQueries({ queryKey: ['client-meetings'] });
      qc.invalidateQueries({ queryKey: ['client-mail-threads'] });
    },
    onError: (err) => message.error(err instanceof Error ? err.message : 'Disconnect failed'),
  });

  const disconnectMicrosoft = useMutation({
    mutationFn: async (connectionId: string) =>
      (await api.delete(`/api/engagement/integrations/microsoft/${connectionId}`)).data,
    onSuccess: () => {
      message.success('Microsoft 365 disconnected');
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-mail-threads'] });
      qc.invalidateQueries({ queryKey: ['client-meetings'] });
      qc.invalidateQueries({ queryKey: ['client-mail-threads'] });
    },
    onError: (err) => message.error(err instanceof Error ? err.message : 'Disconnect failed'),
  });

  // Surface success / error from the OAuth callback redirect (both providers).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const provider = params.get('provider');
    if (provider !== 'microsoft_365' && provider !== 'google_workspace') return;
    const label = provider === 'google_workspace' ? 'Google Workspace' : 'Microsoft 365';
    if (params.get('connected') === '1') {
      message.success(`${label} connected`);
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
    } else if (params.get('error')) {
      message.error(`${label} OAuth failed: ${params.get('error')}`);
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('provider');
    url.searchParams.delete('connected');
    url.searchParams.delete('connectionId');
    url.searchParams.delete('error');
    window.history.replaceState({}, '', url.toString());
  }, [message, qc]);

  return (
    <section className="settings-integrations">
      <div className="settings-integrations-header">
        <div>
          <Typography.Title level={5}>Engagement Integrations</Typography.Title>
          <Typography.Text type="secondary">
            Provider records, scopes, sync state, and connection health.
          </Typography.Text>
        </div>
        <Tag icon={<CloudSyncOutlined />} color="processing">
          normalized engagement store
        </Tag>
      </div>

      <div className="settings-integration-grid">
        {providers.map((provider) => {
          const connections = (integrations.data ?? []).filter(
            (connection) => connection.provider === provider.key,
          );
          const capabilityQuery =
            provider.key === 'microsoft_365'
              ? microsoftCapabilities
              : provider.key === 'google_workspace'
                ? googleCapabilities
                : undefined;
          // Fail OPEN while loading or if the probe itself errored: a flaky
          // capabilities call must never block a user from connecting a provider
          // that is in fact configured. Only an explicit configured:false disables.
          const providerConfigured = capabilityQuery?.data
            ? capabilityQuery.data.configured
            : true;
          const capabilitiesLoading = Boolean(capabilityQuery?.isLoading);
          return (
            <article className="settings-integration-card" key={provider.key}>
              <div className="settings-integration-top">
                <span className="settings-integration-icon">{provider.icon}</span>
                <div>
                  <Typography.Text strong>{provider.title}</Typography.Text>
                  <Typography.Text type="secondary">{provider.description}</Typography.Text>
                </div>
              </div>

              <div className="settings-integration-connections">
                {connections.length ? (
                  connections.map((connection) => (
                    <div className="settings-integration-row" key={connection.id}>
                      <div>
                        <Typography.Text>
                          {connection.displayName || connection.accountEmail || 'Workspace'}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          {[
                            connection.accountEmail || 'No account email',
                            connection.lastSyncAt
                              ? `Synced ${formatDateTime(connection.lastSyncAt)}`
                              : 'Not synced yet',
                          ].join(' | ')}
                        </Typography.Text>
                        {connection.lastError ? (
                          <Typography.Text type="danger">{connection.lastError}</Typography.Text>
                        ) : null}
                      </div>
                      <Space wrap>
                        <Tag color={statusColor(connection.status)}>
                          {statusLabel(connection.status)}
                        </Tag>
                        {provider.key === 'microsoft_365' && connection.status === 'connected' ? (
                          <>
                            <Button
                              size="small"
                              loading={syncMicrosoft.isPending}
                              onClick={() => syncMicrosoft.mutate(connection.id)}
                            >
                              Sync now
                            </Button>
                            <Button
                              size="small"
                              loading={enableMicrosoftRealtime.isPending}
                              onClick={() => enableMicrosoftRealtime.mutate(connection.id)}
                            >
                              Realtime
                            </Button>
                          </>
                        ) : null}
                        {provider.key === 'google_workspace' &&
                        connection.status === 'connected' ? (
                          <Button
                            size="small"
                            loading={syncGoogle.isPending}
                            onClick={() => syncGoogle.mutate(connection.id)}
                          >
                            Sync now
                          </Button>
                        ) : null}
                        {/* Disconnect is offered for ANY status: a connected
                            account can be removed, and an errored/stale one
                            (revoked token) can be cleared out too. */}
                        {provider.key === 'google_workspace' || provider.key === 'microsoft_365' ? (
                          <Button
                            size="small"
                            danger
                            loading={
                              provider.key === 'google_workspace'
                                ? disconnectGoogle.isPending
                                : disconnectMicrosoft.isPending
                            }
                            onClick={() =>
                              modal.confirm({
                                title:
                                  provider.key === 'google_workspace'
                                    ? 'Disconnect Google Workspace?'
                                    : 'Disconnect Microsoft 365?',
                                content:
                                  provider.key === 'google_workspace'
                                    ? 'This revokes Capiro’s access to this Google account and removes the connection. Previously synced meetings and mail are kept; future syncing stops until you reconnect.'
                                    : 'This removes Capiro’s stored access for this Outlook mailbox and stops all syncing. Previously synced meetings and mail are kept. To also withdraw the app permission itself, visit myapplications.microsoft.com.',
                                okText: 'Disconnect',
                                okButtonProps: { danger: true },
                                cancelText: 'Cancel',
                                onOk: () =>
                                  provider.key === 'google_workspace'
                                    ? disconnectGoogle.mutateAsync(connection.id)
                                    : disconnectMicrosoft.mutateAsync(connection.id),
                              })
                            }
                          >
                            Disconnect
                          </Button>
                        ) : null}
                      </Space>
                    </div>
                  ))
                ) : (
                  <Typography.Text type="secondary">No accounts registered.</Typography.Text>
                )}
              </div>

              {capabilityQuery && !providerConfigured ? (
                <Typography.Text type="warning">
                  This provider is not configured on the server. A Capiro administrator must
                  add the OAuth credentials before accounts can be connected.
                </Typography.Text>
              ) : null}

              <Space wrap>
                <Button
                  icon={<PlusOutlined />}
                  onClick={() => {
                    setSelectedProvider(provider.key);
                    form.resetFields();
                  }}
                >
                  Register account
                </Button>
                {provider.key === 'microsoft_365' ? (
                  <Button
                    icon={<ApiOutlined />}
                    type="primary"
                    loading={startMicrosoftOAuth.isPending || capabilitiesLoading}
                    disabled={!providerConfigured}
                    title={
                      providerConfigured ? undefined : 'Administrator setup required'
                    }
                    onClick={() =>
                      startMicrosoftOAuth.mutate(
                        connections.find((c) => c.status !== 'connected')?.id,
                      )
                    }
                  >
                    {providerConfigured
                      ? 'Connect Microsoft 365'
                      : 'Administrator setup required'}
                  </Button>
                ) : provider.key === 'google_workspace' ? (
                  <Button
                    icon={<ApiOutlined />}
                    type="primary"
                    loading={startGoogleOAuth.isPending || capabilitiesLoading}
                    disabled={!providerConfigured}
                    title={
                      providerConfigured ? undefined : 'Administrator setup required'
                    }
                    onClick={() =>
                      startGoogleOAuth.mutate(connections.find((c) => c.status !== 'connected')?.id)
                    }
                  >
                    {providerConfigured
                      ? 'Connect Google Workspace'
                      : 'Administrator setup required'}
                  </Button>
                ) : (
                  <Button icon={<ApiOutlined />} disabled>
                    Connect OAuth
                  </Button>
                )}
              </Space>
            </article>
          );
        })}
      </div>

      {/* Meri connector library (connector-library v1). Any standard_user can
          browse the catalog and manage their OWN personal connectors; firm-wide
          connectors are admin-gated (enforced in MeriMcpService). The card hides
          itself only for client_portal_user. */}
      <McpServersCard />

      <Modal
        title={
          selectedProvider
            ? `Register ${providers.find((provider) => provider.key === selectedProvider)?.title}`
            : 'Register integration'
        }
        open={Boolean(selectedProvider)}
        onCancel={() => setSelectedProvider(null)}
        onOk={() => form.submit()}
        confirmLoading={createIntegration.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(values) => createIntegration.mutate(values)}>
          <Form.Item name="displayName" label="Display name">
            <Input placeholder="Jane's Microsoft 365" />
          </Form.Item>
          <Form.Item name="accountEmail" label="Account email" rules={[{ type: 'email' }]}>
            <Input placeholder="jane@example.com" />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}

function statusColor(status: IntegrationConnection['status']): string {
  if (status === 'connected') return 'green';
  if (status === 'error') return 'red';
  if (status === 'disabled') return 'default';
  return 'gold';
}

function statusLabel(status: IntegrationConnection['status']): string {
  return status.replace(/_/g, ' ');
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}
