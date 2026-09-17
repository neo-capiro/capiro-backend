import { describe, expect, it, vi } from 'vitest';
import {
  fetchLatestFloridaHearing,
  type LatestFloridaSelection,
} from './use-latest-florida-hearing.js';

/**
 * Focused tests for the "View latest Florida hearings" bounded lookup. The
 * hook is a thin react-query wrapper; the behavior under test is the fetch:
 * selection fidelity (no folder → GET, non-empty folder → POST), the
 * empty-folder short-circuit, and the bounded latest-first query (pageSize 1,
 * sort=desc). No real network — `api` is a stub.
 */
function makeApi(canned: unknown) {
  return {
    get: vi.fn(async (_url: string) => ({ data: canned })),
    post: vi.fn(async (_url: string, _body: unknown) => ({ data: canned })),
  };
}

const FL_HEARING_PAGE = {
  items: [
    {
      id: 'cm-fl-jlbc-2026-09-11',
      geographicJurisdiction: 'FL',
      title: 'Joint Legislative Budget Commission',
      chamber: 'Joint',
      eventStatus: 'completed',
      date: '2026-09-11',
      committee: { name: 'Joint Legislative Budget Commission', systemCode: 'jlbc' },
    },
  ],
  total: 1,
};

describe('fetchLatestFloridaHearing', () => {
  it('returns an honest empty answer for an explicitly EMPTY folder selection WITHOUT a request', async () => {
    const api = makeApi(FL_HEARING_PAGE);
    // An empty billIds is a real selection (folders that match nothing), NOT
    // "no filter". It must not fall through to the global GET and return an
    // unrelated hearing the calendar itself cannot render.
    const r = await fetchLatestFloridaHearing(api, { billIds: [] });
    expect(r.answered).toBe(true);
    expect(r.hearing).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('uses GET with the active selection (minus date bounds), bounded latest-first', async () => {
    const api = makeApi(FL_HEARING_PAGE);
    const selection: LatestFloridaSelection = {
      committee: 'Budget',
      q: 'joint',
    };
    const r = await fetchLatestFloridaHearing(api, selection);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
    const url = (api.get as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string;
    const qs = url.split('?')[1] ?? '';
    const params = new URLSearchParams(qs);
    expect(params.get('jurisdiction')).toBe('FL');
    expect(params.get('sort')).toBe('desc');
    expect(params.get('pageSize')).toBe('1');
    expect(params.get('committee')).toBe('Budget');
    expect(params.get('q')).toBe('joint');
    // Date bounds and pagination beyond the single bounded row are never sent.
    expect(params.get('from')).toBeNull();
    expect(params.get('to')).toBeNull();
    expect(r.hearing?.id).toBe('cm-fl-jlbc-2026-09-11');
    expect(r.answered).toBe(true);
  });

  it('uses POST with a non-empty folder selection, preserving the same filters + bounded sort', async () => {
    const api = makeApi(FL_HEARING_PAGE);
    const selection: LatestFloridaSelection = {
      committee: 'Budget',
      chamber: 'joint',
      billIds: ['fl-hb-1', 'fl-sb-2'],
    };
    await fetchLatestFloridaHearing(api, selection);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.get).not.toHaveBeenCalled();
    const [url, body] = (api.post as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(url).toBe('/api/legiwatch/live-hearings/calendar/query');
    expect(body).toMatchObject({
      jurisdiction: 'FL',
      sort: 'desc',
      pageSize: 1,
      committee: 'Budget',
      chamber: 'joint',
      billIds: ['fl-hb-1', 'fl-sb-2'],
    });
  });

  it('returns null (answered) when the server has no matching FL rows', async () => {
    const api = makeApi({ items: [], total: 0 });
    const r = await fetchLatestFloridaHearing(api, {});
    expect(r.answered).toBe(true);
    expect(r.hearing).toBeNull();
  });
});
