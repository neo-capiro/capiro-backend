import { describe, expect, it, jest } from '@jest/globals';
import {
  HillDayDocumentService,
  clampLimit,
  classifyEvents,
  decodeCursor,
  encodeCursor,
  mondayOf,
} from './hillday-document.service.js';
import type { RawEventRow } from './hillday-source.service.js';
import type { MeetingResolution, MeetingSection, SourceSet } from './hillday.types.js';

function row(over: Partial<RawEventRow>): RawEventRow {
  return {
    id: 'evt-1',
    clientId: null,
    isInternal: false,
    connectionId: 'conn-1',
    source: 'outlook',
    subject: 'Meeting',
    location: 'Dirksen 555',
    startsAt: new Date('2026-09-16T12:45:00Z'),
    endsAt: new Date('2026-09-16T13:15:00Z'),
    organizerEmail: 'neo@maven.example',
    organizerName: 'Neo',
    timeZone: null,
    status: 'scheduled',
    isVirtual: false,
    joinLink: null,
    attendees: [],
    ...over,
  };
}

describe('classifyEvents', () => {
  const internal = new Set(['neo@maven.example', 'ceo@kela.example']);
  const matched = new Set(['cal_perrine@armed-services.senate.gov']);

  it('surfaces tagged, matched and tagged+matched events with a reason', () => {
    const events = classifyEvents(
      [
        row({ id: 'a', clientId: 'client-1', attendees: [{ address: 'cal_perrine@armed-services.senate.gov', name: 'Cal', responseStatus: null }] }),
        row({ id: 'b', clientId: null, attendees: [{ address: 'cal_perrine@armed-services.senate.gov', name: null, responseStatus: null }] }),
        row({ id: 'c', clientId: 'client-1', attendees: [{ address: 'someone@mail.house.gov', name: null, responseStatus: null }] }),
      ],
      'client-1',
      'Kela Systems',
      matched,
      internal,
      'America/New_York',
    );
    expect(events.map((e) => [e.eventId, e.kind, e.reason.kind])).toEqual([
      ['a', 'hill', 'tagged_and_matched'],
      ['b', 'hill', 'matched'],
      ['c', 'hill', 'tagged'],
    ]);
    expect(events[0]?.reason.matchedAddresses).toEqual(['cal_perrine@armed-services.senate.gov']);
  });

  it('lists internal events as internal and hides other clients and unmatched events', () => {
    const events = classifyEvents(
      [
        row({ id: 'internal-flag', clientId: 'client-1', isInternal: true }),
        row({ id: 'internal-people', clientId: 'client-1', attendees: [{ address: 'ceo@kela.example', name: 'CEO', responseStatus: null }] }),
        row({ id: 'other-client', clientId: 'client-2', attendees: [{ address: 'cal_perrine@armed-services.senate.gov', name: null, responseStatus: null }] }),
        row({ id: 'nobody', clientId: null, attendees: [{ address: 'x@vendor.example', name: null, responseStatus: null }] }),
      ],
      'client-1',
      'Kela Systems',
      matched,
      internal,
      'America/New_York',
    );
    expect(events.map((e) => [e.eventId, e.kind])).toEqual([
      ['internal-flag', 'internal'],
      ['internal-people', 'internal'],
    ]);
  });
});

describe('cursors and helpers', () => {
  it('round-trips cursors and clamps limits', () => {
    const cursor = encodeCursor({ u: '2026-09-01T00:00:00.000Z', i: 'abc' });
    expect(decodeCursor(cursor)).toEqual({ u: '2026-09-01T00:00:00.000Z', i: 'abc' });
    expect(decodeCursor('not-base64!!')).toBeNull();
    expect(clampLimit('500')).toBe(50);
    expect(clampLimit(undefined)).toBe(25);
    expect(clampLimit('0', 10)).toBe(10);
  });

  it('finds the Monday of a week in the given time zone', () => {
    expect(mondayOf('2026-09-16T12:45:00Z', 'America/New_York')).toBe('2026-09-14');
    expect(mondayOf('2026-09-14T03:00:00Z', 'America/New_York')).toBe('2026-09-07'); // Sunday evening ET
  });
});

describe('HillDayDocumentService.quality', () => {
  it('reports honest pass/warn states from the meeting records', async () => {
    const office = { memberId: 'member-1', member: 'Sen. Roger Wicker (R-MS)', memberName: 'Roger Wicker', chamber: 'Senate', party: 'R', partyName: 'Republican', state: 'MS', district: '', committees: [], focusAreas: [], bio: null, officeLocation: null, room: null, derivedFrom: 'staffer_office_association' as const, correctedBy: null, alternatives: [] };
    const okResolution: MeetingResolution = {
      meetingId: 'm-1', eventId: 'e-1', state: 'clean', office,
      attendees: [{ attendeeId: 'a1', address: 'a@x.gov', state: 'resolved', stafferId: 'staff-1', name: 'Cal', role: 'PSM', issueAreas: [], topics: [], directoryOffice: office, inviteOffice: null, committee: null, detail: '', manual: false, correction: null, directoryRecord: null }],
      internalParticipants: [], needsConfirmation: false, resolvedAt: 'now', sources: [],
    };
    const schedulerResolution: MeetingResolution = {
      ...okResolution, meetingId: 'm-2', state: 'partial', office: { ...office, memberId: null, member: null, memberName: 'Susan Collins' },
      attendees: [{ ...okResolution.attendees[0]!, attendeeId: 'a2', state: 'scheduler', stafferId: null, role: null }],
      needsConfirmation: true,
    };
    const doneSection: MeetingSection = { sectionId: 'm-1', status: 'done', focus: 'F', background: 'B', reason: null, flags: [{ kind: 'unsupported_claim', detail: 'x' }], generatedAt: 'now', model: 'm', edited: { focus: false, background: false, at: null } };
    const failedSection: MeetingSection = { ...doneSection, sectionId: 'm-2', status: 'unavailable', focus: null, background: null, reason: 'provider_timeout', flags: [] };
    const sourceSet: SourceSet = { assembledAt: 'now', model: 'm', calendar: { eventId: 'e-1', subject: 's' }, directory: { memberId: 'member-1', committees: true, issueAreas: [], bio: false, staffers: [] }, excluded: { issueAreas: [], staffers: [], committees: false, bio: false }, objectives: { count: 2, ids: ['s1', 's2'], status: 'ok' }, note: { included: true, chars: 10 }, correspondence: { threadIds: ['t1'], messages: 3, status: 'ok' }, priorEngagement: { count: 1 }, promptChars: 100 };
    const prisma = {
      wsHillDayDocument: { findFirst: jest.fn(async () => ({ id: 'doc-1', tenantId: 't', lookbackDays: 90, clientName: 'Kela Systems' })) },
      wsHillDayMeeting: {
        findMany: jest.fn(async () => [
          { id: 'm-1', resolution: okResolution, section: doneSection, context: { threadIds: ['t1'] }, sourceSet },
          { id: 'm-2', resolution: schedulerResolution, section: failedSection, context: { threadIds: ['t9'] }, sourceSet: { ...sourceSet, correspondence: { threadIds: [], messages: 0, status: 'ok' } } },
        ]),
      },
    };
    const service = new HillDayDocumentService(prisma as never, {} as never, {} as never);
    const quality = await service.quality('t', 'doc-1');
    const byId = new Map(quality.checks.map((c) => [c.id, c]));
    expect(byId.get('offices_resolved')?.state).toBe('warn');
    expect(byId.get('offices_resolved')?.detail).toContain('1 of 2');
    expect(byId.get('attendee_titles')?.state).toBe('warn');
    expect(byId.get('correspondence_window')?.state).toBe('warn');
    expect(byId.get('correspondence_window')?.detail).toContain('1 selected thread fell outside the window');
    expect(byId.get('objectives_cited')?.state).toBe('pass');
    expect(byId.get('unsupported_claims')?.detail).toContain('Meeting 1');
    expect(byId.get('generation_complete')?.detail).toContain('provider_timeout');
    expect(byId.get('attendees_confirmed')?.detail).toContain('Susan Collins');
    expect(quality.score).toBeGreaterThan(0);
    expect(quality.score).toBeLessThan(1);
  });
});
