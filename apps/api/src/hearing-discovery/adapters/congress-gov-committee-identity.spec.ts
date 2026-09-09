import { CongressGovAdapter } from './congress-gov.adapter.js';
import * as http from './source-http.js';
import type { SourceDescriptor } from '../hearing-discovery.types.js';

describe('Congress.gov discovery preserves published hosting bodies', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    { codes: ['ssas14'], child: 'ssas14' },
    { codes: ['ssas14', 'ssas00'], child: 'ssas14' },
    { codes: ['ssas00', 'ssap00'], child: null },
  ])('normalizes $codes through the real discovery adapter', async ({ codes, child }) => {
    jest.spyOn(http, 'fetchJson')
      .mockResolvedValueOnce({ ok: true, data: { committeeMeetings: [
        { eventId: 'identity-fixture', url: 'https://api.congress.gov/v3/committee-meeting/119/senate/identity-fixture' },
      ] } } as never)
      .mockResolvedValueOnce({ ok: true, data: { committeeMeeting: {
        eventId: 'identity-fixture', congress: 119, chamber: 'Senate',
        date: '2026-05-12T20:30:00Z', title: 'Fixture proceeding',
        committees: codes.map((systemCode) => ({ systemCode })),
      } } } as never);
    const adapter = new CongressGovAdapter({ apiKey: 'test-key', congresses: [119], maxPages: 1 });
    const events = await adapter.discoverEvents({} as SourceDescriptor, {
      since: null, daysAhead: 0, delayMs: 0, log: () => {},
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ committeeSystemCode: 'ssas00', subcommitteeSystemCode: child });
  });
});
