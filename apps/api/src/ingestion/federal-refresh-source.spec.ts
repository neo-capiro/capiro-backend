import {
  federalArchiveUrl,
  federalRefreshTransport,
  parseFederalAmendmentPage,
} from './federal-refresh-source';

const member = { congress: 119, type: 'SAMDT', number: '1', updateDate: '2026-01-01T00:00:00Z' };
describe('bounded federal refresh acquisition', () => {
  it('requires raw count and offset proof before accepting a complete amendment page', () => {
    expect(
      parseFederalAmendmentPage({ amendments: [member], pagination: { count: 1 } }, 0, null),
    ).toMatchObject({ count: 1, complete: true });
    expect(
      parseFederalAmendmentPage(
        {
          amendments: [member],
          pagination: { count: 2, next: 'https://api.congress.gov/v3/amendment/119?offset=1' },
        },
        0,
        2,
      ).complete,
    ).toBe(false);
    for (const value of [
      { amendments: [member], pagination: { count: 2 } },
      { amendments: [member, member], pagination: { count: 2 } },
      { amendments: [{ ...member, updateDate: 'bad' }], pagination: { count: 1 } },
      { amendments: [{ ...member, congress: 118 }], pagination: { count: 1 } },
      {
        amendments: [member],
        pagination: { count: 2, next: 'https://evil.example/v3/amendment/119?offset=1' },
      },
      {
        amendments: [member],
        pagination: { count: 2, next: 'https://api.congress.gov/v3/amendment/119?offset=250' },
      },
    ])
      expect(() => parseFederalAmendmentPage(value, 0, null)).toThrow();
    expect(() =>
      parseFederalAmendmentPage({ amendments: [member], pagination: { count: 1 } }, 0, 2),
    ).toThrow('COUNT_INVALID');
  });
  function setup(responses: Response[], remaining = 600000) {
    const beforeAttempt = jest.fn(async () => {}),
      sleep = jest.fn(async () => {});
    const transport = jest.fn(async (url: string, consume: any, options: any) => {
      options.validateDestination(new URL(url));
      await options.beforeRequest(new URL(url));
      const scope = {
        check: () => {},
        wait: (v: any) => v,
        signal: new AbortController().signal,
        registerCleanup: () => () => {},
      };
      return consume(responses.shift()!, url, scope);
    });
    return {
      beforeAttempt,
      sleep,
      transport,
      client: federalRefreshTransport({
        beforeAttempt,
        sleep,
        check: () => {},
        remainingMs: () => remaining,
        transport: transport as any,
      }),
    };
  }
  it('uses only fixed official URLs, bounded public transport and charges every retry', async () => {
    const h = setup([
      new Response('', { status: 503, headers: { 'retry-after': '2' } }),
      new Response('PKsynthetic', { headers: { 'content-type': 'application/zip' } }),
    ]);
    expect((await h.client.archive('hr')).toString()).toBe('PKsynthetic');
    expect(h.beforeAttempt).toHaveBeenCalledTimes(2);
    expect(h.sleep).toHaveBeenCalledWith(2000);
    expect(h.transport.mock.calls[0]![0]).toBe(federalArchiveUrl('hr'));
    expect(h.transport.mock.calls[0]![2]).toMatchObject({ maxRedirects: 2, deadlineMs: 60000 });
    await expect(h.client.json('https://evil.example/v3/amendment/119')).rejects.toThrow(
      'URL_UNQUALIFIED',
    );
    expect(h.beforeAttempt).toHaveBeenCalledTimes(2);
  });
  it('refuses HTML errors and oversized JSON and obeys Retry-After beyond the remaining deadline', async () => {
    await expect(
      setup([new Response('<html>', { headers: { 'content-type': 'text/html' } })]).client.archive(
        'hr',
      ),
    ).rejects.toThrow('MIME_MISMATCH');
    await expect(
      setup([
        new Response('{}', {
          headers: { 'content-type': 'application/json', 'content-length': '8000001' },
        }),
      ]).client.json('https://api.congress.gov/v3/amendment/119'),
    ).rejects.toThrow();
    const h = setup([new Response('', { status: 429, headers: { 'retry-after': '5' } })], 1000);
    await expect(h.client.archive('hr')).rejects.toThrow('DEADLINE');
    expect(h.beforeAttempt).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });
  it('passes the remaining invocation deadline to the actual DNS/redirect/body transport', async () => {
    const h = setup(
      [new Response('{}', { headers: { 'content-type': 'application/json' } })],
      1250,
    );
    await h.client.json('https://api.congress.gov/v3/amendment/119');
    expect(h.transport.mock.calls[0]![2].deadlineMs).toBe(1250);
  });
});
