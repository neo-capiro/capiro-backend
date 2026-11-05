import { ClientProfileFillService } from './client-profile-fill.service.js';
import { governedRun } from './profile-extraction-context.js';

const clientId = '10000000-0000-4000-8000-000000000003';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000002',
};

test('public website research keeps full source coverage without duplicating the corpus into the SDK prompt', async () => {
  const service = Object.create(ClientProfileFillService.prototype) as any;
  const extract = jest.fn(async (_request: unknown) => ({
    data: {
      officialWebsite: { value: null, evidenceUrl: null },
      description: { value: null, evidenceUrl: null },
      people: [],
      facilities: [],
      capabilities: [],
      news: [],
    },
  }));
  Object.assign(service, { portfolioAgent: { extract }, logger: { warn: jest.fn() } });
  const text = 'SOURCE_ONLY_SENTINEL ' + 'supported public company evidence '.repeat(1500);
  const pages = Array.from({ length: 40 }, (_, i) => ({
    url: `https://example.test/company/${i}`,
    text,
    description: null,
  }));
  const controller = new AbortController();
  await governedRun.run(
    { canonicalClient: { id: clientId }, modelContextBlock: 'PRIVATE_CONTEXT_SENTINEL' } as any,
    () =>
      service.extractPublicWeb(
        ctx,
        { id: clientId, name: 'Synthetic Company', website: 'https://example.test' },
        pages[0],
        [],
        pages,
        { kind: 'client', id: clientId },
        controller.signal,
      ),
  );
  expect(extract).toHaveBeenCalledTimes(1);
  const request = extract.mock.calls[0]![0] as any;
  expect(request.prompt).toContain('PRIVATE_CONTEXT_SENTINEL');
  expect(request.prompt).toContain('Synthetic Company');
  expect(request.prompt).not.toContain('SOURCE_ONLY_SENTINEL');
  expect(request.sources).toEqual(
    pages.map((page, i) => ({ id: `page-${i}`, url: page.url, text: page.text })),
  );
  expect(request.signal).toBe(controller.signal);
  expect(request.timeoutMs).toBe(180_000);
});
