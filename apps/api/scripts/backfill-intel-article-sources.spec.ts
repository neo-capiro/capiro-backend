import {
  feedSlugMap,
  looksLikeHostname,
  slugForOrphanSource,
} from './backfill-intel-article-sources';
import { ALL_FEEDS, CORE_FEEDS, FLORIDA_FEEDS } from './sync-rss-intel';

describe('backfill-intel-article-sources planning', () => {
  it('maps every configured feed_url to exactly one canonical slug', () => {
    const map = feedSlugMap();
    expect(map.size).toBe(ALL_FEEDS.length + 2);
    expect(map.get('https://www.dhs.gov/news-releases/press-releases')).toBe('dhs');
    expect(
      map.get(
        'https://api.commerce.gov/api/news?api_key=DEMO_KEY&sort=-created&page%5Blimit%5D=30',
      ),
    ).toBe('commerce');
    expect(map.get('https://thehill.com/feed/')).toBe('the_hill');
    expect(map.get('https://rss.politico.com/congress.xml')).toBe('politico_congress');
    expect(map.get('https://rss.politico.com/politics-news.xml')).toBe('politico');
    expect(
      map.get('https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?max=20&ContentType=1'),
    ).toBe('dod');
    expect(map.get('https://www.cbsnews.com/miami/latest/rss/main')).toBe('cbs_miami');
  });

  it('includes the env-gated Florida feeds so their rows can be relabelled too', () => {
    expect(ALL_FEEDS).toEqual([...FLORIDA_FEEDS, ...CORE_FEEDS]);
    expect(FLORIDA_FEEDS.map((feed) => feed.source)).toEqual([
      'florida_phoenix',
      'wusf',
      'florida_daily',
      'cbs_miami',
    ]);
  });

  it('refuses a feed list where one url would relabel to two slugs', () => {
    expect(() =>
      feedSlugMap([
        { source: 'a', url: 'https://x.test/feed' },
        { source: 'b', url: 'https://x.test/feed' },
      ]),
    ).toThrow(/maps to both/);
  });

  it('refuses a primary URL that belongs to another publisher fallback', () => {
    expect(() =>
      feedSlugMap([
        { source: 'dhs', url: 'https://www.dhs.gov/rss.xml' },
        { source: 'other', url: 'https://www.dhs.gov/news-releases/press-releases' },
      ]),
    ).toThrow(/maps to both/);
  });

  it('only relabels orphan hostname rows when the hostname is unambiguous', () => {
    expect(slugForOrphanSource('thehill.com')).toBe('the_hill');
    expect(slugForOrphanSource('www.war.gov')).toBe('dod');
    // politico.com articles come from two feeds — never guess.
    expect(slugForOrphanSource('www.politico.com')).toBeNull();
    expect(slugForOrphanSource('unknown.example')).toBeNull();
  });

  it('treats a dotted source as a mislabelled hostname and a slug as canonical', () => {
    expect(looksLikeHostname('www.justice.gov')).toBe(true);
    expect(looksLikeHostname('the_hill')).toBe(false);
  });
});
