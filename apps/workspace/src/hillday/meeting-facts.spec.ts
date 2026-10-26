import { describe, expect, it, jest } from '@jest/globals';
import { HillDayResolutionService } from './hillday-resolution.service.js';
import type { CalendarEvent, MeetingResolution } from './hillday.types.js';

const documentId = '33333333-3333-4333-8333-333333333333';
function event(eventId = 'event-1'): CalendarEvent {
  return {
    eventId, subject: 'Synthetic meeting', location: null,
    startsAt: '2026-11-01T01:30:00-04:00', endsAt: '2026-11-01T01:15:00-05:00',
    timeZone: 'America/New_York', isVirtual: false, joinLink: null, kind: 'hill',
    clientId: 'client-1', organizer: null, attendees: [],
    reason: { kind: 'manual', detail: '', matchedAddresses: [] }, source: 'manual', connectionId: null,
  };
}

function meeting(id = 'meeting-1', eventId = 'event-1') {
  return { id, eventId, ordinal: 0, event: event(eventId) as unknown, resolution: null as MeetingResolution | null };
}
type Row = ReturnType<typeof meeting>;

function harness(rows = [meeting()]) {
  const doc = { id: documentId, tenantId: 'tenant-1', ownerId: 'owner-1', clientId: 'client-1', resolutionStatus: null as string | null };
  const prisma = {
    wsHillDayDocument: {
      findFirst: jest.fn(async () => doc as typeof doc | null),
      update: jest.fn(async ({ data }: { data: Partial<typeof doc> }) => Object.assign(doc, data)),
    },
    wsHillDayMeeting: {
      findMany: jest.fn(async () => rows),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        return Object.assign(row, data);
      }),
    },
  };
  const source = {
    requireClient: jest.fn(async () => undefined),
    tenantMemberEmails: jest.fn(async () => new Set<string>()),
    clientPeopleEmails: jest.fn(async () => new Set<string>()),
  };
  const bridge = {
    matchEmails: jest.fn(async () => ({ ok: true, data: { matches: [], committeeStaff: [] } })),
  };
  const service = new HillDayResolutionService(prisma as never, source as never, bridge as never);
  return { service, prisma, source, bridge, rows, doc };
}

function read(h: ReturnType<typeof harness>) {
  return h.service.getResolution('tenant-1', documentId, 'owner-1');
}

describe('WS11 saved meeting facts GET', () => {
  it('includes unresolved meetings in stored order with exact DST instants, zone and null location', async () => {
    const h = harness([meeting(), { ...meeting('meeting-2', 'event-2'), ordinal: 1 }]);
    const before = JSON.stringify(h.rows);
    const result = await read(h);
    expect(result.meetingFacts).toEqual(h.rows.map((row) => ({
      meetingId: row.id, eventId: row.eventId,
      facts: { subject: 'Synthetic meeting', location: null,
        startsAt: '2026-11-01T01:30:00-04:00', endsAt: '2026-11-01T01:15:00-05:00', timeZone: 'America/New_York' },
    })));
    expect(result.meetings).toEqual([]);
    expect(h.prisma.wsHillDayMeeting.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', documentId }, orderBy: { ordinal: 'asc' },
    });
    expect(h.source.requireClient).toHaveBeenCalledWith('tenant-1', 'owner-1', 'client-1');
    expect(h.prisma.wsHillDayMeeting.update).not.toHaveBeenCalled();
    expect(h.prisma.wsHillDayDocument.update).not.toHaveBeenCalled();
    expect(h.bridge.matchEmails).not.toHaveBeenCalled();
    expect(JSON.stringify(h.rows)).toBe(before);
  });

  it('preserves the POST shape and resolved fields while returning current stored facts after an edit', async () => {
    const h = harness();
    const post = await h.service.resolveDocument('tenant-1', 'owner-1', documentId);
    expect(Object.keys(post).sort()).toEqual(['documentId', 'meetings', 'resolvedAt', 'sources', 'status']);
    const first = await read(h);
    expect(first.meetings).toEqual(post.meetings);
    expect(first.status).toBe(post.status);
    expect(first.resolvedAt).toBe(post.resolvedAt);
    expect(first.sources).toEqual([
      { source: 'calendar', status: 'ok', detail: 'manual' },
      { source: 'directory', status: 'ok', detail: null },
    ]);
    expect(first.meetingFacts[0]!.facts).not.toBeNull();
    await h.service.correct('tenant-1', 'owner-1', documentId, 'meeting-1', {
      kind: 'edit_meeting_facts', subject: 'Updated subject', location: ' New room ',
      startsAt: '2026-11-02T12:00:00Z', endsAt: '2026-11-02T12:30:00Z',
    });
    const updated = await read(h);
    expect(updated.meetingFacts[0]).toEqual({ meetingId: 'meeting-1', eventId: 'event-1', facts: {
      subject: 'Updated subject', location: 'New room', timeZone: 'America/New_York',
      startsAt: '2026-11-02T12:00:00Z', endsAt: '2026-11-02T12:30:00Z',
    } });
    expect(h.rows[0]!.event).toMatchObject(updated.meetingFacts[0]!.facts!);
  });
});

describe('WS11 saved meeting facts validation and access', () => {
  it.each([
    ['default empty object', {}], ['missing snapshot', null], ['array snapshot', []],
    ['cross-event snapshot', { ...event(), eventId: 'event-other' }],
    ['missing identity', { ...event(), eventId: undefined }],
    ['non-string subject', { ...event(), subject: 10 }],
    ['blank subject', { ...event(), subject: '  ' }],
    ['oversized subject', { ...event(), subject: 'a'.repeat(241) }],
    ['missing location', { ...event(), location: undefined }],
    ['non-string location', { ...event(), location: {} }],
    ['oversized location', { ...event(), location: 'a'.repeat(241) }],
    ['nonexistent calendar date', { ...event(), startsAt: '2026-02-30T12:00:00Z' }],
    ['local datetime without offset', { ...event(), startsAt: '2026-11-01T01:00:00' }],
    ['date without time', { ...event(), startsAt: '2026-11-01' }],
    ['invalid end', { ...event(), endsAt: 'tomorrow' }],
    ['equal instants across offsets', { ...event(), endsAt: '2026-11-01T00:30:00-05:00' }],
    ['reversed instants', { ...event(), endsAt: '2026-11-01T01:15:00-04:00' }],
    ['unknown zone', { ...event(), timeZone: 'Mars/Olympus' }],
    ['missing zone', { ...event(), timeZone: null }],
  ])('retains the row with null facts for %s', async (_label, snapshot) => {
    const h = harness([{ ...meeting(), event: snapshot }]);
    expect((await read(h)).meetingFacts).toEqual([{ meetingId: 'meeting-1', eventId: 'event-1', facts: null }]);
    expect(h.prisma.wsHillDayMeeting.update).not.toHaveBeenCalled();
  });

  it('preserves supported boundary text and exact noncanonical zone spelling', async () => {
    const snapshot = { ...event(), subject: ` ${'a'.repeat(238)} `, location: 'b'.repeat(240), timeZone: 'US/Eastern' };
    const h = harness([{ ...meeting(), event: snapshot }]);
    const facts = (await read(h)).meetingFacts[0]!.facts;
    expect(facts).toEqual({ subject: snapshot.subject, startsAt: snapshot.startsAt,
      endsAt: snapshot.endsAt, timeZone: 'US/Eastern', location: snapshot.location });
  });

  it('retains a legacy empty event identity with null facts', async () => {
    const h = harness([meeting('meeting-1', '')]);
    expect((await read(h)).meetingFacts).toEqual([{ meetingId: 'meeting-1', eventId: '', facts: null }]);
  });

  it.each(['other tenant', 'other owner', 'current client denied'])(
    'refuses %s before reading saved meetings', async (reason) => {
      const h = harness();
      if (reason === 'other tenant') h.prisma.wsHillDayDocument.findFirst.mockResolvedValueOnce(null);
      if (reason === 'other owner') h.doc.ownerId = 'other-owner';
      if (reason === 'current client denied') h.source.requireClient.mockRejectedValueOnce(new Error('client access denied'));
      await expect(read(h)).rejects.toThrow(reason === 'current client denied' ? 'client access denied' : 'Document not found');
      expect(h.prisma.wsHillDayDocument.findFirst).toHaveBeenCalledWith({ where: { id: documentId, tenantId: 'tenant-1' } });
      expect(h.prisma.wsHillDayMeeting.findMany).not.toHaveBeenCalled();
      expect(h.prisma.wsHillDayMeeting.update).not.toHaveBeenCalled();
      expect(h.prisma.wsHillDayDocument.update).not.toHaveBeenCalled();
      expect(h.bridge.matchEmails).not.toHaveBeenCalled();
    },
  );
});
