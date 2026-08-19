/**
 * Settings → AI Usage: a tenant admin's view of their OWN AI spend
 * (estimated; the pricing table is hand-maintained).
 *
 * Key management is READ-ONLY here by design: Capiro sets/rotates customer
 * keys from the capiro-admin console (AiKeysAdminPanel) — customers never
 * enter keys themselves. This page only shows that a key is configured
 * (masked last-4). The tenant-side write endpoints do not exist on the API.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Segmented, Space, Tag, Typography } from 'antd';
import { useApi } from '../../lib/use-api.js';
import {
  UsageSummaryPanels,
  type MaskedAiCredential,
  type TenantUsageSummary,
} from '../../components/ai-usage/UsageSummaryPanels.js';

// Extracted to ai-usage-shared.ts (UI-free) so the vNext Settings module can
// share it; re-exported here so existing importers (AiKeysAdminPanel) keep
// working unchanged.
export { apiErrorMessage } from './ai-usage-shared.js';
import { apiErrorMessage } from './ai-usage-shared.js';

export function AiUsagePage() {
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
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          AI Usage &amp; Spend
        </Typography.Title>
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

      {summary.isError ? (
        <Alert
          type="error"
          showIcon
          message="Couldn't load AI usage."
          description={apiErrorMessage(summary.error)}
          style={{ marginBottom: 16 }}
        />
      ) : (
        <UsageSummaryPanels summary={summary.data} loading={summary.isLoading} />
      )}

      <Card size="small" title="AI provider key" style={{ marginTop: 16 }}>
        {(credentials.data ?? []).length ? (
          <>
            {(credentials.data ?? []).map((cred) => (
              <Space key={cred.provider} style={{ display: 'flex', marginBottom: 8 }} wrap>
                <Tag color="blue">{cred.provider}</Tag>
                <Typography.Text code>•••• {cred.last4}</Typography.Text>
                {cred.modelOverride ? <Tag>{cred.modelOverride}</Tag> : null}
                <Tag color={cred.status === 'active' ? 'green' : 'orange'}>{cred.status}</Tag>
              </Space>
            ))}
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              Your firm&apos;s own API key is configured — generations are billed to it. Keys are
              managed by Capiro; contact your account manager to rotate or remove it.
            </Typography.Paragraph>
          </>
        ) : (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Generations run on the Capiro shared key. If you&apos;d like usage billed to your
            firm&apos;s own OpenAI or Anthropic key, contact your account manager — Capiro
            configures it for you (stored encrypted, never displayed).
          </Typography.Paragraph>
        )}
      </Card>
    </div>
  );
}
