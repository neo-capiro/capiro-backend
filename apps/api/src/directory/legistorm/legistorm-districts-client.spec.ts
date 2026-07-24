import { describe, expect, test } from '@jest/globals';
import { LegiStormClient } from './legistorm-client.js';

const API_KEY = 'test-key-never-log';
const DISTRICTS_BASE_URL = 'https://api.legistorm.com/v2.023.07/legislative_districts';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function textResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/xml', ...headers } });
}

function queuedFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses[index++];
    if (!response) throw new Error('unexpected fetch call');
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const HOUSE_DC = {
  id: 271,
  office_type: 'House',
  state: 'DC',
  name: 'At-Large Congressional District of District of Columbia',
  district_no: 1,
  senate_class: null,
  members: [
    {
      id: 564,
      bioguide_id: 'N000147',
      preferred_first: 'Eleanor Holmes',
      preferred_last: 'Norton',
      party_name: 'Democrat',
      status: 'In Office',
      outgoing_status: 'Retiring',
    },
  ],
  kml: 'https://www.legistorm.com/office_district/getKMLByHash/hash/SECRET-KEY/state_id/DC/district_type/C/district_no/1.html',
};

const HOUSE_TX_FUTURE = {
  id: 603,
  office_type: 'House',
  name: '25th Congressional District of Texas',
  state: 'TX',
  district_no: 25,
  senate_class: null,
  status: 'F',
  effective_date: '2027-01-03',
  enacted_date: '2025-08-28',
  members: [{ id: 2894, bioguide_id: 'W000816', preferred_first: 'Roger', preferred_last: 'Williams' }],
  kml: 'https://www.legistorm.com/office_district/getKMLByHash/hash/SECRET-KEY/state_id/TX/district_type/F/district_no/25.html',
};

describe('LegiStormClient — Legislative Districts API (WS-B)', () => {
  test('fetchCongressDistrictList sends state + status as query params, no updated_from/updated_to', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse([HOUSE_TX_FUTURE])]);
    const client = new LegiStormClient({ apiKey: API_KEY, baseUrl: DISTRICTS_BASE_URL, fetchImpl });

    const result = await client.fetchCongressDistrictList('TX', 'F');

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ id: 603, state: 'TX', status: 'F' });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/congress/list');
    expect(url.searchParams.get('state')).toBe('TX');
    expect(url.searchParams.get('status')).toBe('F');
    expect(url.searchParams.get('updated_from')).toBeNull();
    expect(url.searchParams.get('updated_to')).toBeNull();
    expect(url.searchParams.get('page')).toBeNull();
    expect(url.searchParams.get('limit')).toBeNull();
  });

  test('fetchCongressDistrictList omits the status param when not provided', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse([HOUSE_DC])]);
    const client = new LegiStormClient({ apiKey: API_KEY, baseUrl: DISTRICTS_BASE_URL, fetchImpl });

    await client.fetchCongressDistrictList('DC');

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('status')).toBeNull();
  });

  test('sends only the X-API-KEY header, never a query-param key, for the JSON districts endpoint', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse([HOUSE_DC])]);
    const client = new LegiStormClient({ apiKey: API_KEY, baseUrl: DISTRICTS_BASE_URL, fetchImpl });

    await client.fetchCongressDistrictList('DC', 'C');

    const init = calls[0]!.init;
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-API-KEY']).toBe(API_KEY);
    expect(new URL(calls[0]!.url).search).not.toContain(API_KEY);
  });

  test('fetchCongressDistrictsByZip sends zip and optional zip4, can return multiple districts', async () => {
    const multi = [HOUSE_TX_FUTURE, { ...HOUSE_DC, id: 999, state: 'TX', name: 'U.S. Senate Seat for Texas (Class 1)' }];
    const { fetchImpl, calls } = queuedFetch([jsonResponse(multi)]);
    const client = new LegiStormClient({ apiKey: API_KEY, baseUrl: DISTRICTS_BASE_URL, fetchImpl });

    const result = await client.fetchCongressDistrictsByZip('75001', '1234');

    expect(result.records).toHaveLength(2);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/congress/zipcode');
    expect(url.searchParams.get('zip')).toBe('75001');
    expect(url.searchParams.get('zip4')).toBe('1234');
  });

  test('filters out a malformed element instead of throwing on the whole page', async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse([HOUSE_DC, { unexpected: 'trailing element, no office_type/state/name' }]),
    ]);
    const client = new LegiStormClient({ apiKey: API_KEY, baseUrl: DISTRICTS_BASE_URL, fetchImpl });

    const result = await client.fetchCongressDistrictList('DC');

    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.id).toBe(271);
    // The raw body is preserved verbatim even though one element was filtered.
    expect(result.rawBody).toHaveLength(2);
  });

  test('throws with the HTTP status when the API denies the request (e.g. an unentitled endpoint)', async () => {
    // Live-verified real vendor behavior 2026-07-24: /state/list and
    // /state/zipcode return exactly this shape (401 "Current method is
    // denied") on a key not entitled to state-level districts.
    const { fetchImpl } = queuedFetch([
      jsonResponse({ success: false, error: 'Current method is denied.', code: 'AUTH_ERROR' }, 401),
    ]);
    const client = new LegiStormClient({ apiKey: API_KEY, baseUrl: DISTRICTS_BASE_URL, fetchImpl });

    await expect(client.fetchCongressDistrictList('DC')).rejects.toThrow('HTTP 401');
  });

  test('throws if a 200 response body is not an array (defensive — no live-verified case, but the guard is real code)', async () => {
    const { fetchImpl } = queuedFetch([jsonResponse({ unexpected: 'a bare object, not an array' })]);
    const client = new LegiStormClient({ apiKey: API_KEY, baseUrl: DISTRICTS_BASE_URL, fetchImpl });

    await expect(client.fetchCongressDistrictList('DC')).rejects.toThrow('expected an array response');
  });

  test('fetchDistrictKml sends a browser User-Agent and NO X-API-KEY header (auth is the URL itself)', async () => {
    const kmlBody = '<?xml version="1.0"?><kml></kml>';
    const { fetchImpl, calls } = queuedFetch([textResponse(kmlBody)]);
    const client = new LegiStormClient({ apiKey: API_KEY, baseUrl: DISTRICTS_BASE_URL, fetchImpl });

    const text = await client.fetchDistrictKml(HOUSE_DC.kml);

    expect(text).toBe(kmlBody);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(HOUSE_DC.kml);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['X-API-KEY']).toBeUndefined();
    expect(headers['User-Agent']).toBeTruthy();
    expect(headers['User-Agent']).toMatch(/Mozilla/);
  });

  test('fetchDistrictKml refuses a non-HTTPS URL', async () => {
    const { fetchImpl } = queuedFetch([]);
    const client = new LegiStormClient({ apiKey: API_KEY, baseUrl: DISTRICTS_BASE_URL, fetchImpl });

    await expect(client.fetchDistrictKml('http://www.legistorm.com/insecure.kml')).rejects.toThrow(
      'HTTPS',
    );
  });

  test('fetchDistrictKml throws with the HTTP status on a non-2xx response, never the URL/key', async () => {
    const { fetchImpl } = queuedFetch([textResponse('Forbidden', 403)]);
    const client = new LegiStormClient({ apiKey: API_KEY, baseUrl: DISTRICTS_BASE_URL, fetchImpl });

    await expect(client.fetchDistrictKml(HOUSE_DC.kml)).rejects.toThrow('HTTP 403');
    try {
      await client.fetchDistrictKml(HOUSE_DC.kml);
    } catch (error) {
      expect((error as Error).message).not.toContain(API_KEY);
      expect((error as Error).message).not.toContain('SECRET-KEY');
    }
  });
});
