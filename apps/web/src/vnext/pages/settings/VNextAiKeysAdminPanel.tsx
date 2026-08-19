/**
 * vNext re-skin of pages/capiro-admin/AiKeysAdminPanel.tsx — identical
 * endpoints, query keys, roster join (tenants list × usage rows), write-only
 * key handling (validated before save, displayed as last-4 only) and copy.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { apiErrorMessage } from '../../../pages/settings/ai-usage-shared.js';
import {
  fmtTokens,
  fmtUsd,
  type MaskedAiCredential,
  type TenantUsageSummary,
} from '../../../components/ai-usage/usage-summary-shared.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroDrawer } from '../../components/overlays/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import {
  SvCallout,
  SvCard,
  SvSegmented,
  SvSortHeader,
  useSvConfirm,
  useSvSort,
} from './settings-ui.js';
import { VNextUsageSummaryPanels } from './VNextUsageSummaryPanels.js';

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

type SortKey = 'totalCostUsd' | 'totalTokens' | 'eventCount';

export function VNextAiKeysAdminPanel() {
  const api = useApi();
  const [rangeDays, setRangeDays] = useState<number>(30);
  const [selected, setSelected] = useState<AdminTenantUsageRow | null>(null);
  const sort = useSvSort<SortKey>('totalCostUsd');

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
    const joined = (tenants.data ?? []).map(
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
    const key = sort.key ?? 'totalCostUsd';
    return [...joined].sort((a, b) => (sort.dir === 'desc' ? b[key] - a[key] : a[key] - b[key]));
  }, [tenants.data, usage.data, sort.key, sort.dir]);

  return (
    <div className="stv-stack">
      <div className="stv-row stv-row--between">
        <span className="stv-muted">
          Estimated AI spend per tenant (hand-maintained pricing table). Open a tenant to manage
          their own provider key.
        </span>
        <SvSegmented
          aria-label="Usage range"
          value={rangeDays}
          onChange={(v) => setRangeDays(Number(v))}
          options={[
            { label: '7 days', value: 7 },
            { label: '30 days', value: 30 },
            { label: '90 days', value: 90 },
          ]}
        />
      </div>

      {tenants.isError || usage.isError ? (
        <SvCallout
          kind="error"
          title="Couldn't load tenant AI usage."
          description={apiErrorMessage(tenants.error ?? usage.error)}
        />
      ) : tenants.isLoading || usage.isLoading ? (
        <div className="stv-stack" aria-label="Loading tenant AI usage">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      ) : rows.length === 0 ? (
        <span className="stv-muted">No tenants yet</span>
      ) : (
        <CapiroTableWrap>
          <CapiroTable>
            <CapiroTableHead>
              <tr>
                <CapiroTableHeaderCell>Tenant</CapiroTableHeaderCell>
                <CapiroTableHeaderCell style={{ textAlign: 'right' }}>
                  <SvSortHeader
                    label="Est. spend"
                    active={sort.key === 'totalCostUsd'}
                    dir={sort.dir}
                    onToggle={() => sort.toggle('totalCostUsd')}
                  />
                </CapiroTableHeaderCell>
                <CapiroTableHeaderCell style={{ textAlign: 'right' }}>
                  <SvSortHeader
                    label="Tokens"
                    active={sort.key === 'totalTokens'}
                    dir={sort.dir}
                    onToggle={() => sort.toggle('totalTokens')}
                  />
                </CapiroTableHeaderCell>
                <CapiroTableHeaderCell style={{ textAlign: 'right' }}>
                  <SvSortHeader
                    label="Generations"
                    active={sort.key === 'eventCount'}
                    dir={sort.dir}
                    onToggle={() => sort.toggle('eventCount')}
                  />
                </CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Key</CapiroTableHeaderCell>
                <CapiroTableHeaderCell />
              </tr>
            </CapiroTableHead>
            <CapiroTableBody>
              {rows.map((row) => (
                <tr key={row.tenantId}>
                  <CapiroTableCell>{row.tenantName}</CapiroTableCell>
                  <CapiroTableCell style={{ textAlign: 'right' }}>
                    {fmtUsd(row.totalCostUsd)}
                  </CapiroTableCell>
                  <CapiroTableCell style={{ textAlign: 'right' }}>
                    {fmtTokens(row.totalTokens)}
                  </CapiroTableCell>
                  <CapiroTableCell style={{ textAlign: 'right' }}>{row.eventCount}</CapiroTableCell>
                  <CapiroTableCell>
                    {row.tenantKeyEventCount > 0 ? (
                      <CapiroBadge tone="success">own key</CapiroBadge>
                    ) : (
                      <CapiroBadge>Capiro shared</CapiroBadge>
                    )}
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <CapiroButton size="compact" onClick={() => setSelected(row)}>
                      Manage
                    </CapiroButton>
                  </CapiroTableCell>
                </tr>
              ))}
            </CapiroTableBody>
          </CapiroTable>
        </CapiroTableWrap>
      )}

      <CapiroDrawer
        open={Boolean(selected)}
        title={selected ? `${selected.tenantName} — AI usage & key` : 'Tenant AI usage'}
        onClose={() => setSelected(null)}
      >
        <div className="stv-drawer-wide" />
        {selected ? <TenantDrawer tenantId={selected.tenantId} from={from} /> : null}
      </CapiroDrawer>
    </div>
  );
}

function TenantDrawer({ tenantId, from }: { tenantId: string; from: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();
  const [provider, setProvider] = useState<'openai' | 'anthropic'>('openai');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyError, setApiKeyError] = useState<string | undefined>();
  const [modelOverride, setModelOverride] = useState<string | undefined>();

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
    mutationFn: async (values: {
      provider: 'openai' | 'anthropic';
      apiKey: string;
      modelOverride?: string;
    }) =>
      (
        await api.post<MaskedAiCredential>(
          `/api/capiro-admin/tenants/${tenantId}/ai-credential`,
          values,
          // Validation makes a real provider call before storing.
          { timeout: 45_000 },
        )
      ).data,
    onSuccess: (saved) => {
      toast.success(`${saved.provider} key validated and saved for this tenant`);
      setApiKey('');
      qc.invalidateQueries({ queryKey: ['capiro-admin', 'tenant-ai-credential', tenantId] });
      qc.invalidateQueries({ queryKey: ['capiro-admin', 'ai-usage'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const removeKey = useMutation({
    mutationFn: async (credProvider: string) =>
      (await api.delete(`/api/capiro-admin/tenants/${tenantId}/ai-credential/${credProvider}`))
        .data,
    onSuccess: (_data, credProvider) => {
      toast.success(`${credProvider} key removed — tenant falls back to the Capiro shared key`);
      qc.invalidateQueries({ queryKey: ['capiro-admin', 'tenant-ai-credential', tenantId] });
      qc.invalidateQueries({ queryKey: ['capiro-admin', 'ai-usage'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const submitKey = () => {
    if (!apiKey.trim()) {
      setApiKeyError('API key is required');
      return;
    }
    if (apiKey.trim().length < 8) {
      setApiKeyError('API key must be at least 8 characters');
      return;
    }
    setApiKeyError(undefined);
    saveKey.mutate({
      provider,
      apiKey: apiKey.trim(),
      ...(modelOverride ? { modelOverride } : {}),
    });
  };

  return (
    <div className="stv-stack">
      <SvCard title="Provider key">
        <div className="stv-stack stv-stack--tight">
          {(credentials.data ?? []).map((cred) => (
            <div className="stv-row" key={cred.provider}>
              <CapiroBadge tone="info">{cred.provider}</CapiroBadge>
              <code className="stv-code">•••• {cred.last4}</code>
              {cred.modelOverride ? <CapiroBadge>{cred.modelOverride}</CapiroBadge> : null}
              <CapiroBadge tone={cred.status === 'active' ? 'success' : 'warning'}>
                {cred.status}
              </CapiroBadge>
              <CapiroButton
                size="compact"
                className="stv-btn-danger"
                loading={removeKey.isPending}
                onClick={() =>
                  confirm({
                    title: `Remove the ${cred.provider} key?`,
                    body: 'The tenant falls back to the Capiro shared key.',
                    okText: 'OK',
                    danger: true,
                    onOk: () => removeKey.mutateAsync(cred.provider),
                  })
                }
              >
                Remove
              </CapiroButton>
            </div>
          ))}

          <form
            className="stv-row stv-row--start"
            onSubmit={(event) => {
              event.preventDefault();
              submitKey();
            }}
          >
            <span style={{ width: 130 }}>
              <CapiroSelect
                label="Provider"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as 'openai' | 'anthropic');
                  // The model list is provider-specific, so clear any picked model
                  // when the provider changes.
                  setModelOverride(undefined);
                }}
                options={PROVIDER_OPTIONS}
              />
            </span>
            <span style={{ width: 260 }}>
              <CapiroInput
                label="API key"
                type="password"
                placeholder="Paste API key (write-only)"
                autoComplete="off"
                error={apiKeyError}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </span>
            <span style={{ width: 200 }}>
              <CapiroSelect
                label="Model override"
                helpText="Leave as Default to use the platform default for this provider."
                value={modelOverride ?? ''}
                onChange={(e) => setModelOverride(e.target.value || undefined)}
                options={[
                  { value: '', label: 'Default model' },
                  ...MODELS_BY_PROVIDER[provider],
                ]}
              />
            </span>
            <CapiroButton
              variant="primary"
              type="submit"
              loading={saveKey.isPending}
              style={{ marginTop: 24 }}
            >
              Validate &amp; save
            </CapiroButton>
          </form>
        </div>
      </SvCard>

      {usage.isError ? (
        <SvCallout
          kind="error"
          title="Couldn't load this tenant's usage."
          description={apiErrorMessage(usage.error)}
        />
      ) : (
        <VNextUsageSummaryPanels summary={usage.data} loading={usage.isLoading} />
      )}

      {dialog}
    </div>
  );
}
