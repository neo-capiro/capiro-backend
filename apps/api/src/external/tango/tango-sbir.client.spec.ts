import { TangoNotConfiguredError } from './tango.errors.js';
import {
  TangoSbirClient,
  TangoSbirEnvelopeError,
  TangoSbirHttpError,
} from './tango-sbir.client.js';

/**
 * P42 part 1 — the SBIR/STTR REST client.
 *
 * The subject is a client for an endpoint NOTHING HAS EVER CALLED. P17's
 * 2026-08-08 run confirmed the `results` envelope for `/api/dibbs/` only, and
 * every field here is transcribed from published documentation rather than
 * observed. So these tests are deliberately weighted toward the two things that
 * stay true regardless of what the live response turns out to look like: the
 * request this client ISSUES, and its refusal to treat an unexpected shape as
 * an empty page.
 *
 * What they cannot establish is field types, null semantics or date formats.
 * That needs a captured fixture, and capturing one needs an operator run — see
 * plan §4.6, which forbids a key passing through an agent session.
 */

function fetchMock() {
  return jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
}

function page(body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * A mock that builds a FRESH Response per call.
 *
 * `mockResolvedValue(page(...))` hands back the same instance every time, and a
 * Response body can only be read once — so any test that calls the client twice
 * fails with "Body is unusable" and looks like a client defect rather than a
 * test defect. Every multi-call test below uses this.
 */
function pagesOf(body: unknown, headers: Record<string, string> = {}) {
  return fetchMock().mockImplementation(async () => page(body, headers));
}

function urlOf(fetchImpl: jest.MockedFunction<typeof fetch>, call = 0): URL {
  const [request] = fetchImpl.mock.calls[call]!;
  return new URL(String(request));
}

describe('TangoSbirClient — the request it issues', () => {
  it('does no network work when unconfigured', async () => {
    const fetchImpl = fetchMock();
    const client = new TangoSbirClient({ fetchImpl });
    await expect(client.listTopics()).rejects.toBeInstanceOf(TangoNotConfiguredError);
    await expect(client.listSolicitations()).rejects.toBeInstanceOf(TangoNotConfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports itself unconfigured without a key, and configured with one', () => {
    expect(new TangoSbirClient({}).configured).toBe(false);
    // Whitespace is not a key. A blank env var must not look like credentials.
    expect(new TangoSbirClient({ apiKey: '   ' }).configured).toBe(false);
    expect(new TangoSbirClient({ apiKey: 'k' }).configured).toBe(true);
  });

  it('calls the documented topics path with API-key auth and page pagination', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(
      page({
        count: 7,
        next: 'https://tango.makegov.com/api/sbir/topics/?page=2',
        results: [{ topic_id: 'T1' }],
      }),
    );
    const client = new TangoSbirClient({ apiKey: 'secret-key', fetchImpl });
    const result = await client.listTopics({ page: 1, limit: 50 });

    const url = urlOf(fetchImpl);
    expect(url.pathname).toBe('/api/sbir/topics/');
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['X-API-KEY']).toBe('secret-key');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(result.totalCount).toBe(7);
    expect(result.nextPage).toBe(2);
    expect(result.items).toEqual([{ topic_id: 'T1' }]);
  });

  it('calls the documented solicitations path', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(page({ count: 0, next: null, results: [] }));
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    await client.listSolicitations();
    expect(urlOf(fetchImpl).pathname).toBe('/api/sbir/solicitations/');
  });

  /**
   * The two endpoints document DIFFERENT date filters, and this client names
   * each one rather than offering a single `dateAfter` that guesses. Same
   * discipline as the DIBBS client's three separate spellings — sending an
   * undocumented parameter name is a 400 risk on every call that buys nothing.
   */
  it('sends the topics date filters under their own documented spellings', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(page({ results: [] }));
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    await client.listTopics({
      openDateAfter: '2026-01-01',
      closeDateAfter: '2026-02-01',
      releaseDateAfter: '2026-03-01',
      solicitationNumber: 'DoD-26-A',
    });

    const url = urlOf(fetchImpl);
    expect(url.searchParams.get('open_date_after')).toBe('2026-01-01');
    expect(url.searchParams.get('close_date_after')).toBe('2026-02-01');
    expect(url.searchParams.get('release_date_after')).toBe('2026-03-01');
    expect(url.searchParams.get('solicitation_number')).toBe('DoD-26-A');
    // Solicitation-only filters must never leak onto the topics call.
    expect(url.searchParams.has('start_date_after')).toBe(false);
    expect(url.searchParams.has('program')).toBe(false);
  });

  it('sends the solicitations filters under their own documented spellings', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(page({ results: [] }));
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    await client.listSolicitations({
      startDateAfter: '2026-01-01',
      endDateAfter: '2026-06-30',
      program: 'STTR',
    });

    const url = urlOf(fetchImpl);
    expect(url.searchParams.get('start_date_after')).toBe('2026-01-01');
    expect(url.searchParams.get('end_date_after')).toBe('2026-06-30');
    // `program` is the SBIR/STTR discriminator, passed through verbatim rather
    // than narrowed to a union this file guessed at.
    expect(url.searchParams.get('program')).toBe('STTR');
    expect(url.searchParams.has('open_date_after')).toBe(false);
  });

  it('sends no ordering parameter, because none is documented', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(page({ results: [] }));
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    await client.listTopics();
    expect(urlOf(fetchImpl).searchParams.has('ordering')).toBe(false);
  });

  it('clamps limit into range so the page asked for is the page reasoned about', async () => {
    const fetchImpl = pagesOf({ results: [] });
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });

    await client.listTopics({ limit: 5000 });
    expect(urlOf(fetchImpl, 0).searchParams.get('limit')).toBe('100');

    await client.listTopics({ limit: 0 });
    expect(urlOf(fetchImpl, 1).searchParams.get('limit')).toBe('1');
  });

  it('treats a non-positive or fractional page as page 1 rather than sending it', async () => {
    const fetchImpl = pagesOf({ results: [] });
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    await client.listTopics({ page: 0 });
    expect(urlOf(fetchImpl, 0).searchParams.get('page')).toBe('1');
    await client.listTopics({ page: 1.5 });
    expect(urlOf(fetchImpl, 1).searchParams.get('page')).toBe('1');
  });
});

/**
 * THE POINT OF THIS FILE.
 *
 * Nothing has ever called `/api/sbir/`. If the envelope is not what the
 * contract doc describes, this client must stop with an error a human reads —
 * never return `items: []`, which is indistinguishable from a clean
 * end-of-walk and would end every run with "0 records, complete".
 */
describe('TangoSbirClient — an unexpected envelope fails loudly', () => {
  it.each([
    ['no results key', { count: 0, next: null }],
    ['results is an object', { results: { topic_id: 'T1' } }],
    ['results is a string', { results: 'none' }],
    ['results is null', { results: null }],
    ['the body is a bare array', [{ topic_id: 'T1' }]],
  ])('throws rather than reporting an empty page: %s', async (_label, body) => {
    const fetchImpl = fetchMock().mockResolvedValue(page(body));
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    await expect(client.listTopics()).rejects.toBeInstanceOf(TangoSbirEnvelopeError);
  });

  it('throws on a 200 carrying invalid JSON', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(page('<html>maintenance</html>'));
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    await expect(client.listTopics()).rejects.toBeInstanceOf(TangoSbirEnvelopeError);
  });

  it('names the contract doc, so the fix is an update and a fixture rather than a widened client', async () => {
    const fetchImpl = pagesOf({ count: 0 });
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    await expect(client.listTopics()).rejects.toThrow(/dibbs-sbir-rest-contract\.md/);
    await expect(client.listTopics()).rejects.toThrow(/do not widen this client/i);
  });

  /**
   * The other half of the rule: a GENUINELY empty page is legal and must not
   * throw. A client that refused both would be unable to finish a normal walk.
   */
  it('accepts a real empty page', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(page({ count: 0, next: null, results: [] }));
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    const result = await client.listTopics();
    expect(result.items).toEqual([]);
    expect(result.nextPage).toBeNull();
  });

  it('drops non-object rows rather than passing them to a mapper', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(
      page({ results: [{ topic_id: 'T1' }, null, 'nope', 42, [{ nested: true }]] }),
    );
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    expect((await client.listTopics()).items).toEqual([{ topic_id: 'T1' }]);
  });

  it('ends the walk on a `next` it cannot parse, rather than guessing a page', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(
      page({ results: [], next: 'not a url at all' }),
    );
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    expect((await client.listTopics()).nextPage).toBeNull();
  });
});

describe('TangoSbirClient — errors, redaction and rate metadata', () => {
  it('never lets the key reach an error message, even when the provider echoes it', async () => {
    const fetchImpl = fetchMock().mockImplementation(
      async () => new Response('rejected key=secret-key for /api/sbir/topics/', { status: 401 }),
    ) as unknown as jest.MockedFunction<typeof fetch>;
    const client = new TangoSbirClient({ apiKey: 'secret-key', fetchImpl });
    await expect(client.listTopics()).rejects.not.toThrow('secret-key');
    await expect(client.listTopics()).rejects.toThrow('[REDACTED]');
  });

  it('carries Retry-After off a 429, because it is the only thing that says how long to wait', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '31', 'x-ratelimit-limit': '25', 'x-ratelimit-remaining': '0' },
      }),
    );
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    const error = await client.listTopics().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TangoSbirHttpError);
    const httpError = error as TangoSbirHttpError;
    // A throttle is its own condition, distinguishable from a broken capability
    // — the distinction D-65 had to add to the probe after a phantom regression.
    expect(httpError.isRateLimited).toBe(true);
    expect(httpError.rate?.retryAfter).toBe(31);
    expect(httpError.rate?.limit).toBe(25);
    expect(httpError.rate?.remaining).toBe(0);
  });

  it('reports rate metadata off a SUCCESSFUL response too, so a walk can pace itself', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(
      page({ results: [] }, { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset-in': '31' }),
    );
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    const result = await client.listTopics();
    expect(result.rate?.remaining).toBe(3);
    expect(result.rate?.resetIn).toBe(31);
  });

  it('reports no rate metadata as null rather than as zeros', async () => {
    // 0 remaining requests and "the provider said nothing" are different facts,
    // and a walk that paused on the second would stall forever.
    const fetchImpl = fetchMock().mockResolvedValue(page({ results: [] }));
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    expect((await client.listTopics()).rate).toBeNull();
  });

  it('surfaces a transport failure as a status-0 http error, not as a crash', async () => {
    const fetchImpl = fetchMock().mockRejectedValue(new Error('ECONNRESET'));
    const client = new TangoSbirClient({ apiKey: 'k', fetchImpl });
    const error = await client.listTopics().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TangoSbirHttpError);
    expect((error as TangoSbirHttpError).status).toBe(0);
  });

  it('names the timeout in its error so a slow provider is not read as a broken one', async () => {
    const fetchImpl = fetchMock().mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener('abort', () => {
          const abortError = new Error('aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    }) as unknown as jest.MockedFunction<typeof fetch>;

    const client = new TangoSbirClient({ apiKey: 'k', timeoutMs: 5, fetchImpl });
    await expect(client.listTopics()).rejects.toThrow(/timed out after 5ms/);
  });

  it('honours a custom base url without doubling slashes', async () => {
    const fetchImpl = fetchMock().mockResolvedValue(page({ results: [] }));
    const client = new TangoSbirClient({ apiKey: 'k', baseUrl: 'https://example.invalid/', fetchImpl });
    await client.listTopics();
    const url = urlOf(fetchImpl);
    expect(url.origin).toBe('https://example.invalid');
    expect(url.pathname).toBe('/api/sbir/topics/');
  });
});
