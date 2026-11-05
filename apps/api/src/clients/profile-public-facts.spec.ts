import {
  combinePublicFactSources,
  sourcedLocation,
  sourcedNews,
  type ExtractedNews,
} from './profile-public-facts.js';

const now = new Date('2026-11-04T12:00:00Z');
const url = 'https://synthetic.example/news/award';
const quote = 'Synthetic Systems received a Navy contract for autonomous inspection.';
const source = { url, text: `October 20, 2026. ${quote}` };
const news: ExtractedNews = {
  title: 'Navy inspection contract',
  summary: quote,
  publishedAt: '2026-10-20',
  evidenceUrl: url,
  quote,
  dateQuote: 'October 20, 2026',
};

describe('sourced current news', () => {
  test('retains a supported date, publisher, link and exact evidence', () => {
    expect(sourcedNews([news], [source], now)).toEqual([
      {
        title: news.title,
        summary: quote,
        publishedAt: '2026-10-20T00:00:00.000Z',
        publisher: 'synthetic.example',
        url,
        quote,
      },
    ]);
  });
  test.each([null, 'not a date', '2025-11-03', '2026-11-05'])(
    'omits missing, invalid, expired or future publication dates: %s',
    (publishedAt) => {
      expect(sourcedNews([{ ...news, publishedAt }], [{ ...source, publishedAt }], now)).toEqual(
        [],
      );
    },
  );
  test('does not use an invented quote, date, or unacquired source', () => {
    expect(sourcedNews([{ ...news, quote: 'Invented source text' }], [source], now)).toEqual([]);
    expect(sourcedNews([{ ...news, dateQuote: 'October 21, 2026' }], [source], now)).toEqual([]);
    expect(
      sourcedNews([{ ...news, evidenceUrl: 'https://other.example/' }], [source], now),
    ).toEqual([]);
  });
  test('merges acquired page and provider date evidence for the same URL', () => {
    const sources = combinePublicFactSources([
      { url, text: quote },
      { url, text: news.title, publishedAt: '2026-10-20' },
    ]);
    expect(sourcedNews([{ ...news, dateQuote: null }], sources, now)).toHaveLength(1);
    expect(
      sourcedNews(
        [{ ...news, dateQuote: null }],
        [{ url, text: quote, publishedAt: 'invalid' }],
        now,
      ),
    ).toEqual([]);
  });
  test('ranks government work first and deduplicates unchanged source events', () => {
    const other = {
      ...news,
      title: 'New corporate branding',
      summary: 'Synthetic Systems introduced a new logo.',
      quote: 'Synthetic Systems introduced a new logo.',
      evidenceUrl: 'https://synthetic.example/news/logo',
    };
    const result = sourcedNews(
      [other, news, news],
      [source, { url: other.evidenceUrl, text: `October 20, 2026 ${other.quote}` }],
      now,
    );
    expect(result.map((row) => row.title)).toEqual([news.title, other.title]);
  });
});

describe('researched location metadata', () => {
  const facility = {
    name: 'Synthetic shipyard',
    addressLine: null,
    city: 'Franklin',
    state: 'la',
    zip: null,
    country: 'US',
    siteRole: 'manufacturing',
    siteStatus: 'under_construction',
    sourceKind: 'company',
    evidenceUrl: url,
    quote: 'The Synthetic shipyard is under construction in Franklin, Louisiana.',
  };
  const locationSource = { url, text: facility.quote };
  test('retains sourced country, role and construction status without inventing a district', () => {
    expect(sourcedLocation(facility, locationSource, now.toISOString())).toMatchObject({
      country: 'US',
      siteRole: 'manufacturing',
      siteStatus: 'under_construction',
      siteVerificationStatus: 'unverified',
      state: 'LA',
      sourceEvidence: [{ sourceType: 'company', sourceUrl: url, evidence: facility.quote }],
    });
    expect(sourcedLocation(facility, locationSource, now.toISOString())).not.toHaveProperty(
      'congressionalDistrict',
    );
  });
  test.each(['job_posting', 'company'])(
    'job-posting-only evidence cannot establish operating status (%s)',
    (sourceKind) => {
      const jobSource = { ...locationSource, url: 'https://synthetic.example/careers/engineer' };
      expect(
        sourcedLocation(
          { ...facility, siteStatus: 'operating', sourceKind },
          jobSource,
          now.toISOString(),
        ),
      ).toMatchObject({
        siteStatus: 'unknown',
        siteVerificationStatus: 'unverified',
        sourceEvidence: [{ sourceType: 'job_posting' }],
      });
    },
  );
  test('retains explicit international country and leaves absent country/role unknown', () => {
    expect(
      sourcedLocation({ ...facility, country: 'gb' }, locationSource, now.toISOString())?.country,
    ).toBe('GB');
    const unknown = sourcedLocation(
      { ...facility, country: null, siteRole: null, siteStatus: null },
      locationSource,
      now.toISOString(),
    );
    expect(unknown).not.toHaveProperty('country');
    expect(unknown).not.toHaveProperty('siteRole');
    expect(unknown?.siteStatus).toBe('unknown');
  });
  test('omits unsupported evidence and invalid canonical values', () => {
    expect(
      sourcedLocation(
        { ...facility, quote: 'Invented facility' },
        locationSource,
        now.toISOString(),
      ),
    ).toBeNull();
    expect(
      sourcedLocation({ ...facility, country: 'USA' }, locationSource, now.toISOString()),
    ).toBeNull();
    expect(
      sourcedLocation(
        { ...facility, siteStatus: 'probably operating' },
        locationSource,
        now.toISOString(),
      ),
    ).toBeNull();
  });
});
