import assert from 'node:assert/strict';
import test from 'node:test';

import { ManifestSourceDiscoveryAdapter } from './manifest-source-discovery.adapter.js';
import { SourceAdapterRegistry } from './source-adapter.registry.js';

const registry = new SourceAdapterRegistry();

function manifest(entries: readonly Record<string, unknown>[]) {
  return {
    schemaVersion: 'phase8_session7_discovery_manifest_v1' as const,
    entries: entries.map((entry) => ({
      adapterId: 'govinfo-bills',
      expectedSourceDedupKey: 'govinfo-bills:fy2027:hr1',
      url: 'https://www.govinfo.gov/content/pkg/BILLS-119hr1ih/html/BILLS-119hr1ih.htm',
      ...entry,
    })),
  };
}

test('excludes a candidate that is not yet available', async () => {
  const adapter = new ManifestSourceDiscoveryAdapter(registry);
  adapter.load(
    manifest([
      { availableFrom: '2026-09-26T00:00:00.000Z' },
      {
        expectedSourceDedupKey: 'govinfo-bills:fy2026:hr2',
        availableFrom: '2026-09-24T00:00:00.000Z',
      },
    ]),
  );

  const result = await adapter.discover({
    adapterId: 'govinfo-bills',
    cursor: {},
    nowIso: '2026-09-25T00:00:00.000Z',
  });

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.expectedSourceDedupKey),
    ['govinfo-bills:fy2026:hr2'],
  );
});

test('rejects malformed non-null availableFrom values during manifest load', () => {
  const adapter = new ManifestSourceDiscoveryAdapter(registry);
  assert.throws(
    () => adapter.load(manifest([{ availableFrom: 'publisher-not-a-timestamp' }])),
    /Invalid availableFrom/,
  );
});
