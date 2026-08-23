/**
 * Phase 10 — GovInfo bounded-crawl resumability, crawler-level integration tests.
 *
 * Complements `crawl-cursor.spec.ts` (pure domain algebra) by driving the real
 * `GovInfoSitemapCrawler` + `LiveSourceDiscoveryAdapter` against a synthetic
 * PLAW collection sized so it CANNOT complete within one configured request
 * budget — exactly the shape of the real FY2024 production backlog
 * (`request budget exhausted while resolving PLAW-118publ246`, four identical
 * 250-request passes, zero net progress before this fix).
 *
 * Covers Phase 10 required test coverage A, B, D, E from the implementation
 * brief. C (idempotent replay) and F (horizon regression) are already proven
 * in `live-discovery.spec.ts`; G (Canary 1 network-free bootstrap) is proven in
 * `phase9-job-runtime.spec.ts`.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  bootstrapFiscalYearCycle,
  collectionCursor,
  emptyDiscoveryCursor,
  hasPendingBackfill,
  parseDiscoveryCursor,
  serialiseDiscoveryCursor,
} from '@capiro/defense-domain';

import { SourceAdapterRegistry } from '../source-adapter.registry.js';
import { GovInfoSitemapCrawler } from './govinfo-sitemap.crawler.js';
import { IndexPageCrawler } from './index-page.crawler.js';
import { LiveSourceDiscoveryAdapter } from './live-source-discovery.adapter.js';
import {
  InMemoryDiscoveryAuditStore,
  RecordedPublisherHttp,
  type RecordedResponse,
} from './testing/discovery-test-doubles.js';

const NOW = '2026-08-23T00:00:00.000Z';

const FY2024 = bootstrapFiscalYearCycle({ fiscalYear: 2024 });
const FY2024_KEYS = new Set(FY2024.expectedSources.map((source) => source.dedupKey));

/** A real continuing-resolution title, matching CONTINUING_RESOLUTION_PATTERN. */
const CR_TITLE = 'Further Additional Continuing Appropriations Act, 2024';
const mods = (title: string): string =>
  `<mods><titleInfo><title>${title}</title></titleInfo><congress>118</congress></mods>`;

/** Seven synthetic PLAW packages — a backlog too large for a small budget. */
const PACKAGE_IDS = [
  'PLAW-118publ100',
  'PLAW-118publ101',
  'PLAW-118publ102',
  'PLAW-118publ103',
  'PLAW-118publ104',
  'PLAW-118publ105',
  'PLAW-118publ106',
];

function plawSitemapIndex(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://www.govinfo.gov/sitemap/PLAW_2024_sitemap.xml</loc><lastmod>2024-11-01T00:00:00.000Z</lastmod></sitemap>
</sitemapindex>`;
}

function plawYearSitemap(packageIds: readonly string[]): string {
  const urls = packageIds
    .map(
      (id, index) =>
        `<url><loc>https://www.govinfo.gov/app/details/${id}</loc><lastmod>2024-11-0${
          1 + index
        }T00:00:00.000Z</lastmod></url>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

function baseResponses(packageIds: readonly string[] = PACKAGE_IDS): Map<string, RecordedResponse> {
  const entries: [string, RecordedResponse][] = [
    ['https://www.govinfo.gov/robots.txt', { statusCode: 200, body: 'User-agent: *\nDisallow: /search/' }],
    [
      'https://www.govinfo.gov/sitemap/PLAW_sitemap_index.xml',
      { statusCode: 200, body: plawSitemapIndex() },
    ],
    [
      'https://www.govinfo.gov/sitemap/PLAW_2024_sitemap.xml',
      { statusCode: 200, body: plawYearSitemap(packageIds) },
    ],
  ];
  for (const id of packageIds) {
    entries.push([
      `https://www.govinfo.gov/metadata/pkg/${id}/mods.xml`,
      { statusCode: 200, body: mods(CR_TITLE) },
    ]);
  }
  return new Map(entries);
}

function buildAdapter(input: { responses: Map<string, RecordedResponse>; requestBudget: number }) {
  const registry = new SourceAdapterRegistry();
  const http = new RecordedPublisherHttp(input.responses);
  const audit = new InMemoryDiscoveryAuditStore(FY2024_KEYS);
  const discovery = new LiveSourceDiscoveryAdapter(
    registry,
    new GovInfoSitemapCrawler(http),
    new IndexPageCrawler(http),
    audit,
    { requestBudget: input.requestBudget, horizonFiscalYears: [2024] },
  );
  return { registry, http, audit, discovery };
}

describe('Phase 10 — A. multi-run bounded progression', () => {
  test('a backlog too large for one budget advances a durable in-progress checkpoint across passes, never restarting, until genuine exhaustion', async () => {
    // index(1) + PLAW year sitemap(1) + 3 MODS fetches = 5.
    const budget = 5;
    const { discovery, http } = buildAdapter({ responses: baseResponses(), requestBudget: budget });

    // ── Pass 1 ────────────────────────────────────────────────────────────
    const pass1 = await discovery.discover({
      adapterId: 'govinfo-public-laws',
      cursor: serialiseDiscoveryCursor(emptyDiscoveryCursor()),
      nowIso: NOW,
    });
    const cursor1 = parseDiscoveryCursor(pass1.cursor);
    const state1 = collectionCursor(cursor1, 'PLAW');
    assert.equal(state1.backfillPending, true, 'pass 1 must leave the collection pending');
    assert.equal(state1.watermark, null, 'the durable watermark must not move on an unfinished pass');
    assert.ok(state1.resumeAfterPackageId, 'pass 1 must record an in-progress checkpoint');
    assert.equal(
      state1.resumeAfterPackageId,
      'PLAW-118publ102',
      'exactly 3 of the 5-request budget went to MODS fetches (100,101,102) after index+sitemap',
    );
    // Only the first 3 packages were ever fetched.
    const modsRequestedPass1 = http.requested.filter((url) => url.includes('/metadata/pkg/'));
    assert.deepEqual(modsRequestedPass1, [
      'https://www.govinfo.gov/metadata/pkg/PLAW-118publ100/mods.xml',
      'https://www.govinfo.gov/metadata/pkg/PLAW-118publ101/mods.xml',
      'https://www.govinfo.gov/metadata/pkg/PLAW-118publ102/mods.xml',
    ]);

    // ── Pass 2: resumes after pass 1, does NOT restart from the beginning ──
    const requestedBeforePass2 = http.requested.length;
    const pass2 = await discovery.discover({
      adapterId: 'govinfo-public-laws',
      cursor: pass1.cursor,
      nowIso: '2026-08-23T00:05:00.000Z',
    });
    const cursor2 = parseDiscoveryCursor(pass2.cursor);
    const state2 = collectionCursor(cursor2, 'PLAW');
    assert.equal(state2.backfillPending, true, 'pass 2 still has backlog remaining');
    assert.equal(state2.resumeAfterPackageId, 'PLAW-118publ105');

    const requestedInPass2 = http.requested.slice(requestedBeforePass2);
    const modsRequestedPass2 = requestedInPass2.filter((url) => url.includes('/metadata/pkg/'));
    assert.deepEqual(
      modsRequestedPass2,
      [
        'https://www.govinfo.gov/metadata/pkg/PLAW-118publ103/mods.xml',
        'https://www.govinfo.gov/metadata/pkg/PLAW-118publ104/mods.xml',
        'https://www.govinfo.gov/metadata/pkg/PLAW-118publ105/mods.xml',
      ],
      'pass 2 must resume strictly AFTER the pass 1 checkpoint — it must never re-fetch 100/101/102',
    );

    // ── Pass 3: finishes the remaining backlog and reaches genuine exhaustion ──
    const pass3 = await discovery.discover({
      adapterId: 'govinfo-public-laws',
      cursor: pass2.cursor,
      nowIso: '2026-08-23T00:10:00.000Z',
    });
    const cursor3 = parseDiscoveryCursor(pass3.cursor);
    const state3 = collectionCursor(cursor3, 'PLAW');
    assert.equal(state3.backfillPending, false, 'the collection must genuinely exhaust on pass 3');
    assert.ok(state3.watermark, 'the durable watermark must advance now that exhaustion is real');
    assert.equal(
      state3.resumeAfterPackageId,
      null,
      'exhaustion clears the in-progress checkpoint — there is nothing left to resume',
    );
    assert.equal(hasPendingBackfill(cursor3), false);

    const modsRequestedPass3 = http.requested
      .slice(http.requested.length - 1)
      .filter((url) => url.includes('/metadata/pkg/'));
    assert.deepEqual(modsRequestedPass3, [
      'https://www.govinfo.gov/metadata/pkg/PLAW-118publ106/mods.xml',
    ]);

    // Across all three passes, every real package was fetched EXACTLY once.
    const allModsRequests = http.requested.filter((url) => url.includes('/metadata/pkg/'));
    assert.deepEqual(
      [...new Set(allModsRequests)].sort(),
      [...allModsRequests].sort(),
      'no package was fetched more than once across the three passes',
    );
    assert.equal(allModsRequests.length, 7, 'all 7 packages were eventually fetched exactly once');
  });
});

describe('Phase 10 — B. budget exhaustion mid-package', () => {
  test('the package that could not be afforded is never checkpointed, and the next run replays exactly it, not more', async () => {
    // index(1) + sitemap(1) + 1 MODS = 3: 100 completes, 101 is next but unaffordable.
    const { discovery, http } = buildAdapter({ responses: baseResponses(), requestBudget: 3 });

    const pass1 = await discovery.discover({
      adapterId: 'govinfo-public-laws',
      cursor: serialiseDiscoveryCursor(emptyDiscoveryCursor()),
      nowIso: NOW,
    });
    const state1 = collectionCursor(parseDiscoveryCursor(pass1.cursor), 'PLAW');
    assert.equal(
      state1.resumeAfterPackageId,
      'PLAW-118publ100',
      'the durable resume point is the last package that FULLY completed — 101 was never started',
    );
    const modsRequestedPass1 = http.requested.filter((url) => url.includes('/metadata/pkg/'));
    assert.deepEqual(
      modsRequestedPass1,
      ['https://www.govinfo.gov/metadata/pkg/PLAW-118publ100/mods.xml'],
      '101 must not have been fetched at all — no partial/wasted request for an unaffordable package',
    );

    const requestedBeforePass2 = http.requested.length;
    const pass2 = await discovery.discover({
      adapterId: 'govinfo-public-laws',
      cursor: pass1.cursor,
      nowIso: '2026-08-23T00:05:00.000Z',
    });
    const modsRequestedPass2 = http.requested
      .slice(requestedBeforePass2)
      .filter((url) => url.includes('/metadata/pkg/'));
    assert.deepEqual(
      modsRequestedPass2,
      ['https://www.govinfo.gov/metadata/pkg/PLAW-118publ101/mods.xml'],
      'pass 2 must replay EXACTLY the interrupted package, not restart from 100',
    );
    void pass2;
  });
});

describe('Phase 10 — D. stale / missing resume anchor', () => {
  test('a persisted checkpoint that cannot be found in a changed listing is never used to skip forward — the crawler fails safe', async () => {
    // Pass 1 establishes a checkpoint at 102 exactly as in the multi-run test.
    const { discovery, http } = buildAdapter({ responses: baseResponses(), requestBudget: 5 });
    const pass1 = await discovery.discover({
      adapterId: 'govinfo-public-laws',
      cursor: serialiseDiscoveryCursor(emptyDiscoveryCursor()),
      nowIso: NOW,
    });
    const state1 = collectionCursor(parseDiscoveryCursor(pass1.cursor), 'PLAW');
    assert.equal(state1.resumeAfterPackageId, 'PLAW-118publ102');

    // GovInfo's listing changed: 102 was removed/renamed (e.g. a corrected
    // package id) and can never be found again. The remaining 6 packages
    // (100,101,103,104,105,106) are still there.
    const changedPackageIds = [
      'PLAW-118publ100',
      'PLAW-118publ101',
      'PLAW-118publ103',
      'PLAW-118publ104',
      'PLAW-118publ105',
      'PLAW-118publ106',
    ];
    const changedResponses = baseResponses(changedPackageIds);
    const { discovery: discovery2, http: http2 } = (() => {
      const registry = new SourceAdapterRegistry();
      const changedHttp = new RecordedPublisherHttp(changedResponses);
      const audit = new InMemoryDiscoveryAuditStore(FY2024_KEYS);
      const d = new LiveSourceDiscoveryAdapter(
        registry,
        new GovInfoSitemapCrawler(changedHttp),
        new IndexPageCrawler(changedHttp),
        audit,
        { requestBudget: 100, horizonFiscalYears: [2024] },
      );
      return { discovery: d, http: changedHttp };
    })();
    void http;

    const pass2 = await discovery2.discover({
      adapterId: 'govinfo-public-laws',
      cursor: pass1.cursor,
      nowIso: '2026-08-23T00:05:00.000Z',
    });

    // Fail-safe replay: EVERY package in the changed listing must have been
    // examined — none may be silently skipped because the stale anchor could
    // not be resolved. This is the invariant the brief calls non-negotiable:
    // never derive a position by array index, never jump forward blindly.
    const modsRequested = http2.requested.filter((url) => url.includes('/metadata/pkg/'));
    for (const id of changedPackageIds) {
      assert.ok(
        modsRequested.includes(`https://www.govinfo.gov/metadata/pkg/${id}/mods.xml`),
        `${id} must have been examined — a stale anchor must never cause a silent skip`,
      );
    }

    const state2 = collectionCursor(parseDiscoveryCursor(pass2.cursor), 'PLAW');
    assert.equal(
      state2.backfillPending,
      false,
      'with an ample budget the replayed collection genuinely exhausts',
    );
    assert.equal(state2.resumeAfterPackageId, null);
  });
});

describe('Phase 10 — E. collection completion', () => {
  test('once the final package is processed, the durable watermark advances and both backfillPending and the resume checkpoint reflect completion', async () => {
    const { discovery } = buildAdapter({ responses: baseResponses(), requestBudget: 100 });

    const result = await discovery.discover({
      adapterId: 'govinfo-public-laws',
      cursor: serialiseDiscoveryCursor(emptyDiscoveryCursor()),
      nowIso: NOW,
    });

    const state = collectionCursor(parseDiscoveryCursor(result.cursor), 'PLAW');
    assert.equal(state.backfillPending, false);
    assert.ok(state.watermark);
    assert.equal(state.resumeAfterPackageId, null);
    assert.equal(result.candidates.length, 7, 'all 7 continuing-resolution revisions resolve and emit');
  });
});

describe('Phase 10 — backward compatibility with the current production cursor row', () => {
  test('a real production-shaped cursor (schema v1, no resumeAfterPackageId key) resumes safely and starts the collection from the beginning', async () => {
    const productionCursor = {
      schema: 'phase8_session8_discovery_cursor_v1',
      collections: {
        PLAW: { watermark: null, backfillPending: true, emittedAtWatermark: [] },
      },
      lastRunAt: '2026-08-23T02:02:13.000Z',
    };

    const { discovery, http } = buildAdapter({ responses: baseResponses(), requestBudget: 5 });
    const result = await discovery.discover({
      adapterId: 'govinfo-public-laws',
      cursor: productionCursor,
      nowIso: NOW,
    });

    // No resumeAfterPackageId existed in the persisted row, so this run starts
    // from the beginning of the listing — exactly the current production
    // behavior, now ALSO producing a forward checkpoint for the first time.
    const modsRequested = http.requested.filter((url) => url.includes('/metadata/pkg/'));
    assert.deepEqual(modsRequested, [
      'https://www.govinfo.gov/metadata/pkg/PLAW-118publ100/mods.xml',
      'https://www.govinfo.gov/metadata/pkg/PLAW-118publ101/mods.xml',
      'https://www.govinfo.gov/metadata/pkg/PLAW-118publ102/mods.xml',
    ]);
    const state = collectionCursor(parseDiscoveryCursor(result.cursor), 'PLAW');
    assert.equal(state.resumeAfterPackageId, 'PLAW-118publ102');
  });
});
