#!/usr/bin/env node
/**
 * Phase 8 Session 8 — live discovery domain gate.
 *
 * Runs against the BUILT @capiro/defense-domain output so CI exercises the same
 * artifact the services consume. Every assertion is a Session 8 acceptance
 * requirement, and the robots/sitemap/MODS fixtures below are verbatim excerpts
 * of what the real hosts actually served while building this session.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const domain = require('../packages/defense-domain/dist/index.js');

const {
  // robots
  parseRobotsTxt,
  robotsPolicyFromFetch,
  selectRobotsGroup,
  evaluateRobots,
  assertUserAgentPermitted,
  UserAgentExcludedByPublisherError,
  // pacing
  effectiveRequestIntervalMs,
  nextHostRequestAt,
  publisherBackoffMs,
  retryAfterMs,
  createRequestBudget,
  spendRequest,
  budgetRemaining,
  budgetExhausted,
  // sitemap
  parseSitemapIndex,
  parseSitemapUrlSet,
  sitemapEntryChangedSince,
  highestLastmod,
  // govinfo
  packageIdFromSitemapLoc,
  govinfoPackagePdfUrl,
  govinfoPackageModsUrl,
  govinfoSitemapIndexUrl,
  govinfoCollectionOfPackageId,
  parseModsMetadata,
  plausibleCongressesForFiscalYear,
  GOVINFO_ADAPTER_COLLECTIONS,
  // listings
  extractDocumentLinks,
  extractFeedItems,
  hasDocumentExtension,
  // resolution
  resolveDiscoveredCandidate,
  CANDIDATE_RESOLUTION_OUTCOMES,
  // cursor
  emptyDiscoveryCursor,
  parseDiscoveryCursor,
  serialiseDiscoveryCursor,
  advanceCollectionCursor,
  collectionCursor,
  alreadyEmittedAtWatermark,
  hasPendingBackfill,
  DISCOVERY_CURSOR_SCHEMA,
  // session 7 contracts reused
  bootstrapFiscalYearCycle,
} = domain;

const UA = 'Capiro-Phase8-Session8-SourceDiscovery/1.0 (+official-source-discovery)';

// ── robots.txt, against what the real hosts serve ───────────────────────────

// Verbatim shape of www.govinfo.gov/robots.txt: one wildcard group, /search/
// disallowed, sitemaps listed, nothing blocking /sitemap/ or /content/pkg/.
const GOVINFO_ROBOTS = [
  '#',
  '# robots.txt',
  '#',
  '',
  'User-agent: *',
  'Allow: /core/*.css$',
  'Disallow: /core/',
  'Disallow: /search/',
  'Disallow: /user/login',
  '',
  'Sitemap: https://www.govinfo.gov/sitemap/CRPT_sitemap_index.xml',
  'Sitemap: https://www.govinfo.gov/sitemap/BILLS_sitemap_index.xml',
].join('\n');

// Verbatim shape of www.congress.gov/robots.txt: a wildcard group with
// Crawl-delay 2, then a long AI-crawler group terminated by a site-wide ban.
const CONGRESS_ROBOTS = [
  'User-agent: *',
  'Crawl-delay: 2',
  'Disallow: /search',
  'Disallow: /*?q=*',
  '',
  'Sitemap: https://www.congress.gov/sitemap/index.xml',
  '',
  'User-agent: anthropic-ai',
  'User-agent: YouBot',
  'User-agent: ZanistaBot',
  'Disallow: /',
].join('\n');

test('govinfo robots.txt permits the sitemap channel and blocks search', () => {
  const policy = parseRobotsTxt(GOVINFO_ROBOTS);
  assert.equal(policy.unavailable, false);
  assert.equal(policy.sitemaps.length, 2);

  const sitemap = evaluateRobots({
    policy,
    userAgent: UA,
    pathAndQuery: '/sitemap/CRPT_sitemap_index.xml',
  });
  assert.equal(sitemap.allowed, true, 'sitemap channel must be crawlable');

  const content = evaluateRobots({
    policy,
    userAgent: UA,
    pathAndQuery: '/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125.pdf',
  });
  assert.equal(content.allowed, true, 'package content must be crawlable');

  const search = evaluateRobots({ policy, userAgent: UA, pathAndQuery: '/search/foo' });
  assert.equal(search.allowed, false, '/search/ is disallowed and must be refused');
});

test('congress.gov crawl-delay is honoured and beats a laxer registry interval', () => {
  const policy = parseRobotsTxt(CONGRESS_ROBOTS);
  const decision = evaluateRobots({ policy, userAgent: UA, pathAndQuery: '/bill/118th' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.crawlDelaySeconds, 2);

  // The registry declares 1000ms for congress-gov; the publisher declares 2000ms.
  const interval = effectiveRequestIntervalMs({
    registryMinRequestIntervalMs: 1_000,
    robotsCrawlDelaySeconds: decision.crawlDelaySeconds,
  });
  assert.equal(interval, 2_000, 'publisher crawl-delay must win when stricter');

  // And a stricter registry is not loosened by a laxer publisher.
  assert.equal(
    effectiveRequestIntervalMs({ registryMinRequestIntervalMs: 3_000, robotsCrawlDelaySeconds: 1 }),
    3_000,
  );
});

test('a user agent inside a site-wide ban group is refused, not crawled', () => {
  const policy = parseRobotsTxt(CONGRESS_ROBOTS);

  // Our own agent is not in the banned list.
  assert.doesNotThrow(() =>
    assertUserAgentPermitted({ policy, userAgent: UA, host: 'www.congress.gov' }),
  );

  // An agent that matches a banned token must refuse to crawl at all.
  assert.throws(
    () =>
      assertUserAgentPermitted({
        policy,
        userAgent: 'anthropic-ai/1.0',
        host: 'www.congress.gov',
      }),
    UserAgentExcludedByPublisherError,
  );

  const group = selectRobotsGroup(policy, 'anthropic-ai/1.0');
  assert.ok(group);
  assert.deepEqual([...group.rules], [{ kind: 'disallow', pattern: '/' }]);
});

test('robots fetch status follows RFC 9309 for the statuses really observed', () => {
  // comptroller.defense.gov answers robots.txt with an Akamai 403.
  const forbidden = robotsPolicyFromFetch({ statusCode: 403, body: null });
  assert.equal(forbidden.unavailable, true);
  const afterForbidden = evaluateRobots({ policy: forbidden, userAgent: UA, pathAndQuery: '/x' });
  assert.equal(afterForbidden.allowed, true, '4xx robots means unrestricted, not banned');
  assert.equal(afterForbidden.robotsUnavailable, true, 'and it must be flagged, not hidden');

  // api.govinfo.gov answers robots.txt with a 500 JSON application error.
  const serverError = robotsPolicyFromFetch({ statusCode: 500, body: null });
  assert.equal(serverError.unavailable, true);
  assert.equal(
    evaluateRobots({ policy: serverError, userAgent: UA, pathAndQuery: '/collections' }).allowed,
    true,
    'a publisher app fault is not a crawl directive',
  );
});

test('longest-match wins and an equal-length allow beats a disallow', () => {
  const policy = parseRobotsTxt(
    ['User-agent: *', 'Disallow: /a/', 'Allow: /a/b/', 'Disallow: /c', 'Allow: /c'].join('\n'),
  );
  assert.equal(evaluateRobots({ policy, userAgent: UA, pathAndQuery: '/a/x' }).allowed, false);
  assert.equal(evaluateRobots({ policy, userAgent: UA, pathAndQuery: '/a/b/x' }).allowed, true);
  assert.equal(
    evaluateRobots({ policy, userAgent: UA, pathAndQuery: '/c' }).allowed,
    true,
    'equal specificity resolves in favour of allow',
  );
});

test('an empty Disallow carries no pattern and blocks nothing', () => {
  const policy = parseRobotsTxt(['User-agent: *', 'Disallow:'].join('\n'));
  assert.equal(evaluateRobots({ policy, userAgent: UA, pathAndQuery: '/anything' }).allowed, true);
});

// ── pacing ─────────────────────────────────────────────────────────────────

test('a first request to a host is immediate; the next is spaced', () => {
  const first = nextHostRequestAt({
    nowIso: '2026-08-21T00:00:00.000Z',
    lastRequestAt: null,
    intervalMs: 2_000,
  });
  assert.equal(first.waitMs, 0, 'the interval governs the gap, not a warm-up');

  const second = nextHostRequestAt({
    nowIso: '2026-08-21T00:00:00.500Z',
    lastRequestAt: '2026-08-21T00:00:00.000Z',
    intervalMs: 2_000,
  });
  assert.equal(second.waitMs, 1_500);

  const later = nextHostRequestAt({
    nowIso: '2026-08-21T00:00:05.000Z',
    lastRequestAt: '2026-08-21T00:00:00.000Z',
    intervalMs: 2_000,
  });
  assert.equal(later.waitMs, 0);
});

test('backoff is deterministic and capped, with no jitter', () => {
  assert.equal(publisherBackoffMs({ intervalMs: 1_000, consecutiveFailures: 0 }), 1_000);
  assert.equal(publisherBackoffMs({ intervalMs: 1_000, consecutiveFailures: 3 }), 8_000);
  assert.equal(
    publisherBackoffMs({ intervalMs: 1_000, consecutiveFailures: 99 }),
    15 * 60_000,
    'capped so a long outage cannot schedule a request years out',
  );
  // Determinism: a replay must reproduce the schedule exactly.
  assert.equal(
    publisherBackoffMs({ intervalMs: 1_000, consecutiveFailures: 5 }),
    publisherBackoffMs({ intervalMs: 1_000, consecutiveFailures: 5 }),
  );
});

test('Retry-After is honoured in both legal forms and ignored when unparseable', () => {
  assert.equal(retryAfterMs({ headerValue: '120', nowIso: '2026-08-21T00:00:00Z' }), 120_000);
  assert.equal(
    retryAfterMs({ headerValue: 'Fri, 21 Aug 2026 00:01:00 GMT', nowIso: '2026-08-21T00:00:00Z' }),
    60_000,
  );
  assert.equal(retryAfterMs({ headerValue: 'soon please', nowIso: '2026-08-21T00:00:00Z' }), null);
  assert.equal(retryAfterMs({ headerValue: null, nowIso: '2026-08-21T00:00:00Z' }), null);
});

test('the request budget is bounded and reports exhaustion explicitly', () => {
  let budget = createRequestBudget(3);
  assert.equal(budgetRemaining(budget), 3);
  budget = spendRequest(budget);
  budget = spendRequest(budget);
  assert.equal(budgetExhausted(budget), false);
  budget = spendRequest(budget);
  assert.equal(budgetExhausted(budget), true);
  assert.equal(budgetRemaining(budget), 0);
});

// ── sitemaps, in the exact shape GovInfo really emits ───────────────────────

// The real index is NOT sorted by year.
const REAL_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://www.govinfo.gov/sitemap/CRPT_2001_sitemap.xml</loc>
    <lastmod>2025-05-19T18:43:02.734Z</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://www.govinfo.gov/sitemap/CRPT_2015_sitemap.xml</loc>
    <lastmod>2025-06-09T13:26:00.050Z</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://www.govinfo.gov/sitemap/CRPT_2004_sitemap.xml</loc>
    <lastmod>2025-05-19T18:43:03.375Z</lastmod>
  </sitemap>
</sitemapindex>`;

// The real urlset is not pretty-printed: entries share lines.
const REAL_URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>  <loc>https://www.govinfo.gov/app/details/CRPT-118hrpt125</loc>  <lastmod>2024-11-08T16:29:00.109Z</lastmod>  <changefreq>monthly</changefreq>  <priority>1.0</priority>
  </url><url>  <loc>https://www.govinfo.gov/app/details/CRPT-118hrpt121</loc>  <lastmod>2024-11-08T16:29:00.069Z</lastmod>  <changefreq>monthly</changefreq>  <priority>1.0</priority>
  </url><url>  <loc>https://www.govinfo.gov/app/details/CRPT-117hrpt700</loc>  <lastmod>2024-11-08T17:20:00.602Z</lastmod>  <changefreq>monthly</changefreq>  <priority>1.0</priority>
  </url>
</urlset>`;

test('sitemap index parses and is deterministically ordered despite publisher order', () => {
  const entries = parseSitemapIndex(REAL_INDEX);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.loc),
    [
      'https://www.govinfo.gov/sitemap/CRPT_2001_sitemap.xml',
      'https://www.govinfo.gov/sitemap/CRPT_2004_sitemap.xml',
      'https://www.govinfo.gov/sitemap/CRPT_2015_sitemap.xml',
    ],
    'output order must not depend on publisher order',
  );
  assert.equal(entries[0].lastmod, '2025-05-19T18:43:02.734Z');
});

test('run-together sitemap entries are framed by element, not by line', () => {
  const entries = parseSitemapUrlSet(REAL_URLSET);
  assert.equal(entries.length, 3, 'a line-oriented parser would mis-frame these');
  assert.ok(
    entries.some((entry) => entry.loc.endsWith('CRPT-118hrpt125')),
    'the HASC report must be found',
  );
  assert.ok(
    entries.some((entry) => entry.loc.endsWith('CRPT-118hrpt121')),
    'the HAC-D report must be found',
  );
});

test('the changed-since comparison is inclusive so a shared lastmod is never skipped', () => {
  const watermark = '2024-11-08T16:29:00.109Z';
  assert.equal(sitemapEntryChangedSince({ lastmod: watermark }, watermark), true);
  assert.equal(sitemapEntryChangedSince({ lastmod: '2024-11-08T16:29:00.110Z' }, watermark), true);
  assert.equal(sitemapEntryChangedSince({ lastmod: '2024-11-08T16:29:00.108Z' }, watermark), false);
  assert.equal(sitemapEntryChangedSince({ lastmod: null }, watermark), true, 'unknown means look');
  assert.equal(sitemapEntryChangedSince({ lastmod: watermark }, null), true, 'no watermark, look');
});

test('highestLastmod never regresses below the prior watermark', () => {
  assert.equal(
    highestLastmod([{ lastmod: '2024-01-01T00:00:00.000Z' }], '2025-01-01T00:00:00.000Z'),
    '2025-01-01T00:00:00.000Z',
    'a stale sitemap must not rewind the cursor',
  );
  assert.equal(
    highestLastmod([{ lastmod: '2026-01-01T00:00:00.000Z' }], '2025-01-01T00:00:00.000Z'),
    '2026-01-01T00:00:00.000Z',
  );
  assert.equal(highestLastmod([], null), null);
});

// ── GovInfo package algebra, verified live ─────────────────────────────────

test('a sitemap details URL becomes the package content and metadata URLs', () => {
  const loc = 'https://www.govinfo.gov/app/details/CRPT-118hrpt125';
  const packageId = packageIdFromSitemapLoc(loc);
  assert.equal(packageId, 'CRPT-118hrpt125');

  // Verified live: this exact URL returns 200 application/pdf.
  assert.equal(
    govinfoPackagePdfUrl(packageId),
    'https://www.govinfo.gov/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125.pdf',
  );
  assert.equal(
    govinfoPackageModsUrl(packageId),
    'https://www.govinfo.gov/metadata/pkg/CRPT-118hrpt125/mods.xml',
  );
  assert.equal(
    govinfoSitemapIndexUrl('CRPT'),
    'https://www.govinfo.gov/sitemap/CRPT_sitemap_index.xml',
  );
  assert.equal(govinfoCollectionOfPackageId(packageId), 'CRPT');
});

test('a non-govinfo or non-https loc resolves to no package', () => {
  assert.equal(packageIdFromSitemapLoc('http://www.govinfo.gov/app/details/CRPT-1'), null);
  assert.equal(packageIdFromSitemapLoc('https://example.com/app/details/CRPT-1'), null);
  assert.equal(packageIdFromSitemapLoc('https://www.govinfo.gov/app/search'), null);
  assert.equal(packageIdFromSitemapLoc('not a url'), null);
});

test('each GovInfo adapter owns exactly its own collection', () => {
  assert.deepEqual([...GOVINFO_ADAPTER_COLLECTIONS['govinfo-committee-reports']], ['CRPT']);
  assert.deepEqual([...GOVINFO_ADAPTER_COLLECTIONS['govinfo-bills']], ['BILLS']);
  assert.deepEqual([...GOVINFO_ADAPTER_COLLECTIONS['govinfo-public-laws']], ['PLAW']);
});

test('MODS titles are the real ones, including the report that states no fiscal year', () => {
  // Verbatim first titles from the live MODS records.
  const hasc = parseModsMetadata(
    '<mods><titleInfo><title>NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024</title>' +
      '</titleInfo><congress>118</congress></mods>',
  );
  assert.equal(hasc.title, 'NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024');
  assert.equal(hasc.congress, 118);
  assert.deepEqual([...hasc.declaredFiscalYears], [2024]);

  // The HAC-D trap: no "fiscal year" phrase anywhere in the title.
  const hacd = parseModsMetadata(
    '<mods><titleInfo><title>DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024</title></titleInfo></mods>',
  );
  assert.equal(hacd.title, 'DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024');
  assert.deepEqual(
    [...hacd.declaredFiscalYears],
    [2024],
    'the year must come from the appropriations-bill wording',
  );

  // The omnibus form.
  const omnibus = parseModsMetadata(
    '<mods><titleInfo><title>An act making consolidated appropriations for the fiscal year ' +
      'ending September 30, 2024, and for other purposes.</title></titleInfo></mods>',
  );
  assert.deepEqual([...omnibus.declaredFiscalYears], [2024]);
});

test('MODS extraction takes the first title, not a related item', () => {
  // The real CRPT-118hrpt125 record has a second title naming the Senate bill.
  const mods = parseModsMetadata(
    '<mods><titleInfo><title>NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024</title>' +
      '</titleInfo><relatedItem><titleInfo>' +
      '<title>United States Senate Bill 008 (118th Congress)</title>' +
      '</titleInfo></relatedItem></mods>',
  );
  assert.equal(
    mods.title,
    'NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024',
    'a related-item title would misclassify the document',
  );
});

test('MODS extraction reads no monetary field', () => {
  const mods = parseModsMetadata(
    '<mods><titleInfo><title>X</title></titleInfo><amount>123456</amount></mods>',
  );
  for (const key of Object.keys(mods)) {
    assert.ok(!/amount|usd|dollar|obligat|outlay/i.test(key), `unexpected monetary field: ${key}`);
  }
});

test('plausible congresses for a fiscal year match the real 118th for FY2024', () => {
  assert.deepEqual([...plausibleCongressesForFiscalYear(2024)], [118]);
  assert.deepEqual([...plausibleCongressesForFiscalYear(2027)], [119, 120]);
});

// ── listing extraction ─────────────────────────────────────────────────────

test('index-page extraction keeps only on-host document links, sorted and deduped', () => {
  const html = [
    '<a href="/docs/fy2024-budget.pdf">FY2024 Budget Request</a>',
    '<a href="https://appropriations.house.gov/docs/report.pdf">Report</a>',
    '<a href="https://evil.example.com/docs/fake.pdf">Off-host</a>',
    '<a href="/about">Navigation</a>',
    '<a href="mailto:x@y.gov">Mail</a>',
    '<a href="/docs/fy2024-budget.pdf"><img src="i.png"></a>',
  ].join('\n');

  const links = extractDocumentLinks({
    html,
    pageUrl: 'https://appropriations.house.gov/legislation',
    officialHosts: ['appropriations.house.gov', 'docs.house.gov'],
  });

  assert.equal(links.length, 2, 'off-host, navigation and mailto links must all be dropped');
  assert.deepEqual(
    links.map((link) => link.url),
    [
      'https://appropriations.house.gov/docs/fy2024-budget.pdf',
      'https://appropriations.house.gov/docs/report.pdf',
    ],
  );
  assert.equal(
    links[0].text,
    'FY2024 Budget Request',
    'the anchor carrying text must win over the icon anchor',
  );
});

test('a path-prefix constraint further narrows an index page', () => {
  const html = '<a href="/Portals/45/x.pdf">A</a><a href="/news/y.pdf">B</a>';
  const links = extractDocumentLinks({
    html,
    pageUrl: 'https://comptroller.defense.gov/Budget-Materials/',
    officialHosts: ['comptroller.defense.gov'],
    requiredPathPrefixes: ['/Portals/45'],
  });
  assert.deepEqual(links.map((link) => link.url), [
    'https://comptroller.defense.gov/Portals/45/x.pdf',
  ]);
});

test('document extensions are recognised and navigation is not', () => {
  assert.equal(hasDocumentExtension('/a/b.pdf'), true);
  assert.equal(hasDocumentExtension('/a/b.XLSX'), true);
  assert.equal(hasDocumentExtension('/a/b'), false);
  assert.equal(hasDocumentExtension('/a/b.html'), false);
});

test('feed extraction keeps on-host items with titles and dates', () => {
  const xml = [
    '<rss><channel>',
    '<item><title>Contracts for August 20, 2026</title>',
    '<link>https://www.defense.gov/News/Contracts/Contract/Article/1/</link>',
    '<pubDate>Thu, 20 Aug 2026 17:00:00 GMT</pubDate></item>',
    '<item><title>Off host</title><link>https://example.com/x</link></item>',
    '</channel></rss>',
  ].join('');

  const items = extractFeedItems({ xml, officialHosts: ['www.defense.gov'] });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Contracts for August 20, 2026');
  assert.equal(items[0].publishedAt, '2026-08-20T17:00:00.000Z');
});

// ── candidate resolution: the core Session 8 guarantee ─────────────────────

const FY2024 = bootstrapFiscalYearCycle({ fiscalYear: 2024 });
const FY2024_KEYS = new Set(FY2024.expectedSources.map((source) => source.dedupKey));
const HORIZON = [2023, 2024, 2025];

test('the real HASC report resolves to a registered expected source', () => {
  const resolved = resolveDiscoveredCandidate({
    adapterId: 'govinfo-committee-reports',
    url: govinfoPackagePdfUrl('CRPT-118hrpt125'),
    packageId: 'CRPT-118hrpt125',
    title: 'NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024',
    declaredFiscalYear: 2024,
    divisionEvidence: null,
    horizonFiscalYears: HORIZON,
    registeredExpectedSourceKeys: FY2024_KEYS,
  });

  assert.equal(resolved.outcome, 'resolved');
  assert.ok(resolved.expectedSourceDedupKey, 'a resolved candidate must carry a key');
  assert.equal(resolved.provisionalClassification.fiscalYear, 2024);
  assert.equal(resolved.provisionalClassification.authorityTrack, 'authorization');
  assert.ok(FY2024_KEYS.has(resolved.expectedSourceDedupKey));
});

test('the real HAC-D report resolves onto appropriations, not authorization', () => {
  const resolved = resolveDiscoveredCandidate({
    adapterId: 'govinfo-committee-reports',
    url: govinfoPackagePdfUrl('CRPT-118hrpt121'),
    packageId: 'CRPT-118hrpt121',
    // No "fiscal year" phrase at all — the real record.
    title: 'DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024',
    declaredFiscalYear: 2024,
    divisionEvidence: null,
    horizonFiscalYears: HORIZON,
    registeredExpectedSourceKeys: FY2024_KEYS,
  });

  assert.equal(resolved.outcome, 'resolved');
  assert.equal(resolved.provisionalClassification.authorityTrack, 'appropriations');
  assert.notEqual(
    resolved.provisionalClassification.authorityTrack,
    'authorization',
    'the two tracks are independent and must not be conflated',
  );
});

test('an unresolvable candidate is NEVER given a fabricated dedup key', () => {
  for (const candidate of [
    { packageId: 'CRPT-118hrpt999', title: 'REPORT ON POST OFFICE NAMING' },
    { packageId: 'BILLS-118hr1eh', title: 'A bill to lower energy costs' },
    { packageId: 'CRPT-118hrpt1', title: null },
  ]) {
    const resolved = resolveDiscoveredCandidate({
      adapterId: 'govinfo-committee-reports',
      url: govinfoPackagePdfUrl(candidate.packageId),
      packageId: candidate.packageId,
      title: candidate.title,
      declaredFiscalYear: null,
      divisionEvidence: null,
      horizonFiscalYears: HORIZON,
      registeredExpectedSourceKeys: FY2024_KEYS,
    });
    assert.notEqual(resolved.outcome, 'resolved', `${candidate.packageId} must not resolve`);
    assert.equal(
      resolved.expectedSourceDedupKey,
      null,
      'an unresolved candidate must carry no key at all',
    );
    assert.ok(resolved.reasons.length > 0, 'and must say why');
  }
});

test('a fiscal year outside the bootstrapped horizon is refused with that reason', () => {
  const resolved = resolveDiscoveredCandidate({
    adapterId: 'govinfo-committee-reports',
    url: govinfoPackagePdfUrl('CRPT-110hrpt1'),
    packageId: 'CRPT-110hrpt1',
    title: 'NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2008',
    declaredFiscalYear: 2008,
    divisionEvidence: null,
    horizonFiscalYears: HORIZON,
    registeredExpectedSourceKeys: FY2024_KEYS,
  });
  assert.equal(resolved.outcome, 'unresolved_fiscal_year_out_of_horizon');
  assert.equal(resolved.expectedSourceDedupKey, null);
});

test('a plausible source with no registered expected source is recorded, not invented', () => {
  const resolved = resolveDiscoveredCandidate({
    adapterId: 'govinfo-committee-reports',
    url: govinfoPackagePdfUrl('CRPT-118hrpt125'),
    packageId: 'CRPT-118hrpt125',
    title: 'NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024',
    declaredFiscalYear: 2024,
    divisionEvidence: null,
    horizonFiscalYears: HORIZON,
    // Nothing registered at all.
    registeredExpectedSourceKeys: new Set(),
  });
  assert.equal(resolved.outcome, 'unresolved_no_registered_expected_source');
  assert.equal(resolved.expectedSourceDedupKey, null);
});

test('an unparseable package id is refused before any classification', () => {
  const resolved = resolveDiscoveredCandidate({
    adapterId: 'govinfo-committee-reports',
    url: 'https://www.govinfo.gov/content/pkg/NOPE-1/pdf/NOPE-1.pdf',
    packageId: 'NOPE-1',
    title: 'NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024',
    declaredFiscalYear: 2024,
    divisionEvidence: null,
    horizonFiscalYears: HORIZON,
    registeredExpectedSourceKeys: FY2024_KEYS,
  });
  assert.equal(resolved.outcome, 'unresolved_unparseable_package');
});

test('resolution carries no dollars and never claims corroboration it does not have', () => {
  const resolved = resolveDiscoveredCandidate({
    adapterId: 'govinfo-committee-reports',
    url: govinfoPackagePdfUrl('CRPT-118hrpt125'),
    packageId: 'CRPT-118hrpt125',
    title: 'NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024',
    declaredFiscalYear: 2024,
    divisionEvidence: null,
    horizonFiscalYears: HORIZON,
    registeredExpectedSourceKeys: FY2024_KEYS,
  });

  const serialised = JSON.stringify(resolved);
  assert.ok(!/amount|usd|dollar|obligat|outlay/i.test(serialised), 'no monetary field anywhere');
  assert.ok(
    resolved.reasons.join(' ').includes('deferred'),
    'resolution must state that authoritative classification is deferred',
  );
});

test('every declared resolution outcome is reachable in the type surface', () => {
  assert.equal(CANDIDATE_RESOLUTION_OUTCOMES.length, 7);
  assert.ok(CANDIDATE_RESOLUTION_OUTCOMES.includes('resolved'));
  for (const outcome of CANDIDATE_RESOLUTION_OUTCOMES) {
    assert.ok(
      outcome === 'resolved' || outcome.startsWith('unresolved_'),
      `outcome ${outcome} must be resolved or explicitly unresolved`,
    );
  }
});

// ── cursor ─────────────────────────────────────────────────────────────────

test('an empty or foreign cursor is treated as a fresh full crawl, never an error', () => {
  assert.equal(parseDiscoveryCursor(null).schema, DISCOVERY_CURSOR_SCHEMA);
  assert.equal(parseDiscoveryCursor({ schema: 'something-else' }).collections.CRPT, undefined);
  assert.equal(Object.keys(parseDiscoveryCursor({}).collections).length, 0);
  // A Session 7 manifest cursor must not wedge the adapter.
  assert.doesNotThrow(() => parseDiscoveryCursor({ lastDiscoveryAt: 'x', seen: 3 }));
});

test('an exhausted run advances the watermark and clears the pending flag', () => {
  const advanced = advanceCollectionCursor({
    cursor: emptyDiscoveryCursor(),
    collection: 'CRPT',
    observedWatermark: '2024-11-08T16:29:00.109Z',
    emittedAtWatermark: ['CRPT-118hrpt125'],
    exhausted: true,
    nowIso: '2026-08-21T00:00:00.000Z',
  });
  const state = collectionCursor(advanced, 'CRPT');
  assert.equal(state.watermark, '2024-11-08T16:29:00.109Z');
  assert.equal(state.backfillPending, false);
  assert.deepEqual([...state.emittedAtWatermark], ['CRPT-118hrpt125']);
  assert.equal(hasPendingBackfill(advanced), false);
});

test('a truncated run does NOT advance the watermark past unexamined work', () => {
  const advanced = advanceCollectionCursor({
    cursor: emptyDiscoveryCursor(),
    collection: 'BILLS',
    observedWatermark: '2024-11-08T16:29:00.109Z',
    emittedAtWatermark: [],
    exhausted: false,
    nowIso: '2026-08-21T00:00:00.000Z',
  });
  const state = collectionCursor(advanced, 'BILLS');
  assert.equal(
    state.watermark,
    null,
    'advancing here would permanently skip the rest of a 13,354-entry backlog',
  );
  assert.equal(state.backfillPending, true);
  assert.equal(hasPendingBackfill(advanced), true);
});

test('a stale sitemap cannot rewind an established watermark', () => {
  const first = advanceCollectionCursor({
    cursor: emptyDiscoveryCursor(),
    collection: 'CRPT',
    observedWatermark: '2025-01-01T00:00:00.000Z',
    emittedAtWatermark: [],
    exhausted: true,
    nowIso: '2026-08-21T00:00:00.000Z',
  });
  const second = advanceCollectionCursor({
    cursor: first,
    collection: 'CRPT',
    observedWatermark: '2024-01-01T00:00:00.000Z',
    emittedAtWatermark: [],
    exhausted: true,
    nowIso: '2026-08-21T01:00:00.000Z',
  });
  assert.equal(collectionCursor(second, 'CRPT').watermark, '2025-01-01T00:00:00.000Z');
});

test('the boundary set accumulates so an inclusive comparison cannot re-emit', () => {
  const watermark = '2024-11-08T16:29:00.109Z';
  let cursor = advanceCollectionCursor({
    cursor: emptyDiscoveryCursor(),
    collection: 'CRPT',
    observedWatermark: watermark,
    emittedAtWatermark: ['CRPT-118hrpt125'],
    exhausted: true,
    nowIso: '2026-08-21T00:00:00.000Z',
  });

  assert.equal(
    alreadyEmittedAtWatermark({
      cursor,
      collection: 'CRPT',
      packageId: 'CRPT-118hrpt125',
      entryLastmod: watermark,
    }),
    true,
    'the same package at the same instant must not be emitted twice',
  );
  assert.equal(
    alreadyEmittedAtWatermark({
      cursor,
      collection: 'CRPT',
      packageId: 'CRPT-118hrpt121',
      entryLastmod: watermark,
    }),
    false,
    'but a different package sharing that instant must still be seen',
  );

  cursor = advanceCollectionCursor({
    cursor,
    collection: 'CRPT',
    observedWatermark: watermark,
    emittedAtWatermark: ['CRPT-118hrpt121'],
    exhausted: true,
    nowIso: '2026-08-21T01:00:00.000Z',
  });
  assert.deepEqual(
    [...collectionCursor(cursor, 'CRPT').emittedAtWatermark],
    ['CRPT-118hrpt121', 'CRPT-118hrpt125'],
  );
});

test('collections advance independently', () => {
  let cursor = advanceCollectionCursor({
    cursor: emptyDiscoveryCursor(),
    collection: 'CRPT',
    observedWatermark: '2025-01-01T00:00:00.000Z',
    emittedAtWatermark: [],
    exhausted: true,
    nowIso: '2026-08-21T00:00:00.000Z',
  });
  cursor = advanceCollectionCursor({
    cursor,
    collection: 'BILLS',
    observedWatermark: '2024-01-01T00:00:00.000Z',
    emittedAtWatermark: [],
    exhausted: false,
    nowIso: '2026-08-21T00:00:00.000Z',
  });
  assert.equal(collectionCursor(cursor, 'CRPT').watermark, '2025-01-01T00:00:00.000Z');
  assert.equal(collectionCursor(cursor, 'CRPT').backfillPending, false);
  assert.equal(collectionCursor(cursor, 'BILLS').backfillPending, true);
});

test('the cursor round-trips through the opaque store column', () => {
  const cursor = advanceCollectionCursor({
    cursor: emptyDiscoveryCursor(),
    collection: 'CRPT',
    observedWatermark: '2025-01-01T00:00:00.000Z',
    emittedAtWatermark: ['CRPT-118hrpt125'],
    exhausted: true,
    nowIso: '2026-08-21T00:00:00.000Z',
  });
  const restored = parseDiscoveryCursor(
    JSON.parse(JSON.stringify(serialiseDiscoveryCursor(cursor))),
  );
  assert.deepEqual(restored, cursor);
});
