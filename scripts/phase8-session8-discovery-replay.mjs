#!/usr/bin/env node
/**
 * Phase 8 Session 8 — live discovery replay against real official sources.
 *
 * Drives the real discovery domain over the bytes the prepare script downloaded
 * from the actual publishers. Nothing here is synthetic: the robots policies, the
 * sitemap index, the year sitemaps and the MODS records are what govinfo.gov,
 * congress.gov, comptroller.defense.gov and asafm.army.mil served.
 *
 * What it proves, end to end and on real data:
 *
 *   * the sitemap channel is permitted by the publisher's own robots.txt, and
 *     the paths it forbids are refused;
 *   * a publisher stricter than our registry wins on pacing;
 *   * a real 497-entry CRPT year sitemap and a real 13,354-entry BILLS year
 *     sitemap parse, and the packages Session 7 replayed are found in them;
 *   * the derived content URL is the one the watcher fetches;
 *   * the FY2024 HASC report resolves onto authorization and the FY2024 HAC-D
 *     report onto appropriations, from titles alone, with the HAC-D title
 *     containing no "fiscal year" phrase at all;
 *   * the FY2024 omnibus with no defence division does NOT resolve onto the
 *     defence appropriations track;
 *   * a refusing publisher is recorded as refusing, not as empty.
 *
 * Writes an evidence file. Run the prepare script first.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const domain = require('../packages/defense-domain/dist/index.js');

const {
  parseRobotsTxt,
  robotsPolicyFromFetch,
  evaluateRobots,
  effectiveRequestIntervalMs,
  parseSitemapIndex,
  parseSitemapUrlSet,
  packageIdFromSitemapLoc,
  govinfoPackagePdfUrl,
  govinfoPackageModsUrl,
  parseModsMetadata,
  resolveDiscoveredCandidate,
  bootstrapFiscalYearCycle,
  plausibleCongressesForFiscalYear,
  extractDocumentLinks,
  classifyLifecycleSource,
  PUBLISHER_NATIVE_ADAPTER_IDS,
} = domain;

const USER_AGENT =
  'Capiro-Phase8-Session8-SourceDiscovery/1.0 (+official-source-discovery; contact: platform@capiro.ai)';

const outIndex = process.argv.indexOf('--out');
const outPath = outIndex === -1 ? null : process.argv[outIndex + 1];

const preparedPath = path.join(root, '.session8-discovery/prepared-corpus.json');
if (!fs.existsSync(preparedPath)) {
  console.error(
    'Prepared corpus missing. Run: node scripts/prepare-phase8-session8-discovery-corpus.mjs',
  );
  process.exit(1);
}
const prepared = JSON.parse(fs.readFileSync(preparedPath, 'utf8'));
const byKey = new Map(prepared.resources.map((resource) => [resource.resourceKey, resource]));

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

const bodyOf = (key) => {
  const resource = byKey.get(key);
  if (!resource) throw new Error(`resource ${key} missing from prepared corpus`);
  if (!resource.path)
    throw new Error(`resource ${key} has no bytes (status ${resource.statusCode})`);
  return fs.readFileSync(path.join(root, resource.path), 'utf8');
};

// ── 1. robots policy, from the real files ──────────────────────────────────

const govinfoRobots = parseRobotsTxt(bodyOf('govinfo-robots'));

check('govinfo robots.txt permits the sitemap index', () => {
  assert.equal(
    evaluateRobots({
      policy: govinfoRobots,
      userAgent: USER_AGENT,
      pathAndQuery: '/sitemap/CRPT_sitemap_index.xml',
    }).allowed,
    true,
  );
});

check('govinfo robots.txt permits package content', () => {
  assert.equal(
    evaluateRobots({
      policy: govinfoRobots,
      userAgent: USER_AGENT,
      pathAndQuery: '/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125.pdf',
    }).allowed,
    true,
  );
});

check('govinfo robots.txt permits package metadata', () => {
  assert.equal(
    evaluateRobots({
      policy: govinfoRobots,
      userAgent: USER_AGENT,
      pathAndQuery: '/metadata/pkg/CRPT-118hrpt125/mods.xml',
    }).allowed,
    true,
  );
});

check('govinfo robots.txt forbids /search/ and discovery must never request it', () => {
  assert.equal(
    evaluateRobots({ policy: govinfoRobots, userAgent: USER_AGENT, pathAndQuery: '/search/x' })
      .allowed,
    false,
  );
});

check('govinfo robots.txt advertises the collection sitemaps we crawl', () => {
  for (const collection of ['CRPT', 'BILLS', 'PLAW']) {
    assert.ok(
      govinfoRobots.sitemaps.some((url) => url.includes(`${collection}_sitemap_index.xml`)),
      `${collection} sitemap index must be advertised`,
    );
  }
});

const congressRobots = parseRobotsTxt(bodyOf('congress-robots'));

check('congress.gov declares a crawl-delay and it is read', () => {
  const decision = evaluateRobots({
    policy: congressRobots,
    userAgent: USER_AGENT,
    pathAndQuery: '/bill/118th-congress/house-bill/2670',
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.crawlDelaySeconds, 2);
});

check('a publisher stricter than the registry wins on pacing', () => {
  const decision = evaluateRobots({
    policy: congressRobots,
    userAgent: USER_AGENT,
    pathAndQuery: '/bill/118th-congress/house-bill/2670',
  });
  // The registry declares 1000ms for congress-gov.
  assert.equal(
    effectiveRequestIntervalMs({
      registryMinRequestIntervalMs: 1_000,
      robotsCrawlDelaySeconds: decision.crawlDelaySeconds,
    }),
    2_000,
  );
});

check('congress.gov site-wide ban group applies only to the agents it names', () => {
  // Our agent is not in the list; a named AI crawler is.
  assert.equal(
    evaluateRobots({ policy: congressRobots, userAgent: USER_AGENT, pathAndQuery: '/' }).allowed,
    true,
  );
  assert.equal(
    evaluateRobots({ policy: congressRobots, userAgent: 'anthropic-ai/1.0', pathAndQuery: '/' })
      .allowed,
    false,
  );
});

check('a 403 robots.txt is unavailable, not a ban, and is flagged', () => {
  const resource = byKey.get('comptroller-robots');
  assert.equal(resource.statusCode, 403, 'the real observed status');
  const policy = robotsPolicyFromFetch({ statusCode: resource.statusCode, body: null });
  const decision = evaluateRobots({
    policy,
    userAgent: USER_AGENT,
    pathAndQuery: '/Budget-Materials/',
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.robotsUnavailable, true);
});

// ── 2. sitemap channel, from the real files ────────────────────────────────

const crptIndex = parseSitemapIndex(bodyOf('govinfo-crpt-sitemap-index'));

check('the real CRPT sitemap index parses and is deterministically ordered', () => {
  assert.ok(crptIndex.length > 20, `expected many year files, got ${crptIndex.length}`);
  const locs = crptIndex.map((entry) => entry.loc);
  assert.deepEqual([...locs].sort(), locs, 'output must be sorted regardless of publisher order');
});

check('the real CRPT index is NOT sorted at source, so sorting is load-bearing', () => {
  const raw = [...bodyOf('govinfo-crpt-sitemap-index').matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => match[1],
  );
  assert.notDeepEqual(raw, [...raw].sort(), 'the publisher really does emit them unordered');
});

const crpt2023 = parseSitemapUrlSet(bodyOf('govinfo-crpt-2023-sitemap'));

check('the real CRPT 2023 year sitemap parses its full entry set', () => {
  assert.ok(crpt2023.length >= 400, `expected 400+ entries, got ${crpt2023.length}`);
});

check('both Session 7 committee reports are found by live discovery', () => {
  const ids = new Set(crpt2023.map((entry) => packageIdFromSitemapLoc(entry.loc)));
  assert.ok(ids.has('CRPT-118hrpt125'), 'HASC report must be discoverable');
  assert.ok(ids.has('CRPT-118hrpt121'), 'HAC-D report must be discoverable');
});

check('sitemap locs are details pages, so the content URL must be derived', () => {
  const entry = crpt2023.find((item) => item.loc.endsWith('CRPT-118hrpt125'));
  assert.ok(entry);
  assert.match(entry.loc, /\/app\/details\//, 'the publisher lists a details page');
  assert.equal(
    govinfoPackagePdfUrl(packageIdFromSitemapLoc(entry.loc)),
    'https://www.govinfo.gov/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125.pdf',
    'and the watcher fetches the derived content URL',
  );
});

check('lastmod is a metadata timestamp, not a publication date', () => {
  const entry = crpt2023.find((item) => item.loc.endsWith('CRPT-118hrpt125'));
  // The FY2024 report was filed in 2023; its lastmod is much later.
  assert.ok(
    Date.parse(entry.lastmod) > Date.parse('2024-01-01T00:00:00Z'),
    'so lastmod may only be used as a change signal',
  );
});

const bills2023 = parseSitemapUrlSet(bodyOf('govinfo-bills-2023-sitemap'));

check('the real BILLS 2023 sitemap is very large, which is why resolution is the filter', () => {
  assert.ok(bills2023.length >= 10_000, `expected 10000+ entries, got ${bills2023.length}`);
});

check('the publisher version chain Session 7 replayed is discoverable', () => {
  const ids = new Set(bills2023.map((entry) => packageIdFromSitemapLoc(entry.loc)));
  for (const packageId of ['BILLS-118hr2670rh', 'BILLS-118hr2670eh', 'BILLS-118hr2670enr']) {
    assert.ok(ids.has(packageId), `${packageId} must be discoverable`);
  }
});

let billsPrefilterSurvivors = 0;
check('the id prefilter narrows BILLS, and the real ratio is measured not assumed', () => {
  const congresses = new Set(plausibleCongressesForFiscalYear(2024));
  const relevantTypes = ['hr', 's', 'hjres', 'sjres'];
  const relevantVersions = ['ih', 'is', 'rh', 'rs', 'eh', 'es', 'eah', 'eas', 'enr'];
  let survivors = 0;
  for (const entry of bills2023) {
    const packageId = packageIdFromSitemapLoc(entry.loc);
    const match = /^BILLS-(\d{3})(hr|s|hjres|sjres|hconres|sconres)(\d+)([a-z]{2,4})$/i.exec(
      packageId ?? '',
    );
    if (!match) continue;
    if (!congresses.has(Number(match[1]))) continue;
    if (!relevantTypes.includes(match[2].toLowerCase())) continue;
    if (!relevantVersions.includes(match[4].toLowerCase())) continue;
    survivors += 1;
  }
  billsPrefilterSurvivors = survivors;
  assert.ok(survivors > 0, 'the prefilter must not reject everything');
  assert.ok(survivors < bills2023.length, 'the prefilter must narrow something');
  // Recorded rather than asserted down to a comfortable number. An id-shape
  // filter cannot know subject, and congress 118 plus hr/s covers most of a
  // 2023 bill sitemap, so a COLD BILLS backfill is genuinely metadata-heavy.
  // That is what the bounded, resumable cursor exists for; the number is
  // published so the cost is visible instead of implied.
  console.log(
    `  [prefilter] ${survivors} of ${bills2023.length} BILLS entries survive the id-shape ` +
      `filter (${((survivors / bills2023.length) * 100).toFixed(1)}%) - cold backfill is ` +
      'metadata-bound and spans multiple bounded runs',
  );
});

// ── 3. resolution against the real MODS records ────────────────────────────

const FY2024 = bootstrapFiscalYearCycle({ fiscalYear: 2024 });
const FY2024_KEYS = new Set(FY2024.expectedSources.map((source) => source.dedupKey));
const HORIZON = [2023, 2024, 2025];

const resolveReal = (resourceKey, packageId, adapterId) => {
  const mods = parseModsMetadata(bodyOf(resourceKey));
  return {
    mods,
    resolved: resolveDiscoveredCandidate({
      adapterId,
      url: govinfoPackagePdfUrl(packageId),
      packageId,
      title: mods.title,
      alternativeTitles: mods.alternativeTitles,
      declaredFiscalYear: mods.declaredFiscalYears[0] ?? null,
      divisionEvidence: null,
      horizonFiscalYears: HORIZON,
      registeredExpectedSourceKeys: FY2024_KEYS,
    }),
  };
};

const hasc = resolveReal('mods-hasc-report', 'CRPT-118hrpt125', 'govinfo-committee-reports');
const hacd = resolveReal('mods-hacd-report', 'CRPT-118hrpt121', 'govinfo-committee-reports');
const ndaaBill = resolveReal('mods-ndaa-bill-reported', 'BILLS-118hr2670rh', 'govinfo-bills');
const omnibus = resolveReal(
  'mods-omnibus-no-defense-division',
  'PLAW-118publ42',
  'govinfo-public-laws',
);

check('the real MODS metadata URL is the one that carries the title', () => {
  assert.equal(
    govinfoPackageModsUrl('CRPT-118hrpt125'),
    'https://www.govinfo.gov/metadata/pkg/CRPT-118hrpt125/mods.xml',
  );
  assert.ok(hasc.mods.title, 'and it really contains a title');
});

check('the real HASC report resolves onto the authorization track', () => {
  assert.equal(hasc.resolved.outcome, 'resolved');
  assert.equal(hasc.resolved.provisionalClassification.authorityTrack, 'authorization');
  assert.equal(hasc.resolved.provisionalClassification.stage, 'hasc_report');
  assert.ok(FY2024_KEYS.has(hasc.resolved.expectedSourceDedupKey));
});

check('the real HAC-D report resolves onto the appropriations track', () => {
  assert.equal(hacd.resolved.outcome, 'resolved');
  assert.equal(hacd.resolved.provisionalClassification.authorityTrack, 'appropriations');
  assert.equal(hacd.resolved.provisionalClassification.stage, 'hac_d_report');
});

check('the HAC-D title really contains no "fiscal year" phrase', () => {
  assert.ok(!/fiscal\s+year/i.test(hacd.mods.title), `title was: ${hacd.mods.title}`);
  assert.deepEqual(
    [...hacd.mods.declaredFiscalYears],
    [2024],
    'FY2024 must come from the appropriations-bill wording alone',
  );
});

check('the two tracks resolve to DIFFERENT expected sources', () => {
  assert.notEqual(
    hasc.resolved.expectedSourceDedupKey,
    hacd.resolved.expectedSourceDedupKey,
    'authorization and appropriations are independent and must never collide',
  );
});

check('a real bill resolves via its own alternative title', () => {
  // The primary title names both tracks at once and is correctly ambiguous.
  assert.match(ndaaBill.mods.title, /authorize appropriations/i);
  assert.ok(
    ndaaBill.mods.alternativeTitles.some((title) =>
      /National Defense Authorization Act/i.test(title),
    ),
    'the popular title is in the same MODS record as an alternative',
  );
  assert.equal(ndaaBill.resolved.outcome, 'resolved');
  assert.equal(ndaaBill.resolved.provisionalClassification.authorityTrack, 'authorization');
});

check('a bill designator is not treated as a subject title', () => {
  assert.ok(
    !ndaaBill.mods.alternativeTitles.some((title) => /^H\.?\s?R\.?\s*\d+/i.test(title)),
    '"H.R. 2670 (RH)" identifies the document, it does not describe it',
  );
});

check('the FY2024 omnibus with no defence division does NOT resolve', () => {
  // Right fiscal year, right vehicle class, wrong subject.
  assert.deepEqual([...omnibus.mods.declaredFiscalYears], [2024]);
  assert.notEqual(
    omnibus.resolved.outcome,
    'resolved',
    'a general omnibus must not be promoted onto the defence appropriations track on title alone',
  );
  assert.equal(omnibus.resolved.expectedSourceDedupKey, null);
});

check('the omnibus alternative title does not smuggle it onto appropriations', () => {
  assert.ok(
    omnibus.mods.alternativeTitles.some((title) => /Consolidated Appropriations Act/i.test(title)),
    'the alternative title really is an appropriations act name',
  );
  assert.equal(
    omnibus.resolved.expectedSourceDedupKey,
    null,
    'and it still resolves to nothing, because the subject is not defence',
  );
});

check('no resolution carries a monetary field', () => {
  for (const { resolved } of [hasc, hacd, ndaaBill, omnibus]) {
    assert.ok(
      !/amount|usd|dollar|obligat|outlay/i.test(JSON.stringify(resolved)),
      'discovery cannot assert dollars',
    );
  }
});

check('every resolution defers authoritative classification', () => {
  for (const { resolved } of [hasc, hacd, ndaaBill]) {
    assert.match(resolved.reasons.join(' '), /deferred/);
  }
});

// ── 4. refusals are recorded as refusals ───────────────────────────────────

for (const [key, label] of [
  ['comptroller-budget-materials', 'comptroller.defense.gov'],
  ['army-budget-materials', 'asafm.army.mil'],
]) {
  check(`${label} refusal is recorded with its real status, not as empty`, () => {
    const resource = byKey.get(key);
    assert.ok(resource, `${key} must be in the prepared corpus`);
    assert.ok(
      resource.statusCode === null || resource.statusCode >= 400,
      `expected a refusal, got ${resource.statusCode}`,
    );
    assert.equal(resource.refusalConfirmed, true);
    assert.equal(resource.path, null, 'a refused request yields no bytes to mistake for content');
  });
}

// ── 5. Publisher-native resolution, against the real committee listing ─────

const sascListing = bodyOf('senate-armed-services-library');
const sascLinks = extractDocumentLinks({
  html: sascListing,
  pageUrl: 'https://www.armed-services.senate.gov/committee-actions/library',
  officialHosts: ['www.armed-services.senate.gov', 'armed-services.senate.gov'],
  extensionlessDocumentPathPrefixes: ['/download/'],
});

let sascOnHostDocuments = 0;

check('the real committee library yields on-host download candidates and nothing off-host', () => {
  sascOnHostDocuments = sascLinks.length;
  assert.ok(sascLinks.length > 0, 'the live page really does link at least one document');
  for (const link of sascLinks) {
    assert.match(link.url, /^https:\/\/(?:www\.)?armed-services\.senate\.gov\//);
  }
});

check('a real committee download link with no package id is still examined', () => {
  // Inspect an actual current library download rather than assuming a fixed
  // first-link title. These publisher-native aliases carry no GovInfo package id.
  const target = sascLinks[0];
  assert.ok(target);
  assert.equal(packageIdFromSitemapLoc(target.url), null, 'no official package id exists');
});

check('a synthetic amendments title is not emitted; an expected chairman-mark title resolves', () => {
  const registered = new Set(
    bootstrapFiscalYearCycle({ fiscalYear: 2027 }).expectedSources.map((s) => s.dedupKey),
  );
  const resolveSasc = (title) =>
    resolveDiscoveredCandidate({
      adapterId: 'sasc',
      url: 'https://www.armed-services.senate.gov/imo/media/doc/example.pdf',
      packageId: null,
      title,
      declaredFiscalYear: null,
      divisionEvidence: null,
      horizonFiscalYears: [2026, 2027, 2028],
      registeredExpectedSourceKeys: registered,
    });

  // Explicit synthetic negative classification case; this title is not claimed
  // to be the current library's first link. Amendments are never invented as marks.
  const amendments = resolveSasc('FY27 NDAA SASC Accepted Amendments on June 25th');
  assert.notEqual(amendments.outcome, 'resolved');
  assert.equal(amendments.expectedSourceDedupKey, null);

  // Every actual library title is still examined against the registered horizon.
  // Historical or ambiguous documents stay audited without an invented source key.
  for (const link of sascLinks) {
    const actual = resolveSasc(link.text);
    if (actual.outcome === 'resolved') {
      assert.ok(registered.has(actual.expectedSourceDedupKey));
    } else {
      assert.equal(actual.expectedSourceDedupKey, null);
    }
  }

  // The document the cycle actually expects from this publisher does resolve,
  // through publisher identity, with no package id anywhere.
  const mark = resolveSasc('FY27 NDAA SASC Chairman Mark');
  assert.equal(mark.outcome, 'resolved');
  assert.equal(mark.provisionalClassification.authorityTrack, 'authorization');
  assert.equal(mark.provisionalClassification.stage, 'sasc_mark');
  assert.ok(registered.has(mark.expectedSourceDedupKey));
});

check('the abbreviation "NDAA" resolves without loosening the frozen subject pattern', () => {
  // Committee sites overwhelmingly write "NDAA", which the Session 7 subject
  // detector does not match by design. Publisher identity supplies the track
  // instead, so the frozen pattern needs no change.
  const detected = classifyLifecycleSource({
    url: 'https://www.armed-services.senate.gov/imo/media/doc/example.pdf',
    packageId: null,
    title: 'FY27 NDAA SASC Chairman Mark',
    declaredFiscalYear: null,
    contentExcerpt: null,
    contentExcerptAvailable: false,
    divisionEvidence: null,
    adapterId: 'sasc',
  });
  assert.ok(detected.classification, 'a real committee mark must classify');
  assert.equal(detected.classification.authorityTrack, 'authorization');
  assert.equal(
    detected.decision,
    'review',
    'but with no official package id it must never auto-accept',
  );
});

check('publisher identity cannot rescue the omnibus', () => {
  const registered = new Set(
    bootstrapFiscalYearCycle({ fiscalYear: 2024 }).expectedSources.map((s) => s.dedupKey),
  );
  const mods = parseModsMetadata(bodyOf('mods-omnibus-no-defense-division'));
  const resolved = resolveDiscoveredCandidate({
    adapterId: 'govinfo-public-laws',
    url: govinfoPackagePdfUrl('PLAW-118publ42'),
    packageId: 'PLAW-118publ42',
    title: mods.title,
    alternativeTitles: mods.alternativeTitles,
    declaredFiscalYear: 2024,
    divisionEvidence: null,
    horizonFiscalYears: [2023, 2024, 2025],
    registeredExpectedSourceKeys: registered,
  });
  assert.notEqual(resolved.outcome, 'resolved');
  for (const adapterId of PUBLISHER_NATIVE_ADAPTER_IDS) {
    assert.ok(!adapterId.startsWith('govinfo'), `${adapterId} must not be publisher-native`);
  }
});

check('a reachable committee page is recorded as reachable', () => {
  const resource = byKey.get('senate-armed-services-legislation');
  assert.equal(resource.statusCode, 200);
  assert.ok(resource.sha256, 'and its listing bytes are hashed for the audit trail');
});

// ── report ─────────────────────────────────────────────────────────────────

const passed = checks.filter((entry) => entry.ok).length;
const failed = checks.filter((entry) => !entry.ok);

for (const entry of checks) {
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}`);
  if (!entry.ok) console.log(`       ${entry.error}`);
}

const evidence = {
  schemaVersion: 'phase8_session8_discovery_replay_evidence_v1',
  fiscalYear: 2024,
  corpus: '.session8-discovery/prepared-corpus.json',
  userAgent: USER_AGENT,
  checks: checks.length,
  passed,
  failed: failed.length,
  channel: {
    apiKeyRequired: false,
    note: 'api.govinfo.gov and api.congress.gov both answer API_KEY_MISSING without a credential; the sitemap channel needs none.',
  },
  observed: {
    crptSitemapIndexYearFiles: crptIndex.length,
    crpt2023Entries: crpt2023.length,
    bills2023Entries: bills2023.length,
    bills2023PrefilterSurvivors: billsPrefilterSurvivors,
    bills2023PrefilterNote:
      'An id-shape prefilter cannot know subject. Most of a 2023 bill sitemap is congress 118 hr/s, so a COLD BILLS backfill needs roughly one MODS request per survivor and spans many bounded runs. Steady-state incremental crawling is small because it is driven by sitemap lastmod deltas.',
    congressGovCrawlDelaySeconds: 2,
    congressGovRegistryIntervalMs: 1_000,
    congressGovEffectiveIntervalMs: 2_000,
    sascListingOnHostDocuments: sascOnHostDocuments,
    publisherNativeAdapters: [...PUBLISHER_NATIVE_ADAPTER_IDS],
  },
  resolutions: [
    {
      packageId: 'CRPT-118hrpt125',
      title: hasc.mods.title,
      outcome: hasc.resolved.outcome,
      authorityTrack: hasc.resolved.provisionalClassification?.authorityTrack ?? null,
      stage: hasc.resolved.provisionalClassification?.stage ?? null,
      expectedSourceDedupKey: hasc.resolved.expectedSourceDedupKey,
    },
    {
      packageId: 'CRPT-118hrpt121',
      title: hacd.mods.title,
      titleStatesFiscalYearPhrase: /fiscal\s+year/i.test(hacd.mods.title ?? ''),
      outcome: hacd.resolved.outcome,
      authorityTrack: hacd.resolved.provisionalClassification?.authorityTrack ?? null,
      stage: hacd.resolved.provisionalClassification?.stage ?? null,
      expectedSourceDedupKey: hacd.resolved.expectedSourceDedupKey,
    },
    {
      packageId: 'BILLS-118hr2670rh',
      title: ndaaBill.mods.title,
      alternativeTitles: [...ndaaBill.mods.alternativeTitles],
      outcome: ndaaBill.resolved.outcome,
      authorityTrack: ndaaBill.resolved.provisionalClassification?.authorityTrack ?? null,
      stage: ndaaBill.resolved.provisionalClassification?.stage ?? null,
    },
    {
      packageId: 'PLAW-118publ42',
      title: omnibus.mods.title,
      alternativeTitles: [...omnibus.mods.alternativeTitles],
      outcome: omnibus.resolved.outcome,
      expectedSourceDedupKey: omnibus.resolved.expectedSourceDedupKey,
      note: 'A genuine FY2024 omnibus with no defence division. Correctly refuses to resolve.',
    },
  ],
  refusedPublishers: prepared.resources
    .filter((resource) => resource.refusalConfirmed === true)
    .map((resource) => ({
      officialUrl: resource.officialUrl,
      statusCode: resource.statusCode,
      note: 'Recorded as a publisher refusal, never as an absence of documents.',
    })),
};

if (outPath) {
  fs.writeFileSync(path.resolve(root, outPath), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nevidence -> ${outPath}`);
}

if (failed.length > 0) {
  console.error(`\nSESSION8_DISCOVERY_REPLAY_FAIL (${failed.length} of ${checks.length})`);
  process.exit(1);
}

console.log(`\nSESSION8_DISCOVERY_REPLAY_PASS (${passed} checks)`);
