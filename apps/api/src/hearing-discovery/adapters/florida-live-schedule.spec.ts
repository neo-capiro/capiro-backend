import type { PrismaClient } from '@prisma/client';
import type { LegislativeObservation } from '../legislative-calendar.js';
import { StreamCandidateRepository } from '../stream-candidate.repository.js';
import { floridaLiveCandidate, floridaLiveSchedule } from './florida-live-schedule.js';

// Shape read from TFC's public /api/tfc/v1/schedule on 2026-10-31. That
// Saturday had TV 24/7 only; live titles/keys below are synthetic contract cases.
const event = {
  uuid: 'recRulesExample',
  title: 'Senate Rules',
  start_time: '2026-04-28 14:00:00',
  start_time_utc: '2026-04-28T18:00:00Z',
  end_time: '2026-04-28 18:00:00',
  end_time_utc: '2026-04-28T22:00:00Z',
  url: 'https://cdnapisec.kaltura.com/p/2593311/sp/259331100/playManifest/entryId/1_liveexample/format/url/protocol/https',
  slug: 'live-streams',
};
const payload = (rows: unknown[], title = 'Live Streams') => ({
  success: true,
  data: [{ title, schedule: rows }],
});
const observation: LegislativeObservation = {
  jurisdiction: 'FL',
  session: '2026D',
  chamber: 'senate',
  officialIdentity: 'fl:senate:meeting:6908',
  bodySourceKey: 'fl:senate:RC',
  bodyName: 'Rules',
  stateCommitteeId: null,
  eventType: 'committee',
  sourceUrl: 'https://www.flsenate.gov/Committees/Show/RC/MeetingNotice/6908',
  publishedAt: null,
  fields: {
    title: 'Rules',
    status: 'scheduled',
    time: {
      date: '2026-04-28',
      rawTime: '2:00—6:00 p.m.',
      timezone: 'America/New_York',
      precision: 'instant',
      startsAt: '2026-04-28T18:00:00.000Z',
      endsAt: '2026-04-28T22:00:00.000Z',
    },
  },
  completeFields: ['title', 'status', 'time'],
  completeness: 'complete',
  issues: [],
};
const now = new Date('2026-04-28T18:30:00Z');

describe('Florida Channel live schedule enrichment', () => {
  it('ignores TV rebroadcasts and non-legislative streams, retaining only stable event page links', () => {
    expect(floridaLiveSchedule(payload([event], 'TV 24/7'))).toEqual([]);
    const streams = floridaLiveSchedule(
      payload([
        event,
        { ...event, title: "Governor's Press Conference" },
        { ...event, url: event.url.replace('cdnapisec.kaltura.com', 'attacker.example') },
        { ...event, uuid: '../../unsafe' },
        { ...event, start_time_utc: '2026-04-28T14:00:00' },
      ]),
    );
    expect(streams).toHaveLength(1);
    expect(streams[0]?.watchUrl).toBe(
      'https://thefloridachannel.org/watch/event/1_liveexample/?eid=recRulesExample',
    );
    expect(floridaLiveSchedule({ success: true, data: [] })).toEqual([]);
    expect(() => floridaLiveSchedule({ success: false })).toThrow('unavailable');
  });

  it('enriches a unique official meeting with browser-only capture without altering its schedule', () => {
    const streams = floridaLiveSchedule(payload([event]));
    const before = JSON.stringify(observation);
    expect(floridaLiveCandidate(observation, streams, now)).toEqual({
      provider: 'florida-channel-live',
      officialPageUrl: streams[0]!.watchUrl,
      mediaUrl: null,
      priority: 20,
      capturePolicy: 'BROWSER_CAPTURE_ONLY',
      expiresAt: new Date('2026-04-28T22:00:00Z'),
    });
    expect(JSON.stringify(observation)).toBe(before);
    expect(floridaLiveCandidate(observation, [...streams, ...streams], now)).toBeNull();
    expect(floridaLiveCandidate(observation, streams, new Date('2026-04-28T22:00:00Z'))).toBeNull();
    for (const change of [
      { chamber: 'house' as const },
      { bodyName: 'Appropriations' },
      { fields: { ...observation.fields, status: 'canceled' as const } },
      { fields: { ...observation.fields, visibility: 'private' as const } },
      {
        fields: {
          ...observation.fields,
          time: { ...observation.fields.time!, startsAt: null, precision: 'relative' as const },
        },
      },
      {
        fields: {
          ...observation.fields,
          time: { ...observation.fields.time!, startsAt: '2026-04-28T19:00:00.000Z' },
        },
      },
    ])
      expect(floridaLiveCandidate({ ...observation, ...change }, streams, now)).toBeNull();
  });

  it('uses the notice chamber and exact start to associate a special floor session', () => {
    const streams = floridaLiveSchedule(
      payload([{ ...event, title: 'Senate in Special Session D' }]),
    );
    expect(
      floridaLiveCandidate(
        { ...observation, eventType: 'floor', bodyName: 'Florida Senate' },
        streams,
        now,
      ),
    ).not.toBeNull();
    expect(
      floridaLiveCandidate({ ...observation, eventType: 'floor', chamber: 'house' }, streams, now),
    ).toBeNull();
  });

  it('persists the live event end on create and refresh without promoting capture policy', async () => {
    const create = jest.fn();
    const update = jest.fn();
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'candidate' });
    const prisma = {
      hearingStreamCandidate: { create, update, findFirst },
    } as unknown as PrismaClient;
    const candidate = floridaLiveCandidate(
      observation,
      floridaLiveSchedule(payload([event])),
      now,
    )!;
    const repo = new StreamCandidateRepository(prisma);
    await repo.recordCandidates('hearing', [candidate], { now });
    await repo.recordCandidates('hearing', [candidate], { now });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        expiresAt: candidate.expiresAt,
        capturePolicy: 'BROWSER_CAPTURE_ONLY',
        mediaUrl: null,
      }),
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'candidate' },
      data: expect.objectContaining({ expiresAt: candidate.expiresAt }),
    });
    expect(update.mock.calls[0]![0].data).not.toHaveProperty('capturePolicy');
  });
});
