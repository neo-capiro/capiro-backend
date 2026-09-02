import { describe, expect, it } from '@jest/globals';
import type { BridgeMemberContext } from './directory-bridge.client.js';
import type { ResolvedAttendee, ResolvedOffice } from './hillday.types.js';
import {
  attendeeIdFor,
  deriveOffice,
  emptyOffice,
  isSchedulerAddress,
  lastNameMatches,
  memberLabel,
  normalizeAddress,
  officeRefFromContext,
  partyLine,
  rollUpMeeting,
  senateSubdomain,
  shortCommittee,
} from './resolution.rules.js';

export function ctx(over: Partial<BridgeMemberContext> = {}): BridgeMemberContext {
  return {
    id: 'member-1',
    bioguideId: 'W000437',
    fullName: 'Sen. Roger Wicker',
    memberName: 'Roger Wicker',
    honorific: 'Sen.',
    title: 'Senator',
    chamber: 'Senate',
    state: 'MS',
    district: '',
    party: 'R',
    partyName: 'Republican',
    officeLocation: 'Dirksen 555',
    phone: '',
    email: '',
    bioNarrative: 'Chairs Armed Services.',
    committees: ['Senate Committee on Armed Services', 'Senate Committee on Commerce, Science, and Transportation'],
    committeesWithRole: [
      { name: 'Senate Committee on Armed Services', role: 'Chair' },
      { name: 'Senate Committee on Commerce, Science, and Transportation', role: 'Member' },
    ],
    committeeLeadership: [],
    leadershipPositions: [],
    focusAreas: [],
    topIssues: [
      { issue: 'Fleet size', stafferCount: 1 },
      { issue: 'Shipbuilding', stafferCount: 4 },
      { issue: 'Unmanned surface vessels', stafferCount: 3 },
    ],
    staff: [],
    ...over,
  };
}

function attendee(over: Partial<ResolvedAttendee>): ResolvedAttendee {
  return {
    attendeeId: over.attendeeId ?? attendeeIdFor(over.address ?? 'x@example.gov'),
    address: 'x@example.gov',
    state: 'resolved',
    stafferId: 'staff-1',
    name: 'Someone',
    role: 'Legislative Aide',
    issueAreas: [],
    topics: [],
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

describe('resolution rules — addresses', () => {
  it('normalizes and hashes addresses deterministically', () => {
    expect(normalizeAddress('  Cal_Perrine@Armed-Services.senate.gov ')).toBe(
      'cal_perrine@armed-services.senate.gov',
    );
    expect(normalizeAddress('not an address')).toBeNull();
    expect(attendeeIdFor('A@B.gov')).toBe(attendeeIdFor('a@b.gov'));
    expect(attendeeIdFor('a@b.gov')).toMatch(/^att_[0-9a-f]{10}$/);
  });

  it('recognises scheduler-only addresses', () => {
    expect(isSchedulerAddress('scheduling@collins.senate.gov')).toBe(true);
    expect(isSchedulerAddress('ha.scheduler@mail.house.gov')).toBe(true);
    expect(isSchedulerAddress('cal_perrine@armed-services.senate.gov')).toBe(false);
    expect(isSchedulerAddress('t.okonjo@mail.house.gov')).toBe(false);
  });

  it('extracts senate personal-office subdomains only', () => {
    expect(senateSubdomain('hannah_voight@wicker.senate.gov')).toBe('wicker');
    expect(senateSubdomain('cal_perrine@armed-services.senate.gov')).toBe('armed-services');
    expect(senateSubdomain('someone@mail.house.gov')).toBeNull();
    expect(senateSubdomain('x@mail.senate.gov')).toBeNull();
  });

  it('matches a subdomain to a member by last name', () => {
    expect(lastNameMatches('wicker', 'Roger Wicker')).toBe(true);
    expect(lastNameMatches('wicker', 'Sen. Roger Wicker')).toBe(true);
    expect(lastNameMatches('collins', 'Roger Wicker')).toBe(false);
  });
});

describe('resolution rules — labels', () => {
  it('formats senate and house member labels', () => {
    expect(memberLabel(ctx())).toBe('Sen. Roger Wicker (R-MS)');
    expect(
      memberLabel(ctx({ fullName: 'Rep. Rob Wittman', chamber: 'House', state: 'VA', district: 'VA-1' })),
    ).toBe('Rep. Rob Wittman (R-VA-01)');
  });

  it('formats the party · state line', () => {
    expect(partyLine({ partyName: 'Republican', party: 'R', state: 'MS', district: null, chamber: 'Senate' })).toBe(
      'Republican · Mississippi',
    );
    expect(partyLine({ partyName: 'Republican', party: 'R', state: 'VA', district: 'VA-1', chamber: 'House' })).toBe(
      'Republican · Virginia 1st',
    );
  });

  it('shortens committee names', () => {
    expect(shortCommittee('Senate Committee on Armed Services')).toBe('Armed Services');
    expect(shortCommittee('House Committee on the Judiciary')).toBe('Judiciary');
    expect(shortCommittee('Subcommittee on Seapower and Projection Forces')).toBe(
      'Seapower and Projection Forces',
    );
  });

  it('keeps only full committees, strips the "Committee" suffix and drops ex officio seats', () => {
    const office = officeRefFromContext(
      ctx({
        committeesWithRole: [
          { name: 'Commerce, Science and Transportation Committee Coast Guard, Maritime and Fisheries Subcommittee', role: 'Member' },
          { name: 'Rules and Administration Committee', role: 'Member' },
          { name: 'Armed Services Committee Seapower Subcommittee', role: 'Ex Officio' },
          { name: 'Intelligence', role: 'Ex Officio' },
          { name: 'Armed Services Committee', role: 'Chair' },
          { name: 'Commerce, Science and Transportation Committee', role: null },
        ],
      }),
    );
    expect(office.committees).toEqual([
      'Armed Services (Chair)',
      'Rules and Administration',
      'Intelligence',
      'Commerce, Science and Transportation',
    ]);
  });

  it('builds an office ref with committee roles and salience-ordered issue areas', () => {
    const office = officeRefFromContext(ctx());
    expect(office.member).toBe('Sen. Roger Wicker (R-MS)');
    expect(office.committees).toEqual(['Armed Services (Chair)', 'Commerce, Science, and Transportation']);
    expect(office.focusAreas.map((f) => f.label)).toEqual([
      'Shipbuilding',
      'Unmanned surface vessels',
      'Fleet size',
    ]);
    expect(office.bio).toBe('Chairs Armed Services.');
  });
});

describe('resolution rules — office derivation', () => {
  const wicker = officeRefFromContext(ctx());
  const collins = officeRefFromContext(
    ctx({ id: 'member-2', fullName: 'Sen. Susan Collins', memberName: 'Susan Collins', state: 'ME' }),
  );

  it('derives the office from the majority staffer association', () => {
    const office = deriveOffice({
      attendees: [
        attendee({ address: 'a@x.gov', directoryOffice: wicker }),
        attendee({ address: 'b@x.gov', directoryOffice: collins }),
        attendee({ address: 'c@x.gov', directoryOffice: wicker }),
      ],
      inviteDomainOffice: null,
      committee: null,
      room: 'Dirksen 555',
      previous: null,
    });
    expect(office.memberId).toBe('member-1');
    expect(office.derivedFrom).toBe('staffer_office_association');
    expect(office.alternatives.map((a) => a.memberId)).toEqual(['member-2']);
    expect(office.room).toBe('Dirksen 555');
  });

  it('keeps a user-corrected office verbatim', () => {
    const previous: ResolvedOffice = {
      ...collins,
      room: null,
      derivedFrom: 'user_correction',
      correctedBy: 'user_1',
      alternatives: [],
    };
    const office = deriveOffice({
      attendees: [attendee({ directoryOffice: wicker })],
      inviteDomainOffice: null,
      committee: null,
      room: 'Dirksen 413',
      previous,
    });
    expect(office.memberId).toBe('member-2');
    expect(office.correctedBy).toBe('user_1');
    expect(office.room).toBe('Dirksen 413');
  });

  it('falls back to the invite domain for a scheduler-only invite', () => {
    const office = deriveOffice({
      attendees: [attendee({ state: 'scheduler', stafferId: null, address: 'scheduling@collins.senate.gov' })],
      inviteDomainOffice: collins,
      committee: null,
      room: null,
      previous: null,
    });
    expect(office.memberId).toBe('member-2');
    expect(office.derivedFrom).toBe('invite_domain');
    expect(office.room).toBe('Dirksen 555');
  });

  it('offers both offices for an unaccepted stale association and picks neither staffer vote', () => {
    const office = deriveOffice({
      attendees: [attendee({ state: 'stale', directoryOffice: wicker, inviteOffice: collins })],
      inviteDomainOffice: null,
      committee: null,
      room: null,
      previous: null,
    });
    expect(office.memberId).toBe('member-2');
    expect(office.alternatives.map((a) => a.memberId)).toEqual(['member-1']);
  });

  it('resolves committee-only staff to a committee office with no member', () => {
    const office = deriveOffice({
      attendees: [attendee({ committee: { id: 'committee-9', name: 'Senate Committee on Armed Services' }, directoryOffice: null })],
      inviteDomainOffice: null,
      committee: { id: 'committee-9', name: 'Senate Committee on Armed Services' },
      room: 'Russell 228',
      previous: null,
    });
    expect(office.memberId).toBeNull();
    expect(office.derivedFrom).toBe('committee_staff_association');
    expect(office.committees).toEqual(['Armed Services']);
    expect(office.room).toBe('Russell 228');
  });

  it('rolls up to partial for scheduler-only invites and to clean when everything resolves', () => {
    const scheduler = rollUpMeeting(
      [attendee({ state: 'scheduler', stafferId: null })],
      { ...emptyOffice(), ...collins, room: null, derivedFrom: 'invite_domain', correctedBy: null, alternatives: [] },
    );
    expect(scheduler).toEqual({ state: 'partial', needsConfirmation: true });
    const clean = rollUpMeeting([attendee({ directoryOffice: wicker })], {
      ...wicker,
      room: null,
      derivedFrom: 'staffer_office_association',
      correctedBy: null,
      alternatives: [],
    });
    expect(clean).toEqual({ state: 'clean', needsConfirmation: false });
    const noOffice = rollUpMeeting([attendee({ directoryOffice: wicker })], { ...emptyOffice() });
    expect(noOffice.state).toBe('partial');
  });
});
