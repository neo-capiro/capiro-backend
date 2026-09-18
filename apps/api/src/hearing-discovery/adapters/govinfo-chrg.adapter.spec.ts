import { GovInfoChrgAdapter, govInfoChrgCollectionUrl } from './govinfo-chrg.adapter.js';
import { fetchJson } from './source-http.js';

jest.mock('./source-http.js', () => ({ fetchJson: jest.fn() }));

const mockedFetchJson = jest.mocked(fetchJson);
const source = {
  id: 'source-1',
  committeeSystemCode: null,
  chamber: 'house' as const,
  sourceType: 'COMMITTEE_API' as const,
  sourceUrl: 'https://api.govinfo.gov',
  adapterKey: 'govinfo-chrg',
  priority: 1,
  parserVersion: null,
};
const context = { since: null, daysAhead: 0, delayMs: 0, log: jest.fn() };

describe('GovInfoChrgAdapter health probe', () => {
  beforeEach(() => jest.clearAllMocks());

  it('constructs the keyed CHRG collection URL with a bounded window', () => {
    const url = new URL(govInfoChrgCollectionUrl('secret-key', 119, new Date('2026-09-18T12:00:00Z')));
    expect(url.pathname).toBe('/collections/CHRG/2026-09-11T12:00:00Z/2026-09-18T12:00:00Z');
    expect(url.searchParams.get('api_key')).toBe('secret-key');
    expect(url.searchParams.get('pageSize')).toBe('1');
    expect(url.searchParams.get('congress')).toBe('119');
    expect(url.searchParams.get('offsetMark')).toBe('*');
  });

  it('classifies missing keys as a failed probe without making a request', async () => {
    const result = await new GovInfoChrgAdapter('').healthCheck(source, context);
    expect(result).toMatchObject({ ok: false, status: null });
    expect(result.error).toContain('GOVINFO_API_KEY is required');
    expect(mockedFetchJson).not.toHaveBeenCalled();
  });

  it('classifies API access separately from corpus completeness', async () => {
    mockedFetchJson.mockResolvedValue({
      ok: true, status: 200, durationMs: 12, error: null, data: { packages: [] },
    });
    const result = await new GovInfoChrgAdapter('secret-key').healthCheck(source, context);
    expect(result).toMatchObject({ ok: true, status: 200, observedEvents: 0 });
  });

  it('classifies API failures and redacts the key from errors', async () => {
    mockedFetchJson.mockResolvedValue({
      ok: false, status: 403, durationMs: 4,
      error: 'HTTP 403 https://api.govinfo.gov/collections/CHRG/119?api_key=secret-key',
      data: null,
    });
    const result = await new GovInfoChrgAdapter('secret-key').healthCheck(source, context);
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(result.error).not.toContain('secret-key');
    expect(result.error).toContain('api_key=[redacted]');
  });
});
