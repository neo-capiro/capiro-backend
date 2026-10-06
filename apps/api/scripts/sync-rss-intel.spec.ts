/**
 * Regression coverage for the double-encoded article title/summary bug:
 * /explorer?source=articles (canonical) and os.capiro.ai/explorer (News Feed)
 * both rendered raw HTML entities — e.g. a title containing literal
 * "&#8216;" and a summary containing literal "&lt;p&gt;President &lt;a
 * href=...". Root cause: extractText() stripped HTML tags via regex but
 * never decoded entities, so escaped markup in <description> never matched
 * the strip regex, and numeric/named entities in <title> passed through
 * untouched. Fixtures below are shaped like real feed items (2026-08-18).
 */
import {
  ALL_FEEDS,
  FUTURE_PUBLISHED_TOLERANCE_MS,
  decodeEntities,
  extractText,
  extractCategories,
  publishedAtFor,
  retainInputFor,
  validateFeedXml,
  loadConfiguredFeed,
} from './sync-rss-intel';

describe('configured publisher feed recovery', () => {
  const oldFlag = process.env.LEGIWATCH_NEWS_INGEST_ENABLED;
  const feed = (source: string) => ALL_FEEDS.find((entry) => entry.source === source)!;
  const rss =
    '<rss version="2.0"><channel><item><title>Primary publication</title><link>https://www.dhs.gov/news/primary</link></item></channel></rss>';
  const fallbackBody = (source: string) =>
    source === 'dhs'
      ? '<div class="view-id-news_events"><li class="usa-collection__item"><h3 class="usa-collection__heading"><a href="/news/2026/10/05/release">Official release</a></h3><time datetime="2026-10-05"></time></li></div>'
      : JSON.stringify({
          data: [
            {
              type: 'news',
              href: 'https://www.commerce.gov/news/release',
              label: 'Official release',
              post_date_formatted: '2026-10-05T12:00:00Z',
            },
          ],
        });
  beforeEach(() => {
    process.env.LEGIWATCH_NEWS_INGEST_ENABLED = 'true';
  });
  afterEach(() => {
    if (oldFlag === undefined) delete process.env.LEGIWATCH_NEWS_INGEST_ENABLED;
    else process.env.LEGIWATCH_NEWS_INGEST_ENABLED = oldFlag;
  });
  it('prefers a successful primary feed and does not request an alternative', async () => {
    const fetcher = jest.fn(async () => new Response(rss));
    const result = await loadConfiguredFeed(feed('dhs'), fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      provider: 'rss',
      primaryFailure: null,
      sourceUrl: feed('dhs').url,
    });
    expect(result.items[0]?.title).toBe('Primary publication');
  });
  it.each([
    ['dhs', 503, 'https://www.dhs.gov/news-releases/press-releases', 'dhs-press-index'],
    [
      'commerce',
      403,
      'https://api.commerce.gov/api/news?api_key=DEMO_KEY&sort=-created&page%5Blimit%5D=30',
      'commerce-news-api',
    ],
  ])(
    'recovers only through the exact reviewed %s alternative and retains original failure',
    async (source, status, url, provider) => {
      const fetcher = jest
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: Number(status) }))
        .mockResolvedValueOnce(new Response(fallbackBody(String(source))));
      const result = await loadConfiguredFeed(feed(String(source)), fetcher as typeof fetch);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[1]?.[0]).toBe(url);
      expect(result).toMatchObject({
        sourceUrl: url,
        provider,
        primaryFailure: `rss_http_${status}`,
      });
      expect(result.items).toHaveLength(1);
      if (source === 'dhs') {
        const retained = retainInputFor(
          feed('dhs'),
          result.items[0]!,
          new Date('2026-10-06T12:00:00Z'),
          result.provider,
        );
        expect(retained).toMatchObject({
          publishedAt: '2026-10-05',
          publicationPrecision: 'day',
          provider: 'dhs-press-index',
          source: 'dhs',
          rights: 'excerpt',
        });
        expect(retained.feedUrl).toBe('https://www.dhs.gov/rss.xml');
      }
    },
  );
  it.each(['false', undefined])(
    'does not use publisher alternatives when feature is %s',
    async (flag) => {
      if (flag === undefined) delete process.env.LEGIWATCH_NEWS_INGEST_ENABLED;
      else process.env.LEGIWATCH_NEWS_INGEST_ENABLED = flag;
      const fetcher = jest.fn(async () => new Response(null, { status: 503 }));
      await expect(loadConfiguredFeed(feed('dhs'), fetcher as typeof fetch)).rejects.toThrow(
        'rss_http_503',
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['dhs', 'commerce'])(
    'does not request another %s route after a rate limit',
    async (source) => {
      const fetcher = jest.fn(
        async () => new Response(null, { status: 429, headers: { 'Retry-After': '3600' } }),
      );
      await expect(loadConfiguredFeed(feed(source), fetcher as typeof fetch)).rejects.toThrow(
        'rss_http_429',
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('does not invent an alternative for another configured publisher', async () => {
    const fetcher = jest.fn(async () => new Response(null, { status: 403 }));
    await expect(loadConfiguredFeed(feed('state_dept'), fetcher as typeof fetch)).rejects.toThrow(
      'rss_http_403',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['dhs', 'commerce'])(
    'preserves primary failure when the %s alternative is an HTML challenge',
    async (source) => {
      const fetcher = jest
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response('<html>Access denied</html>'));
      await expect(loadConfiguredFeed(feed(source), fetcher as typeof fetch)).rejects.toThrow(
        /rss_http_503; /,
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it('retains an invalid-primary-feed error after successful qualified recovery', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(new Response('<html>Maintenance</html>'))
      .mockResolvedValueOnce(new Response(fallbackBody('dhs')));
    const result = await loadConfiguredFeed(feed('dhs'), fetcher as typeof fetch);
    expect(result.primaryFailure).toMatch(/^rss_invalid_feed:/);
    expect(result.provider).toBe('dhs-press-index');
  });
});

describe('decodeEntities', () => {
  it('decodes named XML/HTML entities', () => {
    expect(decodeEntities('Fish &amp; Wildlife')).toBe('Fish & Wildlife');
    expect(decodeEntities('&lt;p&gt;')).toBe('<p>');
    expect(decodeEntities('&quot;quoted&quot;')).toBe('"quoted"');
    expect(decodeEntities('it&apos;s')).toBe("it's");
  });

  it('decodes numeric decimal character references (smart quotes)', () => {
    expect(decodeEntities('&#8216;big beautiful bill&#8217;')).toBe('‘big beautiful bill’');
  });

  it('decodes numeric hex character references', () => {
    expect(decodeEntities('&#x2019;')).toBe('’');
  });

  it('leaves malformed/unknown entities untouched instead of corrupting them', () => {
    expect(decodeEntities('Q&A session')).toBe('Q&A session');
    expect(decodeEntities('&foobar;')).toBe('&foobar;');
  });
});

describe('extractText', () => {
  it('decodes numeric entities in a plain (non-CDATA) title', () => {
    const item = `<title>Trump&#8217;s &#8216;big beautiful bill&#8217; heads to Senate</title>`;
    expect(extractText(item, 'title')).toBe('Trump’s ‘big beautiful bill’ heads to Senate');
  });

  it('decodes entity-escaped markup in <description> and strips the resulting tags', () => {
    const item = `<description>&lt;p&gt;President &lt;a href="https://example.com/biden"&gt;Biden&lt;/a&gt; announced new sanctions today.&lt;/p&gt;</description>`;
    const result = extractText(item, 'description');
    expect(result).toBe('President Biden announced new sanctions today.');
    expect(result).not.toMatch(/&lt;|&gt;|&amp;/);
    expect(result).not.toMatch(/<[^>]+>/);
  });

  it('strips real HTML tags from a CDATA-wrapped description (not just entity-escaped ones)', () => {
    const item = `<description><![CDATA[<p>Update on <a href="https://example.com">the bill</a>.</p>]]></description>`;
    expect(extractText(item, 'description')).toBe('Update on the bill .');
  });

  it('returns null for a missing tag', () => {
    expect(extractText('<title>Only a title</title>', 'description')).toBeNull();
  });
});

describe('extractCategories', () => {
  it('decodes entities inside category names', () => {
    const item = `<category>Foreign Affairs &amp; Trade</category><category>Defense</category>`;
    expect(extractCategories(item)).toEqual(['Foreign Affairs & Trade', 'Defense']);
  });
});

/**
 * Feed-root validation: an HTTP 200 body must actually BE an RSS/Atom/RDF
 * document before the item-splitter may claim source health. The DOJ /news
 * HTML capture (2026-09-15, official-rss-captures/doj_page.txt) proved the
 * old path accepted a 200 HTML press page as "success, 0 items".
 */
describe('validateFeedXml', () => {
  it('accepts a populated RSS 2.0 feed', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>HHS News</title>
<item><title>Press release</title><link>https://www.hhs.gov/about/news/2026/09/01/x.html</link></item>
</channel></rss>`;
    expect(validateFeedXml(xml)).toBeNull();
  });

  it('accepts a genuinely empty RSS feed (success with 0 items stays valid)', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`;
    expect(validateFeedXml(xml)).toBeNull();
  });

  it('accepts a populated Atom feed (root <feed>, namespaced)', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>VA News</title>
<entry><title>Release</title><link href="https://news.va.gov/123/"/></entry>
</feed>`;
    expect(validateFeedXml(xml)).toBeNull();
  });

  it('accepts an empty Atom feed', () => {
    expect(
      validateFeedXml(`<feed xmlns="http://www.w3.org/2005/Atom"><title>E</title></feed>`),
    ).toBeNull();
  });

  it('accepts an RSS 1.0 RDF feed', () => {
    const xml = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
<channel rdf:about="https://example.com/"><title>RDF feed</title></channel>
<item rdf:about="https://example.com/1"><title>One</title><link>https://example.com/1</link></item>
</rdf:RDF>`;
    expect(validateFeedXml(xml)).toBeNull();
  });

  it('accepts a feed with XML prolog, comments and a BOM before the root', () => {
    const xml = `﻿<?xml version="1.0" encoding="UTF-8"?>
<!-- generator: agency cms -->
<?xml-stylesheet type="text/xsl" href="feed.xsl"?>
<rss version="2.0"><channel><title>C</title></channel></rss>`;
    expect(validateFeedXml(xml)).toBeNull();
  });

  it('accepts a valid RSS feed larger than the old 256KB validation prefix', () => {
    // Defect #1 probe: a fully valid 280161-byte RSS body was rejected as
    // "unclosed" because validation ran only on a 256KB prefix and treated
    // the truncated prefix as the whole document. Validation now covers the
    // complete body, so size alone must not fail a well-formed feed.
    const item =
      '<item><title>Press release</title><link>https://www.hhs.gov/about/news/2026/09/01/x.html</link>' +
      `<description>${'x'.repeat(4096)}</description></item>`;
    let body = '';
    while (Buffer.byteLength(body) + Buffer.byteLength(item) < 270 * 1024) body += item;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>HHS News</title>${body}</channel></rss>`;
    expect(Buffer.byteLength(xml)).toBeGreaterThan(256 * 1024);
    expect(validateFeedXml(xml)).toBeNull();
  });

  it('accepts a valid Atom feed larger than the old 256KB validation prefix', () => {
    const entry =
      '<entry><title>Release</title><link href="https://news.va.gov/123/"/>' +
      `<summary>${'y'.repeat(4096)}</summary></entry>`;
    let body = '';
    while (Buffer.byteLength(body) + Buffer.byteLength(entry) < 270 * 1024) body += entry;
    const xml = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>VA News</title>${body}</feed>`;
    expect(Buffer.byteLength(xml)).toBeGreaterThan(256 * 1024);
    expect(validateFeedXml(xml)).toBeNull();
  });

  it('accepts an RSS 1.0 RDF feed with a default (unprefixed) RDF namespace', () => {
    const xml = `<?xml version="1.0"?>
<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<channel about="https://example.com/"><title>RDF feed</title></channel>
<item about="https://example.com/1"><title>One</title><link>https://example.com/1</link></item>
</RDF>`;
    expect(validateFeedXml(xml)).toBeNull();
  });

  it('rejects a >256KB document whose tail is malformed (not just a bad prefix)', () => {
    // Whole-document validation must keep reading past the old 256KB mark: a
    // body that is well-formed in its first 256KB but broken near the end is
    // still invalid — truncation would have silently accepted it.
    const filler = `<item><title>t</title><link>https://e.com/1</link><description>${'z'.repeat(4096)}</description></item>`;
    let body = '';
    while (Buffer.byteLength(body) + Buffer.byteLength(filler) < 270 * 1024) body += filler;
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${body}<item><title>broken</title>`;
    expect(Buffer.byteLength(xml)).toBeGreaterThan(256 * 1024);
    expect(validateFeedXml(xml)).not.toBeNull();
  });

  it('rejects an HTTP 200 HTML page (the DOJ /news false-health case)', () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title>News | DOJ</title></head>
<body><h1>Press releases</h1><script>var feed='<rss>not a feed</rss>';</script></body></html>`;
    const err = validateFeedXml(html);
    expect(err).not.toBeNull();
    expect(err).toMatch(/not an RSS\/Atom\/RDF feed/);
  });

  it('does not false-accept HTML that merely contains the substring "<rss"', () => {
    const html = `<html><body><p>Subscribe via &lt;rss&gt; or our newsletter.</p></body></html>`;
    expect(validateFeedXml(html)).not.toBeNull();
  });

  it('rejects a JSON body', () => {
    expect(validateFeedXml('{"items":[]}')).not.toBeNull();
  });

  it('rejects a truncated/invalid XML document', () => {
    expect(
      validateFeedXml('<?xml version="1.0"?><rss version="2.0"><channel><title>oops'),
    ).not.toBeNull();
  });

  it('rejects a valid XML document whose root is not a feed', () => {
    expect(validateFeedXml('<?xml version="1.0"?><html><body>hi</body></html>')).not.toBeNull();
  });
});

/**
 * Regression (os.capiro.ai Dashboard Wire, 2026-09-16): with
 * LEGIWATCH_NEWS_INGEST_ENABLED=true the retain() call passed only
 * `publisher: hostname`, and NewsEvidenceService wrote that hostname into
 * intel_article.source. Every saved source filter (the_hill, politico, dod…)
 * is keyed on the feed slug, so the shared news feed matched nothing and the
 * Wire showed "No stories match these subscriptions" for ten days.
 */
describe('retainInputFor', () => {
  const feed = ALL_FEEDS.find((entry) => entry.source === 'the_hill')!;
  const now = new Date('2026-09-16T15:00:00.000Z');
  const item = {
    url: 'https://thehill.com/policy/defense/12345-example/',
    title: 'Example',
    description: 'Summary',
    pubDate: 'Tue, 15 Sep 2026 23:28:55 +0000',
    author: null,
    categories: ['Defense'],
  };

  it('labels the shared-corpus row with the feed slug and keeps the hostname as publisher', () => {
    const input = retainInputFor(feed, item, now);
    expect(input.source).toBe('the_hill');
    expect(input.publisher).toBe('thehill.com');
    expect(input.feedUrl).toBe('https://thehill.com/feed/');
    expect(input.provider).toBe('rss');
    expect(input.rights).toBe('excerpt');
    expect(input.publishedAt).toBe('2026-09-15T23:28:55.000Z');
  });

  it('never lets a slug drift from the configured feed, whatever host the link points at', () => {
    const dod = ALL_FEEDS.find((entry) => entry.source === 'dod')!;
    // The DoD feed links out to 19 different .mil/.gov hosts in production.
    const input = retainInputFor(
      dod,
      { ...item, url: 'https://ndupress.ndu.edu/Media/News/x/' },
      now,
    );
    expect(input.source).toBe('dod');
    expect(input.publisher).toBe('ndupress.ndu.edu');
  });
});

describe('publishedAtFor', () => {
  const now = new Date('2026-09-16T15:00:00.000Z');

  it('keeps a past or slightly-ahead publication instant', () => {
    expect(publishedAtFor('2026-09-15T23:28:55Z', now)?.toISOString()).toBe(
      '2026-09-15T23:28:55.000Z',
    );
    const skew = new Date(now.getTime() + FUTURE_PUBLISHED_TOLERANCE_MS - 1000);
    expect(publishedAtFor(skew.toISOString(), now)?.getTime()).toBe(skew.getTime());
  });

  it('drops a future-dated pubDate so the sync instant is used instead', () => {
    // Observed live: a DOJ "FY26 Q4 Data Due" item stamped 2026-10-30 sat at
    // the top of every published_at-desc news list for six weeks.
    expect(publishedAtFor('2026-10-30T12:00:00Z', now)).toBeNull();
    const feed = ALL_FEEDS.find((entry) => entry.source === 'doj')!;
    const input = retainInputFor(
      feed,
      {
        url: 'https://www.justice.gov/x',
        title: 'FY26 Q4 Data Due',
        description: null,
        pubDate: '2026-10-30T12:00:00Z',
        author: null,
        categories: [],
      },
      now,
    );
    expect(input.publishedAt).toBeUndefined();
  });

  it('drops missing or unparseable dates', () => {
    expect(publishedAtFor(null, now)).toBeNull();
    expect(publishedAtFor('not a date', now)).toBeNull();
  });
});
