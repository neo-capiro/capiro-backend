/**
 * vNext re-skin of pages/settings/AiUsagePage.tsx — identical endpoints, query
 * keys and copy. Key management stays READ-ONLY by design: Capiro sets/rotates
 * customer keys from the capiro-admin console (VNextAiKeysAdminPanel) —
 * customers never enter keys themselves; the tenant-side write endpoints do
 * not exist on the API.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { apiErrorMessage } from '../../../pages/settings/ai-usage-shared.js';
import type {
  MaskedAiCredential,
  TenantUsageSummary,
} from '../../../components/ai-usage/usage-summary-shared.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { SvCallout, SvCard, SvSegmented } from './settings-ui.js';
import { VNextUsageSummaryPanels } from './VNextUsageSummaryPanels.js';

export function VNextAiUsagePage() {
  const api = useApi();
  const [rangeDays, setRangeDays] = useState<number>(30);

  const from = useMemo(
    () => new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString(),
    [rangeDays],
  );

  const summary = useQuery<TenantUsageSummary>({
    queryKey: ['ai-usage', 'summary', rangeDays],
    queryFn: async () =>
      (await api.get<TenantUsageSummary>('/api/ai-usage/summary', { params: { from } })).data,
  });

  const credentials = useQuery<MaskedAiCredential[]>({
    queryKey: ['ai-usage', 'credential'],
    queryFn: async () => (await api.get<MaskedAiCredential[]>('/api/ai-usage/credential')).data,
  });

  return (
    <div className="stv-stack">
      <div className="stv-row stv-row--between">
        <h2 className="stv-card__title" style={{ margin: 0 }}>
          AI Usage &amp; Spend
        </h2>
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

      {summary.isError ? (
        <SvCallout
          kind="error"
          title="Couldn't load AI usage."
          description={apiErrorMessage(summary.error)}
        />
      ) : (
        <VNextUsageSummaryPanels summary={summary.data} loading={summary.isLoading} />
      )}

      <SvCard title="AI provider key">
        {(credentials.data ?? []).length ? (
          <div className="stv-stack stv-stack--tight">
            {(credentials.data ?? []).map((cred) => (
              <div className="stv-row" key={cred.provider}>
                <CapiroBadge tone="info">{cred.provider}</CapiroBadge>
                <code className="stv-code">•••• {cred.last4}</code>
                {cred.modelOverride ? <CapiroBadge>{cred.modelOverride}</CapiroBadge> : null}
                <CapiroBadge tone={cred.status === 'active' ? 'success' : 'warning'}>
                  {cred.status}
                </CapiroBadge>
              </div>
            ))}
            <p className="stv-muted" style={{ margin: 0 }}>
              Your firm&apos;s own API key is configured — generations are billed to it. Keys are
              managed by Capiro; contact your account manager to rotate or remove it.
            </p>
          </div>
        ) : (
          <p className="stv-muted" style={{ margin: 0 }}>
            Generations run on the Capiro shared key. If you&apos;d like usage billed to your
            firm&apos;s own OpenAI or Anthropic key, contact your account manager — Capiro
            configures it for you (stored encrypted, never displayed).
          </p>
        )}
      </SvCard>
    </div>
  );
}
