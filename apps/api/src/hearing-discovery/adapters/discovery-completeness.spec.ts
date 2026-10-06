import { CongressGovAdapter } from './congress-gov.adapter.js';
import { HouseRepositoryAdapter } from './house-repository.adapter.js';
import { fetchJson, fetchText, sleep } from './source-http.js';
import type { SourceDescriptor } from '../hearing-discovery.types.js';

jest.mock('./source-http.js', () => ({
  ...jest.requireActual('./source-http.js'),
  fetchJson: jest.fn(),
  fetchText: jest.fn(),
  sleep: jest.fn(async () => {}),
}));
const json = jest.mocked(fetchJson),
  text = jest.mocked(fetchText);
const source = {} as SourceDescriptor;
const ctx = { since: null, daysAhead: 1, delayMs: 0, log: jest.fn() };
const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null, durationMs: 1 });
const failure = (status: number, error: string) => ({
  ok: false,
  status,
  data: null,
  error,
  durationMs: 20_000,
});
const item = (id: string) => ({
  eventId: id,
  url: `https://api.congress.gov/v3/committee-meeting/119/house/${id}`,
});
const meeting = (id: string) => ({
  committeeMeeting: {
    eventId: id,
    congress: 119,
    chamber: 'house',
    title: 'Published hearing',
    date: '2026-10-07T14:00:00Z',
    committees: [{ systemCode: 'hswm00', name: 'Ways and Means' }],
  },
});
beforeEach(() => jest.clearAllMocks());

describe('Congress discovery completeness', () => {
  const adapter = (maxPages = 8, listLimit = 250) =>
    new CongressGovAdapter({ apiKey: 'test-only', congresses: [119], maxPages, listLimit });
  it('recovers one transient timeout with a bounded retry', async () => {
    json
      .mockResolvedValueOnce(failure(0, 'timeout after 20000ms'))
      .mockResolvedValueOnce(ok({ committeeMeetings: [item('1')] }))
      .mockResolvedValueOnce(ok(meeting('1')));
    const instance = adapter();
    expect(await instance.discoverEvents(source, ctx)).toHaveLength(1);
    expect(instance.discoveryErrors).toEqual([]);
    expect(json).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
  it('spends at most one timeout retry across all pages and details', async () => {
    json
      .mockResolvedValueOnce(failure(0, 'timeout after 20000ms'))
      .mockResolvedValueOnce(ok({ committeeMeetings: [item('1'), item('2')] }))
      .mockResolvedValueOnce(failure(0, 'timeout after 20000ms'))
      .mockResolvedValueOnce(ok(meeting('2')));
    const instance = adapter();
    expect((await instance.discoverEvents(source, ctx)).map((e) => e.externalEventId)).toEqual([
      '2',
    ]);
    expect(instance.discoveryErrors).toEqual([
      'detail fetch failed for event 1: timeout after 20000ms',
    ]);
    expect(json).toHaveBeenCalledTimes(4);
    expect(jest.mocked(sleep).mock.calls.filter(([ms]) => ms === 1000)).toHaveLength(1);
  });
  it.each([
    [403, 'HTTP 403'],
    [429, 'HTTP 429; Retry-After: 3600'],
    [0, 'fetch failed'],
  ])('does not retry refusal/rate limit/unknown transport error %s', async (status, error) => {
    json.mockResolvedValueOnce(failure(status as number, error as string));
    const instance = adapter();
    expect(await instance.discoverEvents(source, ctx)).toEqual([]);
    expect(instance.discoveryErrors).toEqual([`committee-meeting list failed: ${error}`]);
    expect(json).toHaveBeenCalledTimes(1);
  });
  it('preserves earlier events when a later list page fails', async () => {
    json
      .mockResolvedValueOnce(ok({ committeeMeetings: [item('1')], pagination: { next: 'next' } }))
      .mockResolvedValueOnce(ok(meeting('1')))
      .mockResolvedValueOnce(failure(503, 'HTTP 503'));
    const instance = adapter(2, 1);
    expect(await instance.discoverEvents(source, ctx)).toHaveLength(1);
    expect(instance.discoveryErrors).toEqual(['committee-meeting list failed: HTTP 503']);
  });
  it('does not mistake a bounded/truncated result for a complete pass', async () => {
    json
      .mockResolvedValueOnce(
        ok({ committeeMeetings: [item('1')], pagination: { next: 'next', count: 2 } }),
      )
      .mockResolvedValueOnce(ok(meeting('1')));
    const instance = adapter(1, 1);
    expect(await instance.discoverEvents(source, ctx)).toHaveLength(1);
    expect(instance.discoveryErrors).toEqual([
      'committee-meeting page limit reached (1); discovery incomplete',
    ]);
  });
  it('accepts an exact-size final page with authoritative total count and resets previous failures', async () => {
    json.mockResolvedValueOnce(failure(403, 'HTTP 403'));
    const instance = adapter(1, 1);
    await instance.discoverEvents(source, ctx);
    json
      .mockResolvedValueOnce(ok({ committeeMeetings: [item('1')], pagination: { count: 1 } }))
      .mockResolvedValueOnce(ok(meeting('1')));
    expect(await instance.discoverEvents(source, ctx)).toHaveLength(1);
    expect(instance.discoveryErrors).toEqual([]);
  });
  it('reports a malformed list response instead of a complete empty inventory', async () => {
    json.mockResolvedValueOnce(ok({ unexpected: [] }));
    const instance = adapter();
    expect(await instance.discoverEvents(source, ctx)).toEqual([]);
    expect(instance.discoveryErrors).toEqual([
      'committee-meeting list response missing committeeMeetings array',
    ]);
  });
});

describe('House discovery completeness', () => {
  it('returns a valid meeting while exposing another day failure', async () => {
    text
      .mockResolvedValueOnce({
        ok: true,
        body: '<a href="ByEvent.aspx?EventID=119999" title="Published hearing">Published hearing</a><span class="text-tiny" title="Committee on Ways and Means">Ways and Means</span></td><td>10:00 AM</td><td>Room 1100</td>',
      } as never)
      .mockResolvedValueOnce({ ok: false, body: null, error: 'HTTP 503' } as never);
    const instance = new HouseRepositoryAdapter({ congress: 119 });
    expect((await instance.discoverEvents(source, ctx)).map((e) => e.externalEventId)).toEqual([
      '119999',
    ]);
    expect(instance.discoveryErrors).toHaveLength(1);
    expect(instance.discoveryErrors[0]).toContain('HTTP 503');
    expect(text).toHaveBeenCalledTimes(2);
  });
});
