import { MeriToolsService } from './meri-tools.service.js';
import { withGuardedWebResponse } from './hardenedWebTransport.js';

jest.mock('./hardenedWebTransport.js', () => ({
  ...jest.requireActual('./hardenedWebTransport.js'),
  withGuardedWebResponse: jest.fn(async (url: string) => ({ sourceUrl: url })),
}));

type Scrape = (input: Record<string, unknown>) => Promise<unknown>;
const scrape = () => (Object.create(MeriToolsService.prototype) as { scrapeWebPage: Scrape }).scrapeWebPage.bind(Object.create(MeriToolsService.prototype));
const url2000 = 'https://example.gov/?query=' + 'a'.repeat(2000 - 'https://example.gov/?query='.length);

describe('scrape exact bounded URL input', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([url2000+'other-target', ' '.repeat(2000)+'https://example.gov/', ' '.repeat(2001)])('rejects a raw overlong URL before any transport', async url => {
    await expect(scrape()({ url })).rejects.toThrow(/2000/);
    expect(withGuardedWebResponse).not.toHaveBeenCalled();
  });

  test.each([url2000, 'https://example.gov/report?full=exact', '  https://example.gov/  '])('preserves the full bounded target', async url => {
    await expect(scrape()({ url })).resolves.toEqual({ sourceUrl: url.trim() });
    expect(withGuardedWebResponse).toHaveBeenCalledTimes(1);
  });

  test.each([null, 123, {}, '', '   '])('rejects an absent or invalid URL without transport', async url => {
    await expect(scrape()({ url })).rejects.toThrow();
    expect(withGuardedWebResponse).not.toHaveBeenCalled();
  });
});
