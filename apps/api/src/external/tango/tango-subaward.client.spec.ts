import { TangoNotConfiguredError } from './tango.errors.js';
import { TangoSubawardClient } from './tango-subaward.client.js';

function fetchMock() {
  return jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
}

describe('TangoSubawardClient', () => {
  it('does no network work when unconfigured', async () => {
    const fetchImpl = fetchMock();
    const client = new TangoSubawardClient({ fetchImpl });
    await expect(client.listSubawards()).rejects.toBeInstanceOf(TangoNotConfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses documented API-key auth, filters, shape, ordering, and page pagination', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(
      new Response(
        JSON.stringify({
          count: 2,
          next: 'https://tango.makegov.com/api/subawards/?page=2',
          results: [{ key: 'a' }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '99',
          },
        },
      ),
    );
    const client = new TangoSubawardClient({ apiKey: 'secret-key', fetchImpl });
    const page = await client.listSubawards({
      page: 1,
      fiscalYear: 2026,
      primeUei: 'AAA111BBB222',
      subawardeeUei: 'CCC333DDD444',
    });

    expect(page.nextPage).toBe(2);
    expect(page.items).toHaveLength(1);
    const [request, init] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(request));
    expect((init?.headers as Record<string, string>)['X-API-KEY']).toBe('secret-key');
    expect(url.searchParams.get('fiscal_year')).toBe('2026');
    expect(url.searchParams.get('prime_uei')).toBe('AAA111BBB222');
    expect(url.searchParams.get('sub_uei')).toBe('CCC333DDD444');
    expect(url.searchParams.get('ordering')).toBe('-last_modified_date');
    expect(url.searchParams.get('shape')).toContain('subaward_details(*)');
    expect(url.searchParams.get('shape')).toContain('subaward_recipient(uei,display_name)');
    expect(url.searchParams.has('modified_after')).toBe(false);
  });

  it('redacts the key from provider errors', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(
      new Response('rejected secret-key', { status: 401 }),
    );
    const client = new TangoSubawardClient({ apiKey: 'secret-key', fetchImpl });
    await expect(client.listSubawards()).rejects.not.toThrow('secret-key');
  });
});
