import { describe, expect, it, jest } from '@jest/globals';
import type {
  BridgeMatchEmailsResponse,
  BridgeMemberContext,
  BridgeResult,
} from './directory-bridge.client.js';
import { HillDayResolutionService } from './hillday-resolution.service.js';
import type { CalendarEvent, MeetingResolution } from './hillday.types.js';
import { ctx } from './resolution.rules.spec.js';

const wicker = ctx();
const collins = ctx({ id: 'member-2', fullName: 'Sen. Susan Collins', memberName: 'Susan Collins', state: 'ME' });
const courtney = ctx({ id: 'member-3', fullName: 'Rep. Joe Courtney', memberName: 'Joe Courtney', chamber: 'House', state: 'CT', district: 'CT-2', party: 'D', partyName: 'Democrat' });
const golden = ctx({ id: 'member-4', fullName: 'Rep. Jared Golden', memberName: 'Jared Golden', chamber: 'House', state: 'ME', district: 'ME-2', party: 'D', partyName: 'Democrat' });

function event(id: string, attendees: string[], over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    eventId: id,
    subject: `Meeting ${id}`,
    startsAt: '2026-09-16T12:45:00.000Z',
    endsAt: '2026-09-16T13:15:00.000Z',
    timeZone: 'America/New_York',
    location: 'Dirksen 555',
    isVirtual: false,
    joinLink: null,
    kind: 'hill',
    clientId: 'client-1',
    organizer: { address: 'neo@maven.example', name: 'Neo', responseStatus: null },
    attendees: attendees.map((address) => ({ address, name: null, responseStatus: null })),
    reason: { kind: 'tagged', detail: '', matchedAddresses: [] },
    source: 'outlook',
    connectionId: null,
    ...over,
  };
}

interface FakeMeeting {
  id: string;
  eventId: string;
  ordinal: number;
  event: CalendarEvent;
  resolution: MeetingResolution | null;
  context: null;
  section: null;
}

function makeHarness(meetings: FakeMeeting[]) {
  const doc = { id: 'doc-1', tenantId: 't', ownerId: 'user-1', clientId: 'client-1', clientName: 'Kela Systems', resolutionStatus: null as string | null };
  const prisma = {
    wsHillDayDocument: {
      findFirst: jest.fn(async () => doc),
      update: jest.fn(async ({ data }: { data: { resolutionStatus?: string } }) => {
        if (data.resolutionStatus !== undefined) doc.resolutionStatus = data.resolutionStatus;
        return doc;
      }),
    },
    wsHillDayMeeting: {
      findMany: jest.fn(async () => meetings),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => meetings.find((m) => m.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: { resolution: MeetingResolution } }) => {
        const m = meetings.find((x) => x.id === where.id)!;
        m.resolution = data.resolution;
        return m;
      }),
    },
  };
  const source = {
    tenantMemberEmails: jest.fn(async () => new Set(['neo@maven.example'])),
    clientPeopleEmails: jest.fn(async () => new Set(['ceo@kela.example'])),
    upsertEngagementContact: jest.fn(async () => 'contact-1'),
  };
  const matchResponse: BridgeMatchEmailsResponse = {
    snapshotId: 's',
    matches: [
      {
        attendeeEmail: 'hannah_voight@wicker.senate.gov',
        matchKind: 'staff',
        directoryContactId: 'member-1',
        directoryContactName: 'Sen. Roger Wicker',
        member: wicker,
        staff: { id: 'staff-2', fullName: 'Hannah Voight', title: 'Legislative Aide', email: 'hannah_voight@wicker.senate.gov', officeLocation: '', issueAreas: ['Scheduling'], roles: [], isCurrent: true },
      },
      {
        attendeeEmail: 'brett.kalmar@mail.house.gov',
        matchKind: 'staff',
        directoryContactId: 'member-4',
        directoryContactName: 'Rep. Jared Golden',
        member: golden,
        staff: { id: 'staff-5', fullName: 'Brett Kalmar', title: 'Legislative Director', email: 'brett.kalmar@mail.house.gov', officeLocation: '', issueAreas: ['Industrial base'], roles: [], isCurrent: false },
      },
    ],
    committeeStaff: [
      {
        attendeeEmail: 'cal_perrine@armed-services.senate.gov',
        staff: { id: 'staff-1', fullName: 'Cal Perrine', title: 'Professional Staff Member', email: 'cal_perrine@armed-services.senate.gov', isCurrent: true },
        committee: { id: 'committee-9', name: 'Senate Committee on Armed Services', chamber: 'Senate', kind: 'committee' },
      },
    ],
  };
  const bridge = {
    matchEmails: jest.fn(async (): Promise<BridgeResult<BridgeMatchEmailsResponse>> => ({ ok: true, data: matchResponse })),
    searchContacts: jest.fn(async (q: string): Promise<BridgeResult<{ contacts: BridgeMemberContext[] }>> => ({
      ok: true,
      data: { contacts: q === 'collins' ? [collins] : q === 'wicker' ? [wicker] : [] },
    })),
    memberContext: jest.fn(async (id: string): Promise<BridgeResult<{ context: BridgeMemberContext | null }>> => ({
      ok: true,
      data: { context: id === 'member-3' ? courtney : null },
    })),
    staffer: jest.fn(),
    searchStaffers: jest.fn(),
  };
  const service = new HillDayResolutionService(prisma as never, source as never, bridge as never);
  return { service, prisma, source, bridge, meetings, doc };
}

describe('HillDayResolutionService.resolveDocument', () => {
  it('produces all four attendee states, derives offices, and rolls up to partial', async () => {
    const meetings: FakeMeeting[] = [
      { id: 'm-1', eventId: 'e-1', ordinal: 0, context: null, section: null, resolution: null,
        event: event('e-1', ['cal_perrine@armed-services.senate.gov', 'hannah_voight@wicker.senate.gov', 'neo@maven.example']) },
      { id: 'm-2', eventId: 'e-2', ordinal: 1, context: null, section: null, resolution: null,
        event: event('e-2', ['delaney.rusk@mail.house.gov', 't.okonjo@mail.house.gov'], { location: 'Rayburn 2454' }) },
      { id: 'm-3', eventId: 'e-3', ordinal: 2, context: null, section: null, resolution: null,
        event: event('e-3', ['scheduling@collins.senate.gov'], { location: 'Dirksen 413' }) },
      { id: 'm-4', eventId: 'e-4', ordinal: 3, context: null, section: null, resolution: null,
        event: event('e-4', ['brett.kalmar@mail.house.gov'], { location: 'Rayburn 2449' }) },
    ];
    const { service, doc } = makeHarness(meetings);
    const result = await service.resolveDocument('t', 'user-1', 'doc-1');

    expect(result.status).toBe('partial');
    expect(doc.resolutionStatus).toBe('partial');
    const [m1, m2, m3, m4] = result.meetings;

    // m-1: committee staffer + Wicker aide → office derived from the aide's association; firm side excluded.
    expect(m1!.state).toBe('clean');
    expect(m1!.office.member).toBe('Sen. Roger Wicker (R-MS)');
    expect(m1!.office.derivedFrom).toBe('staffer_office_association');
    expect(m1!.office.room).toBe('Dirksen 555');
    expect(m1!.attendees.map((a) => [a.name, a.state])).toEqual([
      ['Cal Perrine', 'resolved'],
      ['Hannah Voight', 'resolved'],
    ]);
    expect(m1!.attendees[0]!.role).toBe('Professional Staff Member, Senate Committee on Armed Services');
    expect(m1!.internalParticipants.map((p) => p.address)).toEqual(['neo@maven.example']);

    // m-2: two house addresses nobody knows → unresolved, office unknown → partial.
    expect(m2!.attendees.every((a) => a.state === 'unresolved')).toBe(true);
    expect(m2!.office.memberId).toBeNull();
    expect(m2!.state).toBe('partial');

    // m-3: scheduler-only invite → office from the invite domain, needs confirmation.
    expect(m3!.attendees[0]!.state).toBe('scheduler');
    expect(m3!.office.member).toBe('Sen. Susan Collins (R-ME)');
    expect(m3!.office.derivedFrom).toBe('invite_domain');
    expect(m3!.needsConfirmation).toBe(true);
    expect(m3!.state).toBe('partial');

    // m-4: Directory lists the staffer as former → stale, choice offered.
    expect(m4!.attendees[0]!.state).toBe('stale');
    expect(m4!.attendees[0]!.detail).toContain('former');
    expect(m4!.attendees[0]!.directoryOffice?.member).toBe('Rep. Jared Golden (D-ME-02)');
  });

  it('degrades to unavailable when the Directory bridge is down, never fabricating a match', async () => {
    const meetings: FakeMeeting[] = [
      { id: 'm-1', eventId: 'e-1', ordinal: 0, context: null, section: null, resolution: null,
        event: event('e-1', ['hannah_voight@wicker.senate.gov']) },
    ];
    const { service, bridge } = makeHarness(meetings);
    bridge.matchEmails.mockResolvedValueOnce({ ok: false, status: 'unavailable', detail: 'Directory timed out' });
    const result = await service.resolveDocument('t', 'user-1', 'doc-1');
    expect(result.sources.find((s) => s.source === 'directory')?.status).toBe('unavailable');
    expect(result.meetings[0]!.attendees[0]!.state).toBe('unresolved');
    expect(result.meetings[0]!.attendees[0]!.detail).toContain('Directory unavailable');
    expect(result.meetings[0]!.office.memberId).toBeNull();
  });
});

describe('HillDayResolutionService.correct', () => {
  async function resolved() {
    const meetings: FakeMeeting[] = [
      { id: 'm-2', eventId: 'e-2', ordinal: 0, context: null, section: null, resolution: null,
        event: event('e-2', ['t.okonjo@mail.house.gov'], { location: 'Rayburn 2454' }) },
      { id: 'm-4', eventId: 'e-4', ordinal: 1, context: null, section: null, resolution: null,
        event: event('e-4', ['brett.kalmar@mail.house.gov'], { location: 'Rayburn 2449' }) },
    ];
    const h = makeHarness(meetings);
    await h.service.resolveDocument('t', 'user-1', 'doc-1');
    return h;
  }

  it('applies a manual attendee (name + role) and marks it confirmed', async () => {
    const { service, meetings } = await resolved();
    const attendeeId = meetings[0]!.resolution!.attendees[0]!.attendeeId;
    const next = await service.correct('t', 'user-1', 'doc-1', 'm-2', {
      kind: 'manual_attendee',
      attendeeId,
      name: 'Tunde Okonjo',
      role: 'Defense Fellow',
    });
    const a = next.attendees[0]!;
    expect(a.state).toBe('resolved');
    expect(a.manual).toBe(true);
    expect(a.name).toBe('Tunde Okonjo');
    expect(a.role).toBe('Defense Fellow');
    expect(a.detail).toContain('Confirmed by you');
    expect(a.correction?.kind).toBe('manual_attendee');
  });

  it('creates the tenant Directory record for an unresolved address', async () => {
    const { service, source, meetings } = await resolved();
    const attendeeId = meetings[0]!.resolution!.attendees[0]!.attendeeId;
    const next = await service.correct('t', 'user-1', 'doc-1', 'm-2', {
      kind: 'create_directory_record',
      attendeeId,
      name: 'Tunde Okonjo',
      role: 'Defense Fellow',
    });
    expect(source.upsertEngagementContact).toHaveBeenCalledWith('t', 'client-1', expect.objectContaining({ email: 't.okonjo@mail.house.gov', fullName: 'Tunde Okonjo' }));
    expect(next.attendees[0]!.directoryRecord).toEqual({ kind: 'engagement_contact', id: 'contact-1' });
  });

  it('accepts a stale association and lets the chosen office govern the meeting', async () => {
    const { service, meetings } = await resolved();
    const attendeeId = meetings[1]!.resolution!.attendees[0]!.attendeeId;
    const next = await service.correct('t', 'user-1', 'doc-1', 'm-4', {
      kind: 'accept_stale',
      attendeeId,
      useOffice: 'directory',
    });
    expect(next.attendees[0]!.state).toBe('resolved');
    expect(next.office.member).toBe('Rep. Jared Golden (D-ME-02)');
    expect(next.state).toBe('clean');
  });

  it('changes the office on request and keeps the correction across a re-run', async () => {
    const { service, meetings } = await resolved();
    const next = await service.correct('t', 'user-1', 'doc-1', 'm-4', { kind: 'change_office', memberId: 'member-3' });
    expect(next.office.member).toBe('Rep. Joe Courtney (D-CT-02)');
    expect(next.office.derivedFrom).toBe('user_correction');
    expect(next.office.correctedBy).toBe('user-1');
    expect(next.office.alternatives.map((a) => a.memberId)).toEqual(['member-4']);

    const rerun = await service.resolveDocument('t', 'user-1', 'doc-1');
    const m4 = rerun.meetings.find((m) => m.meetingId === 'm-4')!;
    expect(m4.office.member).toBe('Rep. Joe Courtney (D-CT-02)');
    expect(m4.office.derivedFrom).toBe('user_correction');
    void meetings;
  });
});
