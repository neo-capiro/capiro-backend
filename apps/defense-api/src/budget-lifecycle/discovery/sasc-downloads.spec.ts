import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bootstrapFiscalYearCycle,
  emptyDiscoveryCursor,
  extractDocumentLinks,
} from '@capiro/defense-domain';

import { SourceAdapterRegistry } from '../source-adapter.registry.js';
import { IndexPageCrawler } from './index-page.crawler.js';
import { entryPointsFor } from './publisher-crawler.js';
import { RecordedPublisherHttp } from './testing/discovery-test-doubles.js';

const library = 'https://www.armed-services.senate.gov/committee-actions/library';
const officialHosts = ['www.armed-services.senate.gov', 'armed-services.senate.gov'];
const extract = (href: string, enabled = true) =>
  extractDocumentLinks({
    html: `<a href="${href}">FY2024 NDAA Bill Report</a>`,
    pageUrl: library,
    officialHosts,
    extensionlessDocumentPathPrefixes: enabled ? ['/download/'] : undefined,
  });

test('SASC download aliases require explicit opt-in and retain HTTPS, host and path guards', () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ['/download/reports/fy2024-ndaa-bill-report', true],
    ['/download/fy18-ndaa-sasc-bill-summary-', true],
    ['https://armed-services.senate.gov/download/fy23-ndaa-executive-summary', true],
    ['/imo/media/doc/fy2024_ndaa_bill_report.pdf', true],
    ['/download', false],
    ['/download/', false],
    ['/download/reports/', false],
    ['/download//fy24', false],
    ['/committee-actions/library', false],
    ['/downloads/fy24', false],
    ['http://www.armed-services.senate.gov/download/fy24', false],
    ['https://evil.example/download/fy24', false],
    ['//evil.example/download/fy24', false],
    ['https://www.armed-services.senate.gov.evil.example/download/fy24', false],
    ['/download/%2fsecret', false],
    ['/download/%5csecret', false],
    ['/download/../../secret', false],
    ['/download/fy24.html', false],
    ['javascript:alert(1)', false],
    ['#download', false],
  ];
  for (const [href, accepted] of cases) assert.equal(extract(href).length, accepted ? 1 : 0, href);
  assert.equal(extract('/download/reports/fy2024-ndaa-bill-report', false).length, 0);
  assert.equal(extract('/imo/media/doc/fy2024_ndaa_bill_report.pdf', false).length, 1);
});

test('SASC library aliases are audited and only registered in-horizon marks are emitted', async () => {
  const keys = new Set(
    bootstrapFiscalYearCycle({ fiscalYear: 2027 }).expectedSources.map((s) => s.dedupKey),
  );
  const http = new RecordedPublisherHttp(
    new Map([
      [
        'https://www.armed-services.senate.gov/legislation',
        {
          statusCode: 200,
          body: '<a href="https://www.congress.gov/bill/119th-congress/senate-bill/1">Bill</a>',
        },
      ],
      [
        library,
        {
          statusCode: 200,
          body: [
            '<a href="/download/fy27-ndaa-chairman-mark">FY27 NDAA SASC Chairman Mark</a>',
            '<a href="/download/fy27-amendments">FY27 NDAA SASC Accepted Amendments</a>',
            '<a href="/download/reports/fy2024-ndaa-bill-report">FY2024 NDAA Bill Report</a>',
            '<a href="https://evil.example/download/fy27-mark">FY27 NDAA SASC Chairman Mark</a>',
          ].join(''),
        },
      ],
    ]),
  );
  const product = await new IndexPageCrawler(http).crawl({
    adapter: new SourceAdapterRegistry().get('sasc'),
    nowIso: '2026-09-28T00:00:00.000Z',
    runKey: 'synthetic-sasc-download-test',
    cursor: emptyDiscoveryCursor(),
    horizonFiscalYears: [2026, 2027, 2028],
    registeredExpectedSourceKeys: keys,
    budget: { spent: 0, limit: 10 },
  });
  assert.deepEqual(http.requested, entryPointsFor('sasc', [2027]));
  assert.equal(product.crawls.length, 2);
  assert.equal(product.crawls.find((c) => c.requestUrl === library)?.itemsSeen, 3);
  assert.equal(
    product.crawls.find((c) => c.requestUrl === 'https://www.armed-services.senate.gov/legislation')
      ?.itemsSeen,
    0,
  );
  assert.equal(product.auditCandidates.length, 3);
  assert.equal(product.candidates.length, 1);
  assert.equal(
    product.candidates[0].url,
    'https://www.armed-services.senate.gov/download/fy27-ndaa-chairman-mark',
  );
  assert.ok(keys.has(product.candidates[0].expectedSourceDedupKey));
  assert.ok(
    product.auditCandidates
      .filter((c) => !c.emitted)
      .every((c) => c.expectedSourceDedupKey === null),
  );
});

test('other adapters do not accept extensionless download aliases', async () => {
  const registry = new SourceAdapterRegistry();
  const http = new RecordedPublisherHttp(
    new Map([
      [
        'https://appropriations.house.gov/legislation',
        {
          statusCode: 200,
          body: '<a href="/download/fy27-mark">Department of Defense Appropriations Bill, 2027 Subcommittee Mark</a>',
        },
      ],
    ]),
  );
  const keys = new Set(
    bootstrapFiscalYearCycle({ fiscalYear: 2027 }).expectedSources.map((s) => s.dedupKey),
  );
  const product = await new IndexPageCrawler(http).crawl({
    adapter: registry.get('house-appropriations'),
    nowIso: '2026-09-28T00:00:00.000Z',
    runKey: 'synthetic-other-adapter-test',
    cursor: emptyDiscoveryCursor(),
    horizonFiscalYears: [2026, 2027, 2028],
    registeredExpectedSourceKeys: keys,
    budget: { spent: 0, limit: 10 },
  });
  assert.equal(product.auditCandidates.length, 0);
  assert.equal(product.candidates.length, 0);
});
