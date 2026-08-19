/**
 * vNext re-skin of pages/settings/IntegrationsPage.tsx — identical endpoints,
 * query keys (including the fail-OPEN capabilities probes), OAuth start/sync/
 * disconnect flows, extended sync timeouts, the OAuth-callback query-param
 * surfacing, and copy. The Meri connector library card is the vNext
 * McpServersCard port below it, exactly like canonical.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudCog, Globe, Mail, Plug, Plus } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroInput } from '../../components/fields/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { SvCard, useSvConfirm } from './settings-ui.js';
import { VNextMcpServersCard } from './VNextMcpServersCard.js';

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
    icon: <CloudCog size={20} />,
    description: 'Graph calendar and mail normalization.',
  },
  {
    key: 'google_workspace',
    title: 'Google Workspace',
    icon: <Globe size={20} />,
    description: 'Gmail and Google Calendar normalization.',
  },
  {
    key: 'imap_caldav',
    title: 'IMAP / CalDAV',
    icon: <Mail size={20} />,
    description: 'Fallback mail and calendar ingestion.',
  },
];

export function VNextIntegrationsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [form, setForm] = useState<IntegrationFormValues>({});
  const [formError, setFormError] = useState<string | undefined>();

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
      toast.success('Integration record created');
      setSelectedProvider(null);
      setForm({});
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Request failed'),
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
    onError: (err) => toast.error(err instanceof Error ? err.message : 'OAuth start failed'),
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
      toast.success('Microsoft sync complete');
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-mail-threads'] });
      qc.invalidateQueries({ queryKey: ['client-meetings'] });
      qc.invalidateQueries({ queryKey: ['client-mail-threads'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Sync failed'),
  });

  const enableMicrosoftRealtime = useMutation({
    mutationFn: async (connectionId: string) =>
      (await api.post(`/api/engagement/integrations/microsoft/${connectionId}/subscriptions`)).data,
    onSuccess: () => {
      toast.success('Graph subscriptions configured');
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Subscription setup failed'),
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
    onError: (err) => toast.error(err instanceof Error ? err.message : 'OAuth start failed'),
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
      toast.success('Google sync complete');
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-mail-threads'] });
      qc.invalidateQueries({ queryKey: ['client-meetings'] });
      qc.invalidateQueries({ queryKey: ['client-mail-threads'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Sync failed'),
  });

  const disconnectGoogle = useMutation({
    mutationFn: async (connectionId: string) =>
      (await api.delete(`/api/engagement/integrations/google/${connectionId}`)).data,
    onSuccess: () => {
      toast.success('Google Workspace disconnected');
      // The connection is gone and previously synced meetings/mail have had their
      // connectionId cleared, so refresh the integrations list and the engagement
      // views that surface synced items.
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-mail-threads'] });
      qc.invalidateQueries({ queryKey: ['client-meetings'] });
      qc.invalidateQueries({ queryKey: ['client-mail-threads'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Disconnect failed'),
  });

  const disconnectMicrosoft = useMutation({
    mutationFn: async (connectionId: string) =>
      (await api.delete(`/api/engagement/integrations/microsoft/${connectionId}`)).data,
    onSuccess: () => {
      toast.success('Microsoft 365 disconnected');
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-mail-threads'] });
      qc.invalidateQueries({ queryKey: ['client-meetings'] });
      qc.invalidateQueries({ queryKey: ['client-mail-threads'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Disconnect failed'),
  });

  // Surface success / error from the OAuth callback redirect (both providers).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const provider = params.get('provider');
    if (provider !== 'microsoft_365' && provider !== 'google_workspace') return;
    const label = provider === 'google_workspace' ? 'Google Workspace' : 'Microsoft 365';
    if (params.get('connected') === '1') {
      toast.success(`${label} connected`);
      qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
    } else if (params.get('error')) {
      toast.error(`${label} OAuth failed: ${params.get('error')}`);
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('provider');
    url.searchParams.delete('connected');
    url.searchParams.delete('connectionId');
    url.searchParams.delete('error');
    window.history.replaceState({}, '', url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitRegister = () => {
    const email = form.accountEmail?.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFormError('Enter a valid email');
      return;
    }
    setFormError(undefined);
    createIntegration.mutate(form);
  };

  return (
    <section className="stv-stack" aria-label="Engagement Integrations">
      <div className="stv-row stv-row--between stv-row--start">
        <div>
          <h2 className="stv-card__title" style={{ margin: 0 }}>
            Engagement Integrations
          </h2>
          <p className="stv-card__desc">
            Provider records, scopes, sync state, and connection health.
          </p>
        </div>
        <CapiroBadge tone="info">normalized engagement store</CapiroBadge>
      </div>

      <div className="stv-integration-grid">
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
            <SvCard key={provider.key} className="stv-integration-card">
              <div className="stv-stack">
                <div className="stv-integration-top">
                  <span className="stv-integration-icon">{provider.icon}</span>
                  <div>
                    <div className="stv-strong">{provider.title}</div>
                    <div className="stv-muted stv-small">{provider.description}</div>
                  </div>
                </div>

                <div>
                  {connections.length ? (
                    connections.map((connection) => (
                      <div className="stv-integration-row" key={connection.id}>
                        <div className="stv-stack stv-stack--tight" style={{ gap: 2 }}>
                          <span>
                            {connection.displayName || connection.accountEmail || 'Workspace'}
                          </span>
                          <span className="stv-muted stv-small">
                            {[
                              connection.accountEmail || 'No account email',
                              connection.lastSyncAt
                                ? `Synced ${formatDateTime(connection.lastSyncAt)}`
                                : 'Not synced yet',
                            ].join(' | ')}
                          </span>
                          {connection.lastError ? (
                            <span className="stv-danger-text stv-small">{connection.lastError}</span>
                          ) : null}
                        </div>
                        <div className="stv-row" style={{ gap: 6 }}>
                          <CapiroBadge tone={statusTone(connection.status)}>
                            {statusLabel(connection.status)}
                          </CapiroBadge>
                          {provider.key === 'microsoft_365' && connection.status === 'connected' ? (
                            <>
                              <CapiroButton
                                size="compact"
                                loading={syncMicrosoft.isPending}
                                onClick={() => syncMicrosoft.mutate(connection.id)}
                              >
                                Sync now
                              </CapiroButton>
                              <CapiroButton
                                size="compact"
                                loading={enableMicrosoftRealtime.isPending}
                                onClick={() => enableMicrosoftRealtime.mutate(connection.id)}
                              >
                                Realtime
                              </CapiroButton>
                            </>
                          ) : null}
                          {provider.key === 'google_workspace' &&
                          connection.status === 'connected' ? (
                            <CapiroButton
                              size="compact"
                              loading={syncGoogle.isPending}
                              onClick={() => syncGoogle.mutate(connection.id)}
                            >
                              Sync now
                            </CapiroButton>
                          ) : null}
                          {/* Disconnect is offered for ANY status: a connected
                              account can be removed, and an errored/stale one
                              (revoked token) can be cleared out too. */}
                          {provider.key === 'google_workspace' ||
                          provider.key === 'microsoft_365' ? (
                            <CapiroButton
                              size="compact"
                              className="stv-btn-danger"
                              loading={
                                provider.key === 'google_workspace'
                                  ? disconnectGoogle.isPending
                                  : disconnectMicrosoft.isPending
                              }
                              onClick={() =>
                                confirm({
                                  title:
                                    provider.key === 'google_workspace'
                                      ? 'Disconnect Google Workspace?'
                                      : 'Disconnect Microsoft 365?',
                                  body:
                                    provider.key === 'google_workspace'
                                      ? 'This revokes Capiro’s access to this Google account and removes the connection. Previously synced meetings and mail are kept; future syncing stops until you reconnect.'
                                      : 'This removes Capiro’s stored access for this Outlook mailbox and stops all syncing. Previously synced meetings and mail are kept. To also withdraw the app permission itself, visit myapplications.microsoft.com.',
                                  okText: 'Disconnect',
                                  danger: true,
                                  onOk: () =>
                                    provider.key === 'google_workspace'
                                      ? disconnectGoogle.mutateAsync(connection.id)
                                      : disconnectMicrosoft.mutateAsync(connection.id),
                                })
                              }
                            >
                              Disconnect
                            </CapiroButton>
                          ) : null}
                        </div>
                      </div>
                    ))
                  ) : (
                    <span className="stv-muted">No accounts registered.</span>
                  )}
                </div>

                {capabilityQuery && !providerConfigured ? (
                  <span className="stv-warning-text stv-small">
                    This provider is not configured on the server. A Capiro administrator must add
                    the OAuth credentials before accounts can be connected.
                  </span>
                ) : null}

                <div className="stv-row">
                  <CapiroButton
                    leadingIcon={<Plus size={14} />}
                    onClick={() => {
                      setSelectedProvider(provider.key);
                      setForm({});
                      setFormError(undefined);
                    }}
                  >
                    Register account
                  </CapiroButton>
                  {provider.key === 'microsoft_365' ? (
                    <CapiroButton
                      variant="primary"
                      leadingIcon={<Plug size={14} />}
                      loading={startMicrosoftOAuth.isPending || capabilitiesLoading}
                      disabled={!providerConfigured}
                      title={providerConfigured ? undefined : 'Administrator setup required'}
                      onClick={() =>
                        startMicrosoftOAuth.mutate(
                          connections.find((c) => c.status !== 'connected')?.id,
                        )
                      }
                    >
                      {providerConfigured ? 'Connect Microsoft 365' : 'Administrator setup required'}
                    </CapiroButton>
                  ) : provider.key === 'google_workspace' ? (
                    <CapiroButton
                      variant="primary"
                      leadingIcon={<Plug size={14} />}
                      loading={startGoogleOAuth.isPending || capabilitiesLoading}
                      disabled={!providerConfigured}
                      title={providerConfigured ? undefined : 'Administrator setup required'}
                      onClick={() =>
                        startGoogleOAuth.mutate(connections.find((c) => c.status !== 'connected')?.id)
                      }
                    >
                      {providerConfigured
                        ? 'Connect Google Workspace'
                        : 'Administrator setup required'}
                    </CapiroButton>
                  ) : (
                    <CapiroButton leadingIcon={<Plug size={14} />} disabled>
                      Connect OAuth
                    </CapiroButton>
                  )}
                </div>
              </div>
            </SvCard>
          );
        })}
      </div>

      {/* Meri connector library (connector-library v1). Any standard_user can
          browse the catalog and manage their OWN personal connectors; firm-wide
          connectors are admin-gated (enforced in MeriMcpService). The card hides
          itself only for client_portal_user. */}
      <VNextMcpServersCard />

      {selectedProvider ? (
        <CapiroModal
          open
          title={`Register ${providers.find((provider) => provider.key === selectedProvider)?.title}`}
          onClose={() => setSelectedProvider(null)}
        >
          <form
            className="stv-stack"
            onSubmit={(event) => {
              event.preventDefault();
              submitRegister();
            }}
          >
            <CapiroInput
              label="Display name"
              placeholder="Jane's Microsoft 365"
              value={form.displayName ?? ''}
              onChange={(e) => setForm((c) => ({ ...c, displayName: e.target.value }))}
            />
            <CapiroInput
              label="Account email"
              placeholder="jane@example.com"
              error={formError}
              value={form.accountEmail ?? ''}
              onChange={(e) => setForm((c) => ({ ...c, accountEmail: e.target.value }))}
            />
            <div className="stv-row stv-row--end">
              <CapiroButton onClick={() => setSelectedProvider(null)}>Cancel</CapiroButton>
              <CapiroButton variant="primary" type="submit" loading={createIntegration.isPending}>
                OK
              </CapiroButton>
            </div>
          </form>
        </CapiroModal>
      ) : null}

      {dialog}
    </section>
  );
}

function statusTone(status: IntegrationConnection['status']): CapiroBadgeTone {
  if (status === 'connected') return 'success';
  if (status === 'error') return 'danger';
  if (status === 'disabled') return 'neutral';
  return 'warning';
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
