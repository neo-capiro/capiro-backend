import { describe, expect, test } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  clearEngagementPreviewQueries,
  isEngagementOwnedQuery,
  markEngagementResponseData,
} from './engagement-preview-cache.js';

function queryByHash(client: QueryClient, key: readonly unknown[]) {
  return client.getQueryCache().find({ queryKey: key });
}

describe('Engagement preview cache isolation', () => {
  test('marks response provenance without changing the payload', () => {
    const client = new QueryClient();
    const data = { rows: [1, 2, 3] };
    client.setQueryData(['mixed-page-widget'], data);
    const query = queryByHash(client, ['mixed-page-widget']);
    expect(query && isEngagementOwnedQuery(query)).toBe(false);

    markEngagementResponseData(data);
    expect(query && isEngagementOwnedQuery(query)).toBe(true);
    expect(client.getQueryData(['mixed-page-widget'])).toBe(data);
  });

  test('clears proven Engagement data and preserves unrelated cache data', async () => {
    const client = new QueryClient();
    const engagement = { meetings: 4 };
    const directory = { people: 12 };
    client.setQueryData(['mixed-engagement-widget'], engagement);
    client.setQueryData(['directory-people'], directory);
    markEngagementResponseData(engagement);

    await clearEngagementPreviewQueries(client);

    expect(client.getQueryData(['mixed-engagement-widget'])).toBeUndefined();
    expect(client.getQueryData(['directory-people'])).toBe(directory);
  });

  test.each([
    ['engagement-integrations'],
    ['engagement-meetings', '2026-08'],
    ['engagement-mail-threads'],
    ['client-meetings', 'client-1'],
    ['client-mail-threads', 'client-1'],
    ['integration-capabilities', 'google'],
  ])('recognizes reviewed pending/primitive fallback key %j', (key) => {
    const client = new QueryClient();
    client.setQueryData(key, 1);
    const query = queryByHash(client, key);
    expect(query && isEngagementOwnedQuery(query)).toBe(true);
  });

  test('negative control: broad words do not erase unrelated owner caches', () => {
    const client = new QueryClient();
    for (const key of [
      ['reports'],
      ['tasks'],
      ['attachments'],
      ['clients'],
      ['directory-members'],
      ['workspace-documents'],
    ]) {
      client.setQueryData(key, { ok: true });
      const query = queryByHash(client, key);
      expect(query && isEngagementOwnedQuery(query), JSON.stringify(key)).toBe(false);
    }
  });
});
