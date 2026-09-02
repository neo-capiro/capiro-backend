import { describe, expect, it } from '@jest/globals';
import { assembleUnitPrompt, durationLabel, parseUnitOutput, type UnitPromptInput } from './generation-prompt.js';
import { buildCarryUnits } from './hillday-context.service.js';
import type { CalendarEvent, MeetingResolution } from './hillday.types.js';
import { officeRefFromContext } from './resolution.rules.js';
import { ctx } from './resolution.rules.spec.js';

const event: CalendarEvent = {
  eventId: 'evt-1',
  subject: 'Kela Systems / SASC staff — FY27 USV line',
  startsAt: '2026-09-16T12:45:00.000Z',
  endsAt: '2026-09-16T13:15:00.000Z',
  timeZone: 'America/New_York',
  location: 'Dirksen 555',
  isVirtual: false,
  joinLink: null,
  kind: 'hill',
  clientId: 'client-1',
  organizer: null,
  attendees: [{ address: 'cal_perrine@armed-services.senate.gov', name: 'Cal Perrine', responseStatus: null }],
  reason: { kind: 'tagged', detail: 'Tagged', matchedAddresses: [] },
  source: 'outlook',
  connectionId: null,
};

function resolution(): MeetingResolution {
  const office = officeRefFromContext(ctx());
  return {
    meetingId: 'm-1',
    eventId: 'evt-1',
    state: 'clean',
    office: { ...office, room: 'Dirksen 555', derivedFrom: 'staffer_office_association', correctedBy: null, alternatives: [] },
    attendees: [
      {
        attendeeId: 'att_perrine',
        address: 'cal_perrine@armed-services.senate.gov',
        state: 'resolved',
        stafferId: 'staff-1',
        name: 'Cal Perrine',
        role: 'Professional Staff Member',
        issueAreas: ['Seapower'],
        topics: ['Seapower', 'Procurement'],
        directoryOffice: office,
        inviteOffice: null,
        committee: null,
        detail: '',
        manual: false,
        correction: null,
        directoryRecord: null,
      },
      {
        attendeeId: 'att_voight',
        address: 'hannah_voight@wicker.senate.gov',
        state: 'resolved',
        stafferId: 'staff-2',
        name: 'Hannah Voight',
        role: 'Legislative Aide',
        issueAreas: [],
        topics: ['Scheduling'],
        directoryOffice: office,
        inviteOffice: null,
        committee: null,
        detail: '',
        manual: false,
        correction: null,
        directoryRecord: null,
      },
    ],
    internalParticipants: [],
    needsConfirmation: false,
    resolvedAt: '2026-09-01T00:00:00.000Z',
    sources: [],
  };
}

function input(over: Partial<UnitPromptInput> = {}): UnitPromptInput {
  const res = resolution();
  const units = buildCarryUnits(res, null);
  return {
    firmName: 'Maven Advocacy',
    client: { name: 'Kela Systems', description: 'Uncrewed maritime systems' },
    event,
    timeZone: 'America/New_York',
    resolution: res,
    units,
    carry: { committees: true, bio: false, issueAreas: ['issue:shipbuilding'], staffers: ['att_perrine'] },
    note: 'Perrine asked for unit cost at rate in June and we never sent it.',
    objectives: { status: 'ok', items: [{ id: 's1', title: 'FY27 USV line', type: 'authorization', goal: 'Hold the $48M line.' }] },
    threads: { status: 'ok', items: [] },
    prior: [],
    model: 'claude-sonnet-4-6',
    ...over,
  };
}

describe('assembleUnitPrompt — carry-over enforcement', () => {
  it('includes only the carried Directory units and logs the excluded ones', () => {
    const { user, sourceSet } = assembleUnitPrompt(input());
    expect(user).toContain('Committees: Armed Services (Chair)');
    expect(user).toContain('Issue areas: Shipbuilding');
    expect(user).not.toContain('Unmanned surface vessels');
    expect(user).not.toContain('Fleet size');
    expect(user).not.toContain('Bio: Chairs Armed Services.');
    expect(user).toContain('Staffer: Cal Perrine, Professional Staff Member — covers Seapower, Procurement');
    // Voight's role/topics were NOT carried: her name may appear as a calendar
    // fact, but her staffer unit (role + topics) must not.
    expect(user).not.toContain('Legislative Aide');
    expect(user).not.toContain('Scheduling');
    expect(sourceSet.directory).toEqual({
      memberId: 'member-1',
      committees: true,
      issueAreas: ['issue:shipbuilding'],
      bio: false,
      staffers: ['att_perrine'],
    });
    expect(sourceSet.excluded.issueAreas).toEqual(['issue:unmanned_surface_vessels', 'issue:fleet_size']);
    expect(sourceSet.excluded.staffers).toEqual(['att_voight']);
    expect(sourceSet.excluded.bio).toBe(true);
    expect(sourceSet.excluded.committees).toBe(false);
  });

  it('drops committees and every staffer when the user deselects them', () => {
    const { user, sourceSet } = assembleUnitPrompt(
      input({ carry: { committees: false, bio: false, issueAreas: [], staffers: [] } }),
    );
    expect(user).not.toContain('Committees:');
    expect(user).not.toContain('Staffer:');
    expect(user).not.toContain('Issue areas:');
    expect(user).not.toContain('Bio:');
    // The member identity is a resolution fact, not a carried unit — it stays.
    expect(user).toContain('Member: Sen. Roger Wicker (R-MS)');
    expect(sourceSet.excluded.committees).toBe(true);
    expect(sourceSet.excluded.staffers).toEqual(['att_perrine', 'att_voight']);
  });

  it('carries the user note verbatim and marks it in the source set', () => {
    const note = 'Do not re-litigate the fleet-count argument — he already agrees.';
    const { user, system, sourceSet } = assembleUnitPrompt(input({ note }));
    expect(user).toContain(`<<USER_NOTE>>\n${note}\n<</USER_NOTE>>`);
    expect(system).toMatch(/Never\s+contradict it/);
    expect(sourceSet.note).toEqual({ included: true, chars: note.length });
  });

  it('names an unavailable objectives layer instead of inventing objectives', () => {
    const { user, sourceSet } = assembleUnitPrompt(input({ objectives: { status: 'unavailable', items: [] } }));
    expect(user).toContain('Objectives layer unavailable');
    expect(sourceSet.objectives).toEqual({ count: 0, ids: [], status: 'unavailable' });
  });

  it('renders correspondence messages with dates and counts them', () => {
    const { user, sourceSet } = assembleUnitPrompt(
      input({
        threads: {
          status: 'ok',
          items: [
            {
              id: 'thr-1',
              subject: 'FY27 USV line — materials',
              participants: ['Cal Perrine'],
              messages: [
                { threadId: 'thr-1', fromEmail: 'cal@x.gov', fromName: 'Cal Perrine', sentAt: new Date('2026-07-20T12:00:00Z'), subject: null, body: 'Can you send unit cost at rate?' },
              ],
            },
          ],
        },
      }),
    );
    expect(user).toContain('Thread: FY27 USV line — materials — Cal Perrine');
    expect(user).toContain('[2026-07-20] Cal Perrine: Can you send unit cost at rate?');
    expect(sourceSet.correspondence).toEqual({ threadIds: ['thr-1'], messages: 1, status: 'ok' });
  });
});

describe('parseUnitOutput', () => {
  it('parses plain JSON and fenced JSON', () => {
    expect(parseUnitOutput('{"focus":"A","background":"B","unsupported":[]}')).toEqual({ focus: 'A', background: 'B', unsupported: [] });
    expect(parseUnitOutput('```json\n{"focus":"A","background":"B","unsupported":["x"]}\n```')).toEqual({ focus: 'A', background: 'B', unsupported: ['x'] });
  });

  it('recovers a JSON object embedded in prose and rejects garbage', () => {
    expect(parseUnitOutput('Here you go: {"focus":"A","background":"B"} thanks')).toEqual({ focus: 'A', background: 'B', unsupported: [] });
    expect(parseUnitOutput('no json here')).toBeNull();
    expect(parseUnitOutput('{"unsupported":[]}')).toBeNull();
  });
});

describe('durationLabel', () => {
  it('formats minutes and hours', () => {
    expect(durationLabel('2026-09-16T12:45:00Z', '2026-09-16T13:15:00Z')).toBe('30 min');
    expect(durationLabel('2026-09-16T12:00:00Z', '2026-09-16T13:15:00Z')).toBe('1 hr 15 min');
    expect(durationLabel('2026-09-16T12:00:00Z', '2026-09-16T14:00:00Z')).toBe('2 hr');
  });
});
