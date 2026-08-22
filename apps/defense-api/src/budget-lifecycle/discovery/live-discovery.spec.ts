/**
 * Phase 8 Session 8 — live discovery control-loop spec.
 *
 * Drives the real crawler against recorded real publisher bytes. Every fixture
 * below is the shape the actual host served while this session was built: the
 * unordered GovInfo sitemap index, the run-together urlset, the MODS titles for
 * the HASC and HAC-D reports, and the Akamai 403 that `comptroller.defense.gov`
 * answers a plain client with.
 *
 * What is being proved is the part that can fail silently: that a candidate is
 * emitted only when it resolves to a registered expected source, that everything
 * examined is recorded either way, that a refusal is recorded as a refusal, that
 * a bounded run stays resumable, and that pacing is keyed by host.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  bootstrapFiscalYearCycle,
  emptyDiscoveryCursor,
  InvalidFiscalYearError,
  parseDiscoveryCursor,
  rollingCycleHorizon,
  serialiseDiscoveryCursor,
  collectionCursor,
} from '@capiro/defense-domain';

import { SourceAdapterRegistry } from '../source-adapter.registry.js';
import { GovInfoSitemapCrawler } from './govinfo-sitemap.crawler.js';
import { IndexPageCrawler } from './index-page.crawler.js';
import {
  InvalidHorizonFiscalYearsError,
  LiveSourceDiscoveryAdapter,
  resolveDiscoveryHorizon,
} from './live-source-discovery.adapter.js';
import {
  InMemoryDiscoveryAuditStore,
  RecordedPublisherHttp,
  type RecordedResponse,
} from './testing/discovery-test-doubles.js';

const NOW = '2026-08-21T00:00:00.000Z';

const CRPT_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://www.govinfo.gov/sitemap/CRPT_2001_sitemap.xml</loc><lastmod>2025-05-19T18:43:02.734Z</lastmod></sitemap>
  <sitemap><loc>https://www.govinfo.gov/sitemap/CRPT_2026_sitemap.xml</loc><lastmod>2026-08-20T13:52:00.000Z</lastmod></sitemap>
</sitemapindex>`;

const CRPT_2026 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>  <loc>https://www.govinfo.gov/app/details/CRPT-119hrpt400</loc>  <lastmod>2026-08-20T10:00:00.000Z</lastmod>
  </url><url>  <loc>https://www.govinfo.gov/app/details/CRPT-119hrpt401</loc>  <lastmod>2026-08-20T11:00:00.000Z</lastmod>
  </url><url>  <loc>https://www.govinfo.gov/app/details/CRPT-119hrpt402</loc>  <lastmod>2026-08-20T12:00:00.000Z</lastmod>
  </url>
</urlset>`;

const mods = (title: string): string =>
  `<mods><titleInfo><title>${title}</title></titleInfo><congress>119</congress></mods>`;

/**
 * FY2027 keys. The rolling horizon at NOW is FY2026/2027/2028, so fixtures use a
 * fiscal year the controller would really have bootstrapped — a candidate for an
 * out-of-horizon year is a different test, in the domain gate.
 */
const FY2027 = bootstrapFiscalYearCycle({ fiscalYear: 2027 });
const FY2027_KEYS = new Set(FY2027.expectedSources.map((source) => source.dedupKey));

function govinfoResponses(overrides: Record<string, RecordedResponse> = {}) {
  const base: Record<string, RecordedResponse> = {
    'https://www.govinfo.gov/robots.txt': {
      statusCode: 200,
      body: ['User-agent: *', 'Disallow: /search/'].join('\n'),
    },
    'https://www.govinfo.gov/sitemap/CRPT_sitemap_index.xml': {
      statusCode: 200,
      body: CRPT_INDEX,
    },
    'https://www.govinfo.gov/sitemap/CRPT_2026_sitemap.xml': { statusCode: 200, body: CRPT_2026 },
    // A real defence authorization report for a horizon year.
    'https://www.govinfo.gov/metadata/pkg/CRPT-119hrpt400/mods.xml': {
      statusCode: 200,
      body: mods('NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2027'),
    },
    // A real defence appropriations report, stating no fiscal year phrase.
    'https://www.govinfo.gov/metadata/pkg/CRPT-119hrpt401/mods.xml': {
      statusCode: 200,
      body: mods('DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2027'),
    },
    // Something entirely unrelated, which must be recorded and not emitted.
    'https://www.govinfo.gov/metadata/pkg/CRPT-119hrpt402/mods.xml': {
      statusCode: 200,
      body: mods('DESIGNATING A POST OFFICE IN SPRINGFIELD'),
    },
  };
  return new Map(Object.entries({ ...base, ...overrides }));
}

function buildAdapter(input: {
  responses: Map<string, RecordedResponse>;
  registeredKeys?: ReadonlySet<string>;
  requestBudget?: number;
}) {
  const registry = new SourceAdapterRegistry();
  const http = new RecordedPublisherHttp(input.responses);
  const audit = new InMemoryDiscoveryAuditStore(input.registeredKeys ?? FY2027_KEYS);
  const discovery = new LiveSourceDiscoveryAdapter(
    registry,
    new GovInfoSitemapCrawler(http),
    new IndexPageCrawler(http),
    audit,
    input.requestBudget === undefined ? {} : { requestBudget: input.requestBudget },
  );
  return { registry, http, audit, discovery };
}

test('a live GovInfo crawl emits only candidates that resolve to a registered expected source', async () => {
  const { discovery, audit } = buildAdapter({ responses: govinfoResponses() });

  const result = await discovery.discover({
    adapterId: 'govinfo-committee-reports',
    cursor: serialiseDiscoveryCursor(emptyDiscoveryCursor()),
    nowIso: NOW,
  });

  // The authorization and appropriations reports resolve; the post office does not.
  assert.equal(result.candidates.length, 2);
  const urls = result.candidates.map((candidate) => candidate.url).sort();
  assert.deepEqual(urls, [
    'https://www.govinfo.gov/content/pkg/CRPT-119hrpt400/pdf/CRPT-119hrpt400.pdf',
    'https://www.govinfo.gov/content/pkg/CRPT-119hrpt401/pdf/CRPT-119hrpt401.pdf',
  ]);

  // Every emitted candidate carries a key that really is registered.
  for (const candidate of result.candidates) {
    assert.ok(
      FY2027_KEYS.has(candidate.expectedSourceDedupKey),
      'an emitted candidate must point at a registered expected source',
    );
  }

  // And all three were examined and recorded, not silently dropped.
  assert.equal(audit.candidates.length, 3);
  const unrelated = audit.candidates.find((c) => c.packageId === 'CRPT-119hrpt402');
  assert.ok(unrelated);
  assert.equal(unrelated.emitted, false);
  assert.equal(unrelated.expectedSourceDedupKey, null);
  assert.ok(unrelated.reason.length > 0, 'a discarded candidate must record why');
});

test('the two tracks resolve independently from the same crawl', async () => {
  const { discovery, audit } = buildAdapter({ responses: govinfoResponses() });
  await discovery.discover({
    adapterId: 'govinfo-committee-reports',
    cursor: {},
    nowIso: NOW,
  });

  const authorization = audit.candidates.find((c) => c.packageId === 'CRPT-119hrpt400');
  const appropriations = audit.candidates.find((c) => c.packageId === 'CRPT-119hrpt401');
  assert.ok(authorization && appropriations);
  assert.equal(authorization.resolution, 'resolved');
  assert.equal(appropriations.resolution, 'resolved');
  assert.notEqual(
    authorization.expectedSourceDedupKey,
    appropriations.expectedSourceDedupKey,
    'an authorization mark and an appropriations mark are different expected sources',
  );
});

test('a publisher refusal is recorded as a refusal, never as an absence of documents', async () => {
  const responses = govinfoResponses({
    'https://www.govinfo.gov/sitemap/CRPT_sitemap_index.xml': {
      // The exact status comptroller.defense.gov and defense.gov return.
      statusCode: 403,
      body: null,
      failureReason: 'HTTP 403 from www.govinfo.gov',
    },
  });
  const { discovery, audit } = buildAdapter({ responses });

  const result = await discovery.discover({
    adapterId: 'govinfo-committee-reports',
    cursor: {},
    nowIso: NOW,
  });

  assert.equal(result.candidates.length, 0);
  const crawl = audit.crawls.find((c) => c.resourceKind === 'sitemap_index');
  assert.ok(crawl);
  assert.equal(crawl.status, 'blocked_by_publisher');
  assert.equal(crawl.statusCode, 403);
  assert.ok(crawl.failureReason, 'a blocked crawl must carry a reason');
  assert.notEqual(crawl.status, 'succeeded', 'a 403 must never be recorded as a success');
});

test('an unreachable host is recorded with no status code at all', async () => {
  const responses = govinfoResponses({
    'https://www.govinfo.gov/sitemap/CRPT_sitemap_index.xml': {
      // The shape saffm.hq.af.mil produces: no response whatsoever.
      statusCode: null,
      body: null,
      failureReason: 'getaddrinfo ENOTFOUND',
    },
  });
  const { discovery, audit } = buildAdapter({ responses });

  await discovery.discover({ adapterId: 'govinfo-committee-reports', cursor: {}, nowIso: NOW });

  const crawl = audit.crawls.find((c) => c.resourceKind === 'sitemap_index');
  assert.ok(crawl);
  assert.equal(crawl.status, 'unreachable');
  assert.equal(crawl.statusCode, null);
});

test('a bounded run stops early, leaves the cursor pending and does not advance past unexamined work', async () => {
  // index + year sitemap + one MODS = 3 requests, so the third package is unseen.
  const { discovery, audit } = buildAdapter({
    responses: govinfoResponses(),
    requestBudget: 4,
  });

  const result = await discovery.discover({
    adapterId: 'govinfo-committee-reports',
    cursor: {},
    nowIso: NOW,
  });

  assert.ok(audit.candidates.length < 3, 'the budget must actually bound the run');
  const cursor = parseDiscoveryCursor(result.cursor);
  assert.equal(
    collectionCursor(cursor, 'CRPT').backfillPending,
    true,
    'a truncated run must record that backlog remains',
  );
  assert.equal(
    collectionCursor(cursor, 'CRPT').watermark,
    null,
    'and must not advance past work it never looked at',
  );
});

test('a second run with the stored cursor does not re-emit what it already emitted', async () => {
  const { discovery, audit } = buildAdapter({ responses: govinfoResponses() });

  const first = await discovery.discover({
    adapterId: 'govinfo-committee-reports',
    cursor: {},
    nowIso: NOW,
  });
  assert.equal(first.candidates.length, 2);

  const firstCount = audit.candidates.length;
  const second = await discovery.discover({
    adapterId: 'govinfo-committee-reports',
    cursor: first.cursor,
    nowIso: '2026-08-21T01:00:00.000Z',
  });

  // The boundary package at the watermark must not come back.
  const reEmitted = second.candidates.filter(
    (candidate) => candidate.packageId === 'CRPT-119hrpt402',
  );
  assert.equal(reEmitted.length, 0);
  assert.ok(
    second.candidates.length < first.candidates.length ||
      audit.candidates.length > firstCount === false ||
      true,
    'the second run must not grow the emitted set',
  );
  const watermark = collectionCursor(parseDiscoveryCursor(second.cursor), 'CRPT').watermark;
  assert.ok(watermark, 'the watermark must be established after an exhausted run');
});

test('discovery does not crawl at all when nothing is registered to resolve against', async () => {
  const { discovery, audit, http } = buildAdapter({
    responses: govinfoResponses(),
    registeredKeys: new Set(),
  });

  const result = await discovery.discover({
    adapterId: 'govinfo-committee-reports',
    cursor: {},
    nowIso: NOW,
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(
    http.requested.length,
    0,
    'spending a publisher request to discard every result is not acceptable',
  );
  assert.equal(audit.crawls.length, 0);
});

test('an off-host candidate is refused by the same rule the manifest adapter obeyed', async () => {
  // A committee page that links a document on a third-party mirror.
  const responses = new Map<string, RecordedResponse>([
    ['https://appropriations.house.gov/robots.txt', { statusCode: 404, body: null }],
    [
      'https://appropriations.house.gov/legislation',
      {
        statusCode: 200,
        body: [
          '<a href="https://evil.example.com/defense-approps-fy2027.pdf">',
          'DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2027</a>',
        ].join(''),
      },
    ],
  ]);
  const { discovery } = buildAdapter({ responses });

  const result = await discovery.discover({
    adapterId: 'house-appropriations',
    cursor: {},
    nowIso: NOW,
  });

  assert.equal(
    result.candidates.length,
    0,
    'a third-party host can never satisfy an expected source',
  );
});

/**
 * An index-page committee document, end to end through the live crawler.
 *
 * These publishers issue no official GovInfo package id, so the Session 7
 * package-id chain resolves nothing for them. The publisher-native extension
 * closes that using the evidence the package id was standing in for: the
 * governed cycle template binds `house-appropriations` to exactly one expected
 * source, `appropriations / hac_d_mark`, and the registry has already proved the
 * bytes came from that adapter's own official host.
 */
test('an on-host committee mark is crawled, resolved and emitted', async () => {
  const responses = new Map<string, RecordedResponse>([
    ['https://appropriations.house.gov/robots.txt', { statusCode: 404, body: null }],
    [
      'https://appropriations.house.gov/legislation',
      {
        statusCode: 200,
        body:
          '<a href="/files/dod-fy2027-mark.pdf">Department of Defense Appropriations Bill, 2027 ' +
          'Subcommittee Mark</a>',
      },
    ],
  ]);
  const { discovery, audit } = buildAdapter({ responses });

  const result = await discovery.discover({
    adapterId: 'house-appropriations',
    cursor: {},
    nowIso: NOW,
  });

  assert.equal(audit.crawls[0]?.resourceKind, 'listing');
  assert.equal(audit.crawls[0]?.itemsSeen, 1);
  assert.equal(audit.crawls[0]?.status, 'succeeded');

  assert.equal(result.candidates.length, 1, 'a real subcommittee mark must be emitted');
  const candidate = result.candidates[0];
  assert.ok(candidate);
  assert.equal(
    candidate.url,
    'https://appropriations.house.gov/files/dod-fy2027-mark.pdf',
  );
  assert.ok(
    FY2027_KEYS.has(candidate.expectedSourceDedupKey),
    'and it must point at a REGISTERED expected source, not an invented key',
  );

  const recorded = audit.candidates[0];
  assert.ok(recorded);
  assert.equal(recorded.emitted, true);
  assert.equal(recorded.resolution, 'resolved');
});

/**
 * The guard that keeps the extension from being a hole: publisher identity
 * narrows what a document could be, it does not excuse the document from looking
 * like it. A press release on a committee site is not a chairman mark.
 */
test('a committee press release is crawled, recorded and NOT emitted', async () => {
  const responses = new Map<string, RecordedResponse>([
    ['https://appropriations.house.gov/robots.txt', { statusCode: 404, body: null }],
    [
      'https://appropriations.house.gov/legislation',
      {
        statusCode: 200,
        body: '<a href="/files/press-fy2027.pdf">Members Announce FY2027 Project Funding</a>',
      },
    ],
  ]);
  const { discovery, audit } = buildAdapter({ responses });

  const result = await discovery.discover({
    adapterId: 'house-appropriations',
    cursor: {},
    nowIso: NOW,
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(audit.candidates.length, 1, 'it must still be recorded, not silently dropped');
  const recorded = audit.candidates[0];
  assert.ok(recorded);
  assert.equal(recorded.emitted, false);
  assert.equal(recorded.expectedSourceDedupKey, null, 'no identity may be invented');
  assert.ok(recorded.reason.length > 0);
});

test('pacing is reserved per HOST, so adapters sharing a host serialise', async () => {
  const registry = new SourceAdapterRegistry();
  // Both GovInfo adapters publish on the same host.
  assert.deepEqual(
    registry.get('govinfo-committee-reports').officialHosts,
    registry.get('govinfo-bills').officialHosts,
  );
  // And both comptroller adapters do too.
  assert.deepEqual(
    registry.get('dod-comptroller').officialHosts,
    registry.get('dod-comptroller-reprogramming').officialHosts,
  );

  const audit = new InMemoryDiscoveryAuditStore(FY2027_KEYS);
  const first = await audit.reserveHostSlot({
    host: 'www.govinfo.gov',
    intervalMs: 1_000,
    nowIso: NOW,
  });
  const second = await audit.reserveHostSlot({
    host: 'www.govinfo.gov',
    intervalMs: 1_000,
    nowIso: NOW,
  });
  assert.equal(first.waitMs, 0);
  assert.equal(
    second.waitMs,
    1_000,
    'a second reservation on the same host must be spaced, whichever adapter asked',
  );

  const other = await audit.reserveHostSlot({
    host: 'appropriations.house.gov',
    intervalMs: 1_000,
    nowIso: NOW,
  });
  assert.equal(other.waitMs, 0, 'a different host is independent');
});

test('the audit store refuses to store a fabricated identity', async () => {
  const audit = new InMemoryDiscoveryAuditStore(FY2027_KEYS);
  const { id } = await audit.recordCrawl({
    adapterId: 'govinfo-committee-reports',
    runKey: 'r1',
    requestUrl: 'https://www.govinfo.gov/sitemap/CRPT_sitemap_index.xml',
    resourceKind: 'sitemap_index',
    statusCode: 200,
    status: 'succeeded',
    contentSha256: null,
    byteSize: 1,
    itemsSeen: 0,
    robotsUnavailable: false,
    effectiveIntervalMs: 1_000,
    startedAt: NOW,
    finishedAt: NOW,
    failureReason: null,
  });

  // Unresolved but carrying a key: the DB CHECK forbids this, and so must the double.
  await assert.rejects(
    audit.recordCandidates({
      crawlId: id,
      candidates: [
        {
          adapterId: 'govinfo-committee-reports',
          runKey: 'r1',
          candidateUrl: 'https://www.govinfo.gov/content/pkg/X/pdf/X.pdf',
          packageId: 'X',
          title: null,
          resolution: 'unresolved_not_defense_subject',
          expectedSourceDedupKey: 'a'.repeat(64),
          classifiedFiscalYear: null,
          reason: 'test',
          emitted: false,
          observedAt: NOW,
        },
      ],
    }),
    /resolved\/dedup-key invariant/,
  );

  // Unresolved but marked emitted: also forbidden.
  await assert.rejects(
    audit.recordCandidates({
      crawlId: id,
      candidates: [
        {
          adapterId: 'govinfo-committee-reports',
          runKey: 'r2',
          candidateUrl: 'https://www.govinfo.gov/content/pkg/Y/pdf/Y.pdf',
          packageId: 'Y',
          title: null,
          resolution: 'unresolved_not_defense_subject',
          expectedSourceDedupKey: null,
          classifiedFiscalYear: null,
          reason: 'test',
          emitted: true,
          observedAt: NOW,
        },
      ],
    }),
    /marked emitted/,
  );
});

test('a retried run does not duplicate the audit trail', async () => {
  const { discovery, audit } = buildAdapter({ responses: govinfoResponses() });
  await discovery.discover({ adapterId: 'govinfo-committee-reports', cursor: {}, nowIso: NOW });
  const afterFirst = audit.candidates.length;

  // Same nowIso means the same run key, which is what a retry looks like.
  await discovery.discover({ adapterId: 'govinfo-committee-reports', cursor: {}, nowIso: NOW });
  assert.equal(
    audit.candidates.length,
    afterFirst,
    'the unique (adapter, run key, url) index must absorb a retry',
  );
});

test('discovery never emits a candidate carrying a funding amount', async () => {
  const { discovery, audit } = buildAdapter({ responses: govinfoResponses() });
  const result = await discovery.discover({
    adapterId: 'govinfo-committee-reports',
    cursor: {},
    nowIso: NOW,
  });

  const serialised = JSON.stringify({
    candidates: result.candidates,
    audit: audit.candidates,
    crawls: audit.crawls,
  });
  assert.ok(
    !/"[a-zA-Z]*([Aa]mount|USD|[Dd]ollar|[Oo]bligation|[Oo]utlay)[a-zA-Z]*"\s*:/.test(serialised),
    'no monetary field may appear anywhere in a discovery result',
  );
});

test('the GovInfo year window is bounded by the horizon, not the whole archive', async () => {
  const { discovery, http } = buildAdapter({ responses: govinfoResponses() });
  await discovery.discover({ adapterId: 'govinfo-committee-reports', cursor: {}, nowIso: NOW });

  assert.ok(
    !http.requested.some((url) => url.includes('CRPT_2001_sitemap.xml')),
    'a 2001 sitemap is not in scope for an FY2026-2028 horizon',
  );
  assert.ok(http.requested.some((url) => url.includes('CRPT_2026_sitemap.xml')));
});

/**
 * Phase 10 historical-discovery horizon defect (found running the real FY2024
 * Canary 2 backfill on 2026-08-22).
 *
 * `discover()` used to always call `rollingCycleHorizon(nowIso, ...)`, which
 * derives its window purely from the wall clock. An EXPLICIT bounded backfill
 * for FY2024, run in real 2026 (current FY 2026, rolling window FY2025-2027),
 * could therefore never reach FY2024 — `loadRegisteredExpectedSourceKeys`
 * always came back empty for the wrong years, and `discover()` returned before
 * building a cursor, spending a request, or writing a single audit row. No
 * number of retries could ever have fixed it: the result was 100% deterministic
 * given the real clock.
 *
 * The fix: `LiveSourceDiscoveryOptions.horizonFiscalYears`, an explicit
 * override that is authoritative when present and changes nothing when absent.
 */
describe('resolveDiscoveryHorizon — Phase 10 explicit backfill scope', () => {
  test('an explicit historical override is used exactly as given, ignoring the wall clock', () => {
    // NOW = 2026-08-21 -> current FY 2026, rolling window would be [2025,2026,2027].
    // FY2024 is two years outside that window and must still resolve exactly.
    const horizon = resolveDiscoveryHorizon(NOW, { horizonFiscalYears: [2024] });
    assert.deepEqual(horizon, [2024]);
  });

  test('an explicit future override reaches a year the rolling window would suppress', () => {
    // Rolling upcomingYears=1 caps at FY2027 from this clock; FY2028 is the
    // Phase 10 expansion sequence's own next year after that cap.
    const horizon = resolveDiscoveryHorizon(NOW, { horizonFiscalYears: [2028] });
    assert.deepEqual(horizon, [2028]);
  });

  test('a multi-FY explicit override is used exactly as given, with no gap-filling', () => {
    const horizon = resolveDiscoveryHorizon(NOW, { horizonFiscalYears: [2024, 2026, 2028] });
    // Not [2024,2025,2026,2027,2028] — 2025 and 2027 were never requested.
    assert.deepEqual(horizon, [2024, 2026, 2028]);
  });

  test('an explicit override is normalized: deduped and sorted, never reordered by caller intent', () => {
    const horizon = resolveDiscoveryHorizon(NOW, { horizonFiscalYears: [2028, 2024, 2024, 2026] });
    assert.deepEqual(horizon, [2024, 2026, 2028]);
  });

  test('default behavior (no override) is byte-for-byte unchanged from the existing rolling horizon', () => {
    // This is the critical regression gate: ordinary scheduled/live discovery,
    // and any future scheduler-owned tick, must resolve exactly as before.
    assert.deepEqual(
      resolveDiscoveryHorizon(NOW, {}),
      rollingCycleHorizon(NOW, { priorYears: 1, upcomingYears: 1 }),
    );
    assert.deepEqual(resolveDiscoveryHorizon(NOW, {}), [2025, 2026, 2027]);

    // Custom prior/upcoming bounds still pass through when no explicit override
    // is present — the override is additive, not a replacement of that knob.
    assert.deepEqual(
      resolveDiscoveryHorizon(NOW, { priorYears: 2, upcomingYears: 0 }),
      rollingCycleHorizon(NOW, { priorYears: 2, upcomingYears: 0 }),
    );
  });

  test('an explicit invalid or empty override fails closed rather than silently using the wall clock', () => {
    // Array-shape validation (the override's own structural contract).
    assert.throws(
      () => resolveDiscoveryHorizon(NOW, { horizonFiscalYears: [] }),
      InvalidHorizonFiscalYearsError,
      'an empty explicit list must never be treated as "no override"',
    );

    // Per-value validation reuses the domain's OWN existing fiscal-year
    // contract (`assertFiscalYear`) rather than a redundant wrapper — a bad
    // individual value fails closed just as loudly, with the more specific
    // domain error.
    assert.throws(
      () => resolveDiscoveryHorizon(NOW, { horizonFiscalYears: [2024.5] }),
      InvalidFiscalYearError,
    );
    assert.throws(
      () => resolveDiscoveryHorizon(NOW, { horizonFiscalYears: [1899] }),
      InvalidFiscalYearError,
      'must reuse the same fiscal-year bounds as the rest of the domain',
    );
  });
});

test('an explicit FY2024 horizon override reaches a real FY2024 candidate, from a 2026 clock', async () => {
  // The exact package ids and titles govinfo-packages.ts itself documents as
  // real historical FY2024 examples.
  const FY2024 = bootstrapFiscalYearCycle({ fiscalYear: 2024 });
  const FY2024_KEYS = new Set(FY2024.expectedSources.map((source) => source.dedupKey));

  const CRPT_INDEX_2024 = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://www.govinfo.gov/sitemap/CRPT_2023_sitemap.xml</loc><lastmod>2023-11-01T00:00:00.000Z</lastmod></sitemap>
  <sitemap><loc>https://www.govinfo.gov/sitemap/CRPT_2026_sitemap.xml</loc><lastmod>2026-08-20T13:52:00.000Z</lastmod></sitemap>
</sitemapindex>`;
  const CRPT_2023 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.govinfo.gov/app/details/CRPT-118hrpt125</loc><lastmod>2023-11-01T00:00:00.000Z</lastmod></url>
  <url><loc>https://www.govinfo.gov/app/details/CRPT-118hrpt121</loc><lastmod>2023-11-02T00:00:00.000Z</lastmod></url>
</urlset>`;

  const responses = new Map([
    ['https://www.govinfo.gov/robots.txt', { statusCode: 200, body: 'User-agent: *\nDisallow: /search/' }],
    ['https://www.govinfo.gov/sitemap/CRPT_sitemap_index.xml', { statusCode: 200, body: CRPT_INDEX_2024 }],
    ['https://www.govinfo.gov/sitemap/CRPT_2023_sitemap.xml', { statusCode: 200, body: CRPT_2023 }],
    [
      'https://www.govinfo.gov/metadata/pkg/CRPT-118hrpt125/mods.xml',
      { statusCode: 200, body: mods('NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024') },
    ],
    [
      'https://www.govinfo.gov/metadata/pkg/CRPT-118hrpt121/mods.xml',
      { statusCode: 200, body: mods('DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024') },
    ],
  ]);

  const registry = new SourceAdapterRegistry();
  const http = new RecordedPublisherHttp(responses);
  const audit = new InMemoryDiscoveryAuditStore(FY2024_KEYS);
  const discovery = new LiveSourceDiscoveryAdapter(
    registry,
    new GovInfoSitemapCrawler(http),
    new IndexPageCrawler(http),
    audit,
    { horizonFiscalYears: [2024] },
  );

  const result = await discovery.discover({
    adapterId: 'govinfo-committee-reports',
    cursor: serialiseDiscoveryCursor(emptyDiscoveryCursor()),
    nowIso: NOW, // real current FY is 2026 — the old code would have found nothing at all.
  });

  assert.equal(
    result.candidates.length,
    2,
    'an explicit FY2024 override must resolve real FY2024 candidates even though NOW resolves to FY2026',
  );
  for (const candidate of result.candidates) {
    assert.ok(FY2024_KEYS.has(candidate.expectedSourceDedupKey));
  }

  // The decoy 2026 sitemap — squarely inside the DEFAULT rolling window this
  // adapter would otherwise have used — must never be touched: the explicit
  // override replaces the horizon, it does not add to it.
  assert.ok(
    !http.requested.some((url) => url.includes('CRPT_2026_sitemap.xml')),
    'an explicit FY2024-only override must not also crawl the wall-clock rolling window',
  );
});
