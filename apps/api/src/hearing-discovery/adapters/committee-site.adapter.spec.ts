import { CommitteeSiteAdapter, isNewsArticle, isNewsIndex } from './committee-site.adapter.js';
import { fetchText } from './source-http.js';
import type { SourceDescriptor } from '../hearing-discovery.types.js';
jest.mock('./source-http.js', () => ({
  ...jest.requireActual('./source-http.js'),
  fetchText: jest.fn(),
}));
const fetchMock = jest.mocked(fetchText);
const source = {
  id: 'source',
  committeeSystemCode: 'ssas00',
  sourceUrl: 'https://www.armed-services.senate.gov/',
  adapterKey: 'committee-site',
  sourceType: 'COMMITTEE_SITE',
  chamber: 'senate',
  priority: 50,
} as SourceDescriptor;
const ctx = { since: null, daysAhead: 0, delayMs: 0, log: jest.fn() };
function html(body: string) {
  return {
    ok: true,
    status: 200,
    body,
    notModified: false,
    etag: null,
    lastModified: null,
    contentHash: 'hash',
    durationMs: 1,
    error: null,
  };
}
beforeEach(() => fetchMock.mockReset());

describe('official committee news', () => {
  it('reads an explicitly registered news index without following sibling navigation', async () => {
    fetchMock.mockResolvedValueOnce(
      html(
        '<a href="/media/press-releases">Press releases</a>' +
          '<a href="/news">News</a>' +
          '<a href="/2026/10/chairman-announces-policy">Chairman announces policy</a>' +
          '<a href="/news/press-releases/committee-statement">Committee statement</a>' +
          '<a href="https://other.house.gov/2026/10/unrelated">Unrelated committee news</a>',
      ),
    );
    const adapter = new CommitteeSiteAdapter();
    const updates = await adapter.discoverUpdates(
      {
        ...source,
        committeeSystemCode: 'hsfa00',
        chamber: 'house',
        sourceUrl: 'https://foreignaffairs.house.gov/news',
      },
      ctx,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updates.map((update) => update.normalizedTitle)).toEqual([
      'Chairman announces policy',
      'Committee statement',
    ]);
    expect(
      updates.every(
        (update) =>
          update.committeeSystemCode === 'hsfa00' &&
          update.updateType === 'committee_news_published' &&
          update.officialPublishedAt === null,
      ),
    ).toBe(true);
    expect(adapter.updateErrors).toEqual([]);
  });
  it('discovers actual linked news indexes and deduplicates article links without inventing publication dates', async () => {
    fetchMock
      .mockResolvedValueOnce(
        html(
          '<a href="/press">Press</a><a href="/press-releases/committee-publishes-report">Committee publishes report</a>',
        ),
      )
      .mockResolvedValueOnce(
        html(
          '<a href="/press-releases/committee-publishes-report">Committee publishes report</a><a href="/press-releases/chairman-discusses-policy">Chairman discusses policy</a>',
        ),
      );
    const updates = await new CommitteeSiteAdapter().discoverUpdates(source, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.armed-services.senate.gov/press');
    expect(updates).toHaveLength(2);
    expect(
      updates.every(
        (u) =>
          u.updateType === 'committee_news_published' &&
          u.committeeSystemCode === 'ssas00' &&
          u.officialPublishedAt === null,
      ),
    ).toBe(true);
  });
  it('recognizes dated CMS articles when an official news index is observed', async () => {
    fetchMock
      .mockResolvedValueOnce(
        html(
          '<a href="/news">News</a><a href="/2026/10/chairman-announces-new-policy">Chairman announces new policy</a>',
        ),
      )
      .mockResolvedValueOnce(
        html(
          '<a href="/2026/10/05/chairman-announces-tax-update">Chairman announces tax update</a>',
        ),
      );
    const updates = await new CommitteeSiteAdapter().discoverUpdates(source, ctx);
    expect(updates.map((u) => u.normalizedTitle)).toEqual([
      'Chairman announces new policy',
      'Chairman announces tax update',
    ]);
  });
  it('rejects external/member articles, navigation and placeholders', async () => {
    fetchMock
      .mockResolvedValueOnce(
        html(
          '<a href="https://other.senate.gov/press-releases/policy-announced">External announcement</a><a href="/press-releases/all">View All</a><a href="/press-releases/important-policy">Read More</a><a href="/news/feed">RSS Feed</a>',
        ),
      )
      .mockResolvedValueOnce(html(''));
    expect(await new CommitteeSiteAdapter().discoverUpdates(source, ctx)).toEqual([]);
  });
  it('reports a linked news index access failure instead of declaring an empty successful feed', async () => {
    fetchMock
      .mockResolvedValueOnce(html('<a href="/press">Press</a>'))
      .mockResolvedValueOnce({ ...html(''), ok: false, status: 403, error: 'HTTP 403' });
    await expect(new CommitteeSiteAdapter().discoverUpdates(source, ctx)).rejects.toThrow(
      'committee news index fetch failed',
    );
  });
  it('bounds index traversal and never recursively follows news indexes', async () => {
    fetchMock
      .mockResolvedValueOnce(
        html(
          ['news', 'newsroom', 'press', 'press-releases', 'majority-news']
            .map((p) => `<a href="/${p}">${p}</a>`)
            .join(''),
        ),
      )
      .mockResolvedValue(html('<a href="/news/archive">Archives</a>'));
    await new CommitteeSiteAdapter().discoverUpdates(source, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  it('does not turn a news story mentioning a hearing into a scheduled hearing announcement', async () => {
    fetchMock.mockResolvedValueOnce(
      html(
        '<a href="/press-releases/chair-announces-hearing-2026-10-07">Chair announces hearing October 7, 2026</a>',
      ),
    );
    expect((await new CommitteeSiteAdapter().discoverUpdates(source, ctx))[0]?.updateType).toBe(
      'committee_news_published',
    );
  });
  it('preserves existing testimony and hearing notice extraction', async () => {
    fetchMock.mockResolvedValueOnce(
      html(
        '<a href="/files/testimony.pdf">Written testimony from witness</a><a href="/hearings/2026-10-07">Hearing October 7, 2026</a>',
      ),
    );
    expect(
      (await new CommitteeSiteAdapter().discoverUpdates(source, ctx)).map((u) => u.updateType),
    ).toEqual(['witness_testimony_published', 'hearing_announced']);
  });
  it.each(['/news', '/news/press-releases', '/press/majority', '/news/archive'])(
    'identifies only category pages: %s',
    (path) => {
      expect(isNewsIndex('https://x.house.gov' + path)).toBe(true);
      expect(isNewsArticle('https://x.house.gov' + path)).toBe(false);
    },
  );
  it('recognizes House document CMS articles', () => {
    expect(isNewsArticle('https://x.house.gov/news/documentsingle.aspx?DocumentID=123')).toBe(true);
    expect(isNewsArticle('https://x.house.gov/news/documentsingle.aspx')).toBe(false);
  });
  it('accepts current Senate query-ID CMS and rejects listing query pages', () => {
    expect(
      isNewsArticle(
        'https://www.epw.senate.gov/public/index.cfm/press-releases-republican?ID=D3555B5D-34C2-4D95-B99B-5B460BB9895D',
      ),
    ).toBe(true);
    expect(
      isNewsArticle('https://www.sbc.senate.gov/public/index.cfm/pressreleases?id=12345'),
    ).toBe(true);
    expect(
      isNewsArticle('https://agriculture.house.gov/news/documentquery.aspx?DocumentTypeID=1950'),
    ).toBe(false);
  });
  it('deduplicates CMS ID casing, www host aliases and tracking query parameters', async () => {
    fetchMock.mockResolvedValueOnce(
      html(
        '<a href="https://armed-services.senate.gov/press-releases?ID=ABC">Committee statement</a><a href="https://www.armed-services.senate.gov/press-releases?id=abc&utm_source=email">Committee statement repeated</a>',
      ),
    );
    expect(await new CommitteeSiteAdapter().discoverUpdates(source, ctx)).toHaveLength(1);
  });
  it('requires committee identity for a state source and rejects general chamber news', async () => {
    const stateSource = {
      ...source,
      committeeSystemCode: 'state:FL:commerce',
      sourceUrl: 'https://www.flsenate.gov/Committees/Show/CM/2026',
    };
    await expect(new CommitteeSiteAdapter().discoverUpdates(stateSource, ctx)).rejects.toThrow(
      'verified committee identity',
    );
    fetchMock.mockResolvedValueOnce(
      html(
        '<a href="/news/commerce-policy-update">Commerce policy update</a><a href="/news/commerce-committee-announcement">Commerce Committee announces a report</a><a href="/news/other-hearing-2026-10-07">Other Committee hearing October 7, 2026</a>',
      ),
    );
    const rows = await new CommitteeSiteAdapter({
      stateCommitteeName: () => 'Commerce',
    }).discoverUpdates(stateSource, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      committeeSystemCode: 'state:FL:commerce',
      normalizedTitle: 'Commerce Committee announces a report',
      updateType: 'committee_news_published',
    });
  });
  it('does not attribute House Administration news to its hosted joint committee', async () => {
    fetchMock.mockResolvedValueOnce(
      html(
        '<a href="/media/press-releases/house-administration-policy">House Administration Committee announces policy</a><a href="/media/press-releases/printing-policy">Joint Committee on Printing issues statement</a>',
      ),
    );
    const rows = await new CommitteeSiteAdapter({
      committeeName: () => 'Joint Committee on Printing',
    }).discoverUpdates(
      {
        ...source,
        committeeSystemCode: 'jspr00',
        sourceUrl: 'https://cha.house.gov/joint-committee-on-printing',
      },
      ctx,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.normalizedTitle).toBe('Joint Committee on Printing issues statement');
  });
  it('keeps observed articles while explicitly reporting a broken secondary news index', async () => {
    fetchMock
      .mockResolvedValueOnce(
        html(
          '<a href="/press">Press</a><a href="/press-releases/published-statement">Published statement</a>',
        ),
      )
      .mockResolvedValueOnce({ ...html(''), ok: false, status: 404, error: 'HTTP 404' });
    const adapter = new CommitteeSiteAdapter();
    expect(await adapter.discoverUpdates(source, ctx)).toHaveLength(1);
    expect(adapter.updateErrors[0]).toContain('HTTP 404');
  });
  it('does not attribute unrelated PDFs or hearing links from a shared state/chamber page', async () => {
    fetchMock.mockResolvedValueOnce(
      html(
        '<a href="/documents/statement.pdf">Written testimony for another committee</a><a href="/hearings/2026-10-07">Other Committee hearing October 7, 2026</a><a href="/documents/commerce-memo.pdf">Commerce Committee memorandum</a>',
      ),
    );
    const rows = await new CommitteeSiteAdapter({
      stateCommitteeName: () => 'Commerce',
    }).discoverUpdates(
      {
        ...source,
        committeeSystemCode: 'state:FL:commerce',
        sourceUrl: 'https://www.flsenate.gov/Committees/Show/CM/2026',
      },
      ctx,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      normalizedTitle: 'Commerce Committee memorandum',
      updateType: 'committee_memo_published',
    });
  });
});

describe('official hearing enrichment', () => {
  it('extracts clean published witness names and their extensionless testimony documents', async () => {
    const names = [
      'Honorable David J. Trachtenberg',
      'Dr. Thomas O. Karako',
      'Mr. David E. Mosher',
    ];
    fetchMock.mockResolvedValue(
      html(`<h2>Witnesses</h2><ul>${names
        .map(
          (name, i) =>
            `<li><h3>${name}</h3><p>Published affiliation</p><a href="/download/testimony/witness-${i}">Download Witness Testimony</a></li>`,
        )
        .join('')}</ul>
      <footer><ul><li>Contact Committee Staff</li></ul></footer>
      <a href="https://unrelated.example/download/testimony/unrelated">Unrelated testimony</a>
      <iframe src="https://www.senate.gov/isvp/?comm=armed&amp;filename=armedA092926"></iframe>`),
    );
    const result = await new CommitteeSiteAdapter().enrichEvent(
      source,
      {
        id: 'sen-119-338758',
        congress: 119,
        chamber: 'Senate',
        committeeSystemCode: 'ssas00',
        committeeName: 'Armed Services',
        title: 'Golden Dome',
        calendarDate: new Date('2026-09-29'),
        startsAt: null,
        timeZone: null,
        officialPageUrl: source.sourceUrl + 'hearings/golden-dome',
      },
      ctx,
    );
    expect(result?.witnesses).toEqual(names);
    expect(result?.documents).toEqual(
      names.map((name, i) => ({
        title: `Witness testimony: ${name}`,
        url: source.sourceUrl + `download/testimony/witness-${i}`,
        publishedAt: null,
      })),
    );
    expect(result?.streamCandidates?.[0]?.officialPageUrl).toBe(
      'https://www.senate.gov/isvp/?comm=armed&filename=armedA092926',
    );
  });
});
