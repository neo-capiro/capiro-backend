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
import type { CalendarEvent, MeetingResolution, MeetingSection, SourceSet } from './hillday.types.js';

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

interface FakeMeetingRow {
  id: string;
  tenantId: string;
  documentId: string;
  eventId: string;
  ordinal: number;
  event: CalendarEvent;
  resolution: MeetingResolution | null;
}

function manualEvent(eventId: string, subject: string): CalendarEvent {
  return {
    eventId,
    subject,
    startsAt: '2026-09-17T17:00:00.000Z',
    endsAt: '2026-09-17T17:30:00.000Z',
    timeZone: 'America/New_York',
    location: 'Dirksen 555',
    isVirtual: false,
    joinLink: null,
    kind: 'hill',
    clientId: 'client-1',
    organizer: null,
    attendees: [],
    reason: { kind: 'manual', detail: 'Added manually from the Directory.', matchedAddresses: [] },
    source: 'manual',
    connectionId: null,
  };
}

/** Harness for `setMeetings()` — a stateful in-memory `meetings` array that
 *  `prisma.$transaction`'s mocked `tx` mutates directly, so both the
 *  pre-transaction `existing` read and the post-transaction re-read see the
 *  same evolving rows (mirroring what a real transaction commits). */
function makeSetMeetingsHarness(initial: FakeMeetingRow[]) {
  const meetings = [...initial];
  const doc = {
    id: 'doc-1',
    tenantId: 't',
    ownerId: 'user-1',
    clientId: 'client-1',
    clientName: 'Kela Systems',
    timeZone: 'America/New_York',
    resolutionStatus: 'clean' as string | null,
  };
  const prisma = {
    wsHillDayDocument: {
      findFirst: jest.fn(async () => doc),
      update: jest.fn(async () => doc),
    },
    wsHillDayMeeting: {
      findMany: jest.fn(async () => meetings),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        wsHillDayMeeting: {
          deleteMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
            const remove = new Set(where.id.in);
            for (let i = meetings.length - 1; i >= 0; i -= 1) {
              if (remove.has(meetings[i]!.id)) meetings.splice(i, 1);
            }
          }),
          update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeMeetingRow> }) => {
            const row = meetings.find((m) => m.id === where.id)!;
            Object.assign(row, data);
          }),
          create: jest.fn(async ({ data }: { data: Omit<FakeMeetingRow, 'id' | 'resolution'> }) => {
            meetings.push({ ...data, id: `new-${meetings.length}`, resolution: null });
          }),
        },
        wsHillDayDocument: { update: jest.fn(async () => doc) },
      };
      await fn(tx);
    }),
  };
  const source = {
    resolveUserId: jest.fn(async () => 'user-1'),
    tenantMemberEmails: jest.fn(async () => new Set<string>()),
    clientPeopleEmails: jest.fn(async () => new Set<string>()),
    eventsByIds: jest.fn(async (_tenantId: string, _userId: string | null, ids: string[]): Promise<RawEventRow[]> =>
      ids.map((id) =>
        row({
          id,
          clientId: 'client-1',
          subject: `Calendar meeting ${id}`,
          attendees: [],
        }),
      ),
    ),
  };
  const bridge = {
    matchEmails: jest.fn(async () => ({ ok: true as const, data: { matches: [], committeeStaff: [] } })),
  };
  const service = new HillDayDocumentService(prisma as never, source as never, bridge as never);
  return { service, meetings, doc };
}

describe('HillDayDocumentService.setMeetings', () => {
  it('excludes manually-added meetings from replace-by-eventIds deletion', async () => {
    const { service, meetings } = makeSetMeetingsHarness([
      {
        id: 'row-calendar-old',
        tenantId: 't',
        documentId: 'doc-1',
        eventId: 'evt-old',
        ordinal: 0,
        event: row({ id: 'evt-old' }) as never,
        resolution: null,
      },
      {
        id: 'row-manual',
        tenantId: 't',
        documentId: 'doc-1',
        eventId: 'manual-abc',
        ordinal: 1000,
        event: manualEvent('manual-abc', 'Meeting with Sen. Susan Collins (R-ME)'),
        resolution: null,
      },
    ]);

    const result = await service.setMeetings('t', 'user-1', 'doc-1', { eventIds: ['evt-new'] });

    const eventIds = meetings.map((m) => m.eventId);
    expect(eventIds).toContain('manual-abc'); // survived, even though it was never in the new selection
    expect(eventIds).not.toContain('evt-old'); // real calendar removal still works
    expect(eventIds).toContain('evt-new');
    expect(result.meetings.map((m) => m.eventId)).toEqual(expect.arrayContaining(['manual-abc', 'evt-new']));
  });

  it('leaves a manual meeting untouched when the calendar selection is set to empty', async () => {
    const { service, meetings } = makeSetMeetingsHarness([
      {
        id: 'row-manual',
        tenantId: 't',
        documentId: 'doc-1',
        eventId: 'manual-abc',
        ordinal: 1000,
        event: manualEvent('manual-abc', 'Meeting with Sen. Susan Collins (R-ME)'),
        resolution: null,
      },
    ]);
    await service.setMeetings('t', 'user-1', 'doc-1', { eventIds: [] });
    expect(meetings.map((m) => m.eventId)).toEqual(['manual-abc']);
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
