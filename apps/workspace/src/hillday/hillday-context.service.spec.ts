import { describe, expect, it, jest } from '@jest/globals';
import {
  HillDayContextService,
  ageDays,
  buildCarryUnits,
  effectiveCarry,
  toThreadRef,
} from './hillday-context.service.js';
import type { MeetingResolution, ResolvedAttendee } from './hillday.types.js';
import { officeRefFromContext } from './resolution.rules.js';
import { ctx } from './resolution.rules.spec.js';

function att(id: string, over: Partial<ResolvedAttendee>): ResolvedAttendee {
  return {
    attendeeId: id,
    address: `${id}@x.gov`,
    state: 'resolved',
    stafferId: 'staff-1',
    name: id,
    role: 'Aide',
    issueAreas: [],
    topics: ['Topic'],
    directoryOffice: null,
    inviteOffice: null,
    committee: null,
    detail: '',
    manual: false,
    correction: null,
    directoryRecord: null,
    ...over,
  };
}

function resolution(): MeetingResolution {
  const office = officeRefFromContext(ctx());
  return {
    meetingId: 'm-1',
    eventId: 'evt-1',
    state: 'partial',
    office: { ...office, room: null, derivedFrom: 'staffer_office_association', correctedBy: null, alternatives: [] },
    attendees: [
      att('known', {}),
      att('unknown', { state: 'unresolved', stafferId: null, role: null }),
      att('sched', { state: 'scheduler', stafferId: null, role: null }),
      att('manual', { stafferId: null, manual: true }),
    ],
    internalParticipants: [],
    needsConfirmation: false,
    resolvedAt: '2026-09-01T00:00:00.000Z',
    sources: [],
  };
}

describe('buildCarryUnits — server-supplied defaults (requirements §5)', () => {
  it('applies the default rule: committees on, top two issue areas on, bio off, Directory staffers on', () => {
    const units = buildCarryUnits(resolution(), null);
    const byId = new Map(units.map((u) => [u.id, u]));
    expect(byId.get('committees')?.defaultSelected).toBe(true);
    expect(byId.get('issue:shipbuilding')?.defaultSelected).toBe(true);
    expect(byId.get('issue:unmanned_surface_vessels')?.defaultSelected).toBe(true);
    expect(byId.get('issue:fleet_size')?.defaultSelected).toBe(false);
    expect(byId.get('bio')?.defaultSelected).toBe(false);
    expect(byId.get('staffer:known')?.defaultSelected).toBe(true);
    expect(byId.get('staffer:unknown')?.defaultSelected).toBe(false);
    expect(byId.get('staffer:sched')?.defaultSelected).toBe(false);
    // Manually entered attendee without a Directory record: off by default.
    expect(byId.get('staffer:manual')?.defaultSelected).toBe(false);
    expect(byId.get('staffer:sched')?.detail).toContain('Scheduling address');
    // Effective selection equals the defaults when nothing is stored.
    expect(units.every((u) => u.selected === u.defaultSelected)).toBe(true);
  });

  it('honours a stored record over the defaults', () => {
    const units = buildCarryUnits(resolution(), {
      note: '',
      carry: { committees: false, bio: true, issueAreas: ['issue:fleet_size'], staffers: ['unknown'] },
      threadIds: [],
      lookbackDays: null,
      savedAt: 'now',
      savedBy: 'user',
    });
    const carry = effectiveCarry(units);
    expect(carry).toEqual({ committees: false, bio: true, issueAreas: ['issue:fleet_size'], staffers: ['unknown'] });
  });

  it('returns no units without a resolution', () => {
    expect(buildCarryUnits(null, null)).toEqual([]);
  });
});

describe('thread refs', () => {
  it('computes age in days and participant summaries', () => {
    const now = new Date('2026-09-01T00:00:00Z');
    expect(ageDays(new Date('2026-07-20T00:00:00Z'), now)).toBe(43);
    const ref = toThreadRef(
      {
        id: 't1',
        subject: 'Materials',
        participants: [{ email: 'a@x.gov', name: 'Cal Perrine' }, { email: 'b@x.gov', name: null }],
        lastMessageAt: new Date('2026-07-20T00:00:00Z'),
        clientId: 'client-1',
        messageCount: 6,
      },
      'client-1',
      now,
    );
    expect(ref).toEqual({
      id: 't1',
      subject: 'Materials',
      participants: ['Cal Perrine', 'b@x.gov'],
      messageCount: 6,
      lastMessageAt: '2026-07-20T00:00:00.000Z',
      ageDays: 43,
      clientTagged: true,
    });
  });
});

describe('HillDayContextService.write', () => {
  it('stores the note verbatim and drops unit ids that do not exist for the meeting', async () => {
    const update = jest.fn(async () => ({}));
    const prisma = {
      wsHillDayDocument: { findFirst: jest.fn(async () => ({ id: 'doc-1', ownerId: 'user-1', clientId: 'client-1', lookbackDays: 90 })) },
      wsHillDayMeeting: {
        findFirst: jest.fn(async () => ({ id: 'm-1', resolution: resolution(), context: null })),
        update,
      },
    };
    const service = new HillDayContextService(prisma as never, {} as never);
    const note = '  Perrine asked for unit cost at rate in June.  ';
    const result = await service.write('tenant-1', 'user-1', 'doc-1', 'm-1', {
      note,
      carry: { committees: true, bio: false, issueAreas: ['issue:shipbuilding', 'issue:bogus'], staffers: ['known', 'ghost'] },
      threadIds: ['t1', 't1', 't2'],
    });
    expect(result.record.note).toBe(note);
    expect(result.record.carry.issueAreas).toEqual(['issue:shipbuilding']);
    expect(result.record.carry.staffers).toEqual(['known']);
    expect(result.record.threadIds).toEqual(['t1', 't2']);
    // 1 committees + 1 issue + 1 staffer + 2 threads + 1 note
    expect(result.sourceCount).toBe(6);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('refuses writes from anyone but the owner', async () => {
    const prisma = {
      wsHillDayDocument: { findFirst: jest.fn(async () => ({ id: 'doc-1', ownerId: 'owner', clientId: 'client-1', lookbackDays: 90 })) },
      wsHillDayMeeting: { findFirst: jest.fn(async () => ({ id: 'm-1', resolution: resolution(), context: null })), update: jest.fn() },
    };
    const service = new HillDayContextService(prisma as never, {} as never);
    await expect(
      service.write('tenant-1', 'intruder', 'doc-1', 'm-1', {
        note: '',
        carry: { committees: true, bio: false, issueAreas: [], staffers: [] },
        threadIds: [],
      }),
    ).rejects.toThrow('Only the document owner');
  });
});
