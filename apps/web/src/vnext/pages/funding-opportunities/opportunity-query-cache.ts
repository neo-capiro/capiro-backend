import type { QueryClient } from '@tanstack/react-query';

/** A decision belongs to one record, but is visible in several existing views. */
export function refreshOpportunityQueries(client: QueryClient) {
  return Promise.all(
    [
      'funding-opportunities',
      'funding-opportunities-freshness',
      'funding-opportunity-inbox',
      'funding-opportunity-pipeline',
      'funding-opportunity-detail',
      'funding-opportunity-forecast',
      'funding-opportunity-feed',
      'funding-opportunity-feed-detail',
      'funding-opportunity-action-plan',
      'client-funding-opportunities',
      'engagement-tasks',
    ].map((key) => client.invalidateQueries({ queryKey: [key] })),
  );
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
