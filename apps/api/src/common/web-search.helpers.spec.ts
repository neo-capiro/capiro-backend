import { buildWebSearchRequest, normalizeWebResults } from './web-search.helpers.js';

describe('web-search.helpers', () => {
  describe('buildWebSearchRequest', () => {
    it('builds a Tavily POST with bearer auth and max_results', () => {
      const req = buildWebSearchRequest('tavily', 'defense appropriations', 5, 'tvly-key');
      expect(req.url).toBe('https://api.tavily.com/search');
      expect(req.init.method).toBe('POST');
      expect(req.init.headers['Content-Type']).toBe('application/json');
      expect(req.init.headers.Authorization).toBe('Bearer tvly-key');
      expect(JSON.parse(req.init.body)).toEqual({
        query: 'defense appropriations',
        max_results: 5,
      });
    });

    it('builds a Serper POST with X-API-KEY and num', () => {
      const req = buildWebSearchRequest('serper', 'NDAA markup', 8, 'serper-key');
      expect(req.url).toBe('https://google.serper.dev/search');
      expect(req.init.method).toBe('POST');
      expect(req.init.headers['X-API-KEY']).toBe('serper-key');
      expect(JSON.parse(req.init.body)).toEqual({ q: 'NDAA markup', num: 8 });
    });

    it('never leaks the API key into the body', () => {
      const req = buildWebSearchRequest('tavily', 'q', 3, 'secret');
      expect(req.init.body).not.toContain('secret');
    });
  });

  describe('normalizeWebResults', () => {
    const tavilyJson = {
      query: 'x',
      results: [
        {
          title: 'House passes NDAA',
          url: 'https://example.com/ndaa',
          content: 'The House passed the FY27 NDAA on a bipartisan vote.',
          published_date: '2026-06-01',
          score: 0.97,
        },
        {
          title: 'Approps update',
          url: 'https://example.org/approps',
          content: 'Subcommittee marks scheduled.',
        },
        {
          title: 'Senate hearing recap',
          url: 'https://example.net/hearing',
          content: 'SASC held a posture hearing.',
          published_date: '2026-05-28',
        },
      ],
    };

    const serperJson = {
      organic: [
        {
          title: 'GAO report on shipbuilding',
          link: 'https://gao.gov/report',
          snippet: 'GAO found schedule delays across programs.',
          date: 'Jun 2, 2026',
          position: 1,
        },
        {
          title: 'CRS explains PE lines',
          link: 'https://crsreports.congress.gov/pe',
          snippet: 'Program elements explained.',
        },
      ],
    };

    it('normalizes Tavily results', () => {
      const rows = normalizeWebResults('tavily', tavilyJson);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual({
        title: 'House passes NDAA',
        url: 'https://example.com/ndaa',
        snippet: 'The House passed the FY27 NDAA on a bipartisan vote.',
        source: 'tavily',
        publishedAt: '2026-06-01',
      });
      expect(rows[1]!.publishedAt).toBeNull();
    });

    it('normalizes Serper results (link -> url, date -> publishedAt)', () => {
      const rows = normalizeWebResults('serper', serperJson);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        title: 'GAO report on shipbuilding',
        url: 'https://gao.gov/report',
        snippet: 'GAO found schedule delays across programs.',
        source: 'serper',
        publishedAt: 'Jun 2, 2026',
      });
    });

    it('skips rows missing a title or a valid http(s) url', () => {
      const rows = normalizeWebResults('tavily', {
        results: [
          { title: '', url: 'https://example.com/a', content: 'no title' },
          { title: 'No url', content: 'missing' },
          { title: 'Bad scheme', url: 'ftp://example.com/x', content: 'ftp' },
          { title: 'Good', url: 'https://example.com/good', content: 'ok' },
        ],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.url).toBe('https://example.com/good');
    });

    it('returns [] for malformed payloads', () => {
      expect(normalizeWebResults('tavily', null)).toEqual([]);
      expect(normalizeWebResults('tavily', 'nope')).toEqual([]);
      expect(normalizeWebResults('tavily', {})).toEqual([]);
      expect(normalizeWebResults('serper', { organic: 'not-an-array' })).toEqual([]);
    });

    it('truncates oversized titles and snippets', () => {
      const rows = normalizeWebResults('serper', {
        organic: [
          {
            title: 'T'.repeat(500),
            link: 'https://example.com/long',
            snippet: 'S'.repeat(1000),
          },
        ],
      });
      expect(rows[0]!.title.length).toBeLessThanOrEqual(180);
      expect(rows[0]!.snippet!.length).toBeLessThanOrEqual(320);
    });
  });
});
