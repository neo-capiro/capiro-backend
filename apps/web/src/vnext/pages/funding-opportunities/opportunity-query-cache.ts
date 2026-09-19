import type { QueryClient } from '@tanstack/react-query';

export const opportunityQueryKeys = {
  search: (criteria: unknown) => ['funding-opportunities-v2', criteria] as const,
  savedSearches: (clientId: string | null) => ['funding-opportunities-v2-saved', clientId] as const,
  clients: ['funding-opportunities-v2-clients'] as const,
  detail: (source: string, sourceRecordId: string, clientId: string | null, mode: 'matched' | 'all' = 'all') => ['funding-opportunity-v2-detail', source, sourceRecordId, clientId, mode] as const,
  pipeline: (clientId: string | null) => ['funding-opportunity-pipeline', clientId] as const,
  sourceHealth: ['funding-opportunities-v2-source-health'] as const,
} as const;

/** A decision belongs to one record, but is visible in several existing views. */
export function refreshOpportunityQueries(client: QueryClient, clientId?: string | null) {
  return Promise.all(
    [
      'funding-opportunities-v2',
      'funding-opportunities-v2-saved',
      'funding-opportunity-v2-detail',
      'funding-opportunity-pipeline',
      'engagement-tasks',
    ].map((key) => client.invalidateQueries({ queryKey: [key] })),
  ).then(() => clientId == null ? undefined : client.invalidateQueries({ queryKey: opportunityQueryKeys.pipeline(clientId) }));
}

export function sourceWebUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
