import { describe, expect, test } from '@jest/globals';
import { LegiStormClient } from './legistorm-client.js';

const API_KEY = 'test-key-never-log';
const RANGE = { updatedFrom: '2026-07-01', updatedTo: '2026-07-13' };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
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

const TRIP_MEMBER_TRAVELER = {
  id: 62958,
  approver: {
    member_id: 3712,
    profile: { first_name: 'Kevin Patrick', last_name: 'Kiley', preferred_first_name: 'Kevin', preferred_last_name: 'Kiley' },
    state_id: 'CA',
    district_no: '3',
    office_type_id: 'HM',
    party: 'Independent',
  },
  traveler_member: {
    member_id: 3712,
    profile: { first_name: 'Kevin Patrick', last_name: 'Kiley', preferred_first_name: 'Kevin', preferred_last_name: 'Kiley' },
    state_id: 'CA',
    district_no: '3',
    office_type_id: 'HM',
    party: 'Independent',
  },
  traveler_staffer: null,
  start_date: '2026-05-01',
  end_date: '2026-05-03',
  duration: 3,
  purpose: 'Conference on trade policy',
  total_cost: 2500.5,
  destinations: [{ id: 1, name: 'Geneva, Switzerland', state_id: null }],
  sponsors: [{ id: 10, name: 'Trade Policy Institute' }],
  filed_date: '2026-05-10',
  updated_at: '2026-05-11T00:00:00Z',
};

const TRIP_STAFFER_TRAVELER = {
  id: 62959,
  approver: { member_id: 3712, profile: { first_name: 'Kevin', last_name: 'Kiley' }, state_id: 'CA' },
  traveler_member: null,
  traveler_staffer: {
    staffer: { id: 12500, first_name: 'Robert L.', last_name: 'Holste', preferred_first_name: 'Bob', preferred_last_name: 'Holste' },
    positions: [{ id: 176943, is_current: true, position_title: 'Chief of Staff' }],
  },
  start_date: '2026-06-01',
  end_date: '2026-06-02',
  duration: 1,
  purpose: null,
  total_cost: null,
  destinations: [],
  sponsors: [],
};

describe('LegiStormClient.fetchTrips (WS-F)', () => {
  test('routes through fetchPaged with the standard updated_from/updated_to/limit/page params', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse([TRIP_MEMBER_TRAVELER])]);
    const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl });

    const result = await client.fetchTrips(RANGE);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.id).toBe(62958);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/trips/list');
    expect(url.searchParams.get('updated_from')).toBe('2026-07-01');
    expect(url.searchParams.get('updated_to')).toBe('2026-07-13');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('page')).toBe('1');
    // Unlike fetchMembers, trips has no status filter.
    expect(url.searchParams.get('status')).toBeNull();
  });

  test('accepts a trip whose traveler is a staffer, not a member', async () => {
    const { fetchImpl } = queuedFetch([jsonResponse([TRIP_STAFFER_TRAVELER])]);
    const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl });

    const result = await client.fetchTrips(RANGE);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.traveler_staffer?.staffer?.id).toBe(12500);
  });

  test('filters out a trip record with neither traveler_member nor traveler_staffer', async () => {
    const junk = { id: 99999, approver: { member_id: 1 } }; // no traveler at all
    const { fetchImpl } = queuedFetch([jsonResponse([TRIP_MEMBER_TRAVELER, junk])]);
    const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl });

    const result = await client.fetchTrips(RANGE);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.id).toBe(62958);
    // fetchTrips returns LegiStormPagedResult (rawPages, not rawBody — that
    // shape belongs to the districts endpoints' own result type, WS-B). The
    // raw page still preserves the filtered-out element verbatim.
    expect(result.rawPages).toHaveLength(1);
    expect(result.rawPages[0]!.body).toHaveLength(2);
  });

  test('requires valid updated_from/updated_to (same date validation as every other list endpoint)', async () => {
    const { fetchImpl, calls } = queuedFetch([]);
    const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl });

    await expect(
      client.fetchTrips({ updatedFrom: '2026-07-14', updatedTo: '2026-07-13' }),
    ).rejects.toThrow('updatedFrom must not be after updatedTo');
    expect(calls).toHaveLength(0);
  });

  test('sends only the X-API-KEY header, matching the other list endpoints', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse([TRIP_MEMBER_TRAVELER])]);
    const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl });

    await client.fetchTrips(RANGE);

    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['X-API-KEY']).toBe(API_KEY);
  });
});
