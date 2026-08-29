/**
 * Phase 10B-6A — comptroller.war.gov successor-host migration, application
 * boundary regression.
 *
 * The domain-level resolver tests in
 * `scripts/test-phase10b5-expected-source-resolution-domain.mjs` already
 * prove `resolveExpectedSourceDocument` accepts the successor host and
 * rejects everything else. This spec proves the SAME migration flows
 * correctly through the two REAL application-level boundaries a resolved
 * candidate must still pass before any byte becomes evidence:
 *
 *   1. `SourceAdapterRegistry.assertAuthoritativeHost()` — the fail-closed
 *      gate `DefenseBudgetLifecycleWatcher` calls on every candidate
 *      (`lifecycle-watcher.service.ts` line ~302) before it is ever fetched.
 *   2. `HttpsPublisherHttpAdapter`'s own `allowedHosts` check inside
 *      `rawGet()` — the fetch-time gate, independent of #1, that a redirect
 *      cannot bypass (`redirect: 'manual'` plus an explicit per-hop
 *      allowlist check).
 *
 * No live internet: `globalThis.fetch` is stubbed, matching the existing
 * `https-publisher-pacing.spec.ts` fixture pattern in this same directory.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SourceAdapterRegistry, NonOfficialSourceHostError } from './source-adapter.registry.js';
import { HttpsPublisherHttpAdapter } from './discovery/https-publisher-http.adapter.js';

const WAR_GOV_R1_URL =
  'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf';
const DEFENSE_GOV_R1_URL =
  'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf';

function fakePdfResponse(): Response {
  return {
    status: 200,
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as Response;
}

test('registry: successor host comptroller.war.gov is accepted for dod-comptroller', () => {
  const registry = new SourceAdapterRegistry();
  const parsed = registry.assertAuthoritativeHost('dod-comptroller', WAR_GOV_R1_URL);
  assert.equal(parsed.hostname, 'comptroller.war.gov');
});

test('registry: historical host comptroller.defense.gov remains accepted (provenance preserved)', () => {
  const registry = new SourceAdapterRegistry();
  const parsed = registry.assertAuthoritativeHost('dod-comptroller', DEFENSE_GOV_R1_URL);
  assert.equal(parsed.hostname, 'comptroller.defense.gov');
});

test('registry: dod-comptroller officialHosts includes exactly the two approved hostnames, no wildcard', () => {
  const registry = new SourceAdapterRegistry();
  const adapter = registry.get('dod-comptroller');
  assert.deepEqual(
    [...adapter.officialHosts].sort(),
    ['comptroller.defense.gov', 'comptroller.war.gov'].sort(),
  );
  assert.equal(adapter.preferredRetrievalHost, 'comptroller.war.gov');
});

test('registry: unrelated .war.gov host is rejected for dod-comptroller', () => {
  const registry = new SourceAdapterRegistry();
  assert.throws(
    () => registry.assertAuthoritativeHost('dod-comptroller', 'https://army.war.gov/x.pdf'),
    NonOfficialSourceHostError,
  );
});

test('registry: arbitrary subdomain of the approved successor host is rejected (exact hostname only)', () => {
  const registry = new SourceAdapterRegistry();
  assert.throws(
    () =>
      registry.assertAuthoritativeHost(
        'dod-comptroller',
        'https://cdn.comptroller.war.gov/x.pdf',
      ),
    NonOfficialSourceHostError,
  );
});

test('registry: plain HTTP on an otherwise-official host is rejected', () => {
  const registry = new SourceAdapterRegistry();
  assert.throws(
    () =>
      registry.assertAuthoritativeHost(
        'dod-comptroller',
        'http://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
      ),
    NonOfficialSourceHostError,
  );
});

test('registry: third-party mirror is rejected even with an identical path shape', () => {
  const registry = new SourceAdapterRegistry();
  assert.throws(
    () =>
      registry.assertAuthoritativeHost(
        'dod-comptroller',
        'https://govinfo-mirror.example.org/defbudget/FY2024/FY2024_r1.pdf',
      ),
    NonOfficialSourceHostError,
  );
});

test('registry: an official host belonging to a DIFFERENT adapter does not count for dod-comptroller', () => {
  const registry = new SourceAdapterRegistry();
  // asafm.army.mil is army-budget's official host, not dod-comptroller's.
  assert.throws(
    () => registry.assertAuthoritativeHost('dod-comptroller', 'https://asafm.army.mil/x.pdf'),
    NonOfficialSourceHostError,
  );
});

test('fetch boundary: the successor host candidate URL flows through HttpsPublisherHttpAdapter.get() to a 200', async () => {
  const registry = new SourceAdapterRegistry();
  const adapter = registry.get('dod-comptroller');
  const originalFetch = globalThis.fetch;
  let requestedUrl: string | null = null;
  globalThis.fetch = (async (url: string) => {
    requestedUrl = String(url);
    return fakePdfResponse();
  }) as unknown as typeof fetch;

  try {
    // Same validation the lifecycle watcher performs before ever fetching.
    registry.assertAuthoritativeHost('dod-comptroller', WAR_GOV_R1_URL);

    const httpAdapter = new HttpsPublisherHttpAdapter({
      minRequestIntervalMs: () => 0,
    });
    const result = await httpAdapter.get({
      url: WAR_GOV_R1_URL,
      adapterId: 'dod-comptroller',
      allowedHosts: adapter.officialHosts,
      nowIso: '2026-08-29T00:00:00.000Z',
    });

    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    assert.equal(requestedUrl, WAR_GOV_R1_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch boundary: a candidate URL outside the adapter allowlist is refused BEFORE any network call', async () => {
  const registry = new SourceAdapterRegistry();
  const adapter = registry.get('dod-comptroller');
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return fakePdfResponse();
  }) as unknown as typeof fetch;

  try {
    const httpAdapter = new HttpsPublisherHttpAdapter({
      minRequestIntervalMs: () => 0,
    });
    const result = await httpAdapter.get({
      url: 'https://army.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
      adapterId: 'dod-comptroller',
      allowedHosts: adapter.officialHosts,
      nowIso: '2026-08-29T00:00:00.000Z',
    });

    assert.equal(result.ok, false);
    assert.match(result.failureReason ?? '', /refusing host outside the adapter allowlist/);
    assert.equal(fetchCalled, false, 'a non-allowlisted host must never reach fetch()');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch boundary: a redirect from the successor host to a non-allowlisted host is refused, not followed', async () => {
  const registry = new SourceAdapterRegistry();
  const adapter = registry.get('dod-comptroller');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url) === WAR_GOV_R1_URL) {
      return {
        status: 302,
        ok: false,
        headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'https://evil-mirror.example.net/FY2024_r1.pdf' : null) },
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;

  try {
    const httpAdapter = new HttpsPublisherHttpAdapter({
      minRequestIntervalMs: () => 0,
    });
    const result = await httpAdapter.get({
      url: WAR_GOV_R1_URL,
      adapterId: 'dod-comptroller',
      allowedHosts: adapter.officialHosts,
      nowIso: '2026-08-29T00:00:00.000Z',
    });

    assert.equal(result.ok, false);
    assert.match(result.failureReason ?? '', /redirect leaves the adapter allowlist/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
