import { createHash } from 'node:crypto';
import type { BridgeMemberContext } from './directory-bridge.client.js';
import type {
  AttendeeState,
  OfficeDerivation,
  OfficeRef,
  ResolvedAttendee,
  ResolvedOffice,
} from './hillday.types.js';

/**
 * Pure rules for the resolution chain (requirements §4):
 *   attendee address → Directory staffer → office → member.
 * Members are almost never on the invite; the member is DERIVED from the
 * staffer's office association, never guessed from the event title. Everything
 * here is deterministic and unit-tested; the service only orchestrates I/O.
 */

export function normalizeAddress(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toLowerCase();
  if (!trimmed || !trimmed.includes('@')) return null;
  return trimmed;
}

export function attendeeIdFor(address: string): string {
  return `att_${createHash('sha1').update(address.toLowerCase()).digest('hex').slice(0, 10)}`;
}

const SCHEDULER_LOCAL_RE =
  /(schedul|calendar|appointment|frontdesk|front_desk|front-desk|reception|invitation|rsvp|meetings?@|^office@|^info@)/i;

/** A scheduling-only address: no substantive attendee is known from it. */
export function isSchedulerAddress(address: string): boolean {
  const local = address.split('@')[0] ?? '';
  return SCHEDULER_LOCAL_RE.test(`${local}@`) || /schedul/i.test(local);
}

/** `x` from `someone@x.senate.gov` — a personal-office domain candidate. */
export function senateSubdomain(address: string): string | null {
  const m = /^[^@]+@([a-z0-9-]+)\.senate\.gov$/i.exec(address);
  if (!m) return null;
  const sub = m[1]!.toLowerCase();
  // Institutional subdomains that are never a senator's personal office.
  if (['mail', 'ssa', 'saa', 'sec', 'legis', 'senate', 'www', 'exchange'].includes(sub)) return null;
  return sub;
}

export function isHouseMailDomain(address: string): boolean {
  return /@mail\.house\.gov$/i.test(address);
}

export const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico', GU: 'Guam',
  VI: 'U.S. Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands',
};

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function parseDistrict(district: string | null): { state: string; number: number } | null {
  const m = /^([A-Za-z]{2})-(\d{1,2})$/.exec((district ?? '').trim());
  if (!m) return null;
  return { state: m[1]!.toUpperCase(), number: Number(m[2]) };
}

/** `Sen. Roger Wicker (R-MS)` / `Rep. Rob Wittman (R-VA-01)`. */
export function memberLabel(ctx: Pick<BridgeMemberContext, 'fullName' | 'party' | 'state' | 'district' | 'chamber'>): string {
  const party = (ctx.party || '').trim();
  const d = parseDistrict(ctx.district);
  const tail =
    ctx.chamber === 'House' && d
      ? `${d.state}-${String(d.number).padStart(2, '0')}`
      : (ctx.state || '').toUpperCase();
  const paren = [party, tail].filter(Boolean).join('-');
  return paren ? `${ctx.fullName} (${paren})` : ctx.fullName;
}

/** `Republican · Mississippi` / `Republican · Virginia 1st`. */
export function partyLine(office: Pick<OfficeRef, 'partyName' | 'party' | 'state' | 'district' | 'chamber'>): string {
  const party = office.partyName || office.party || '';
  const stateName = STATE_NAMES[(office.state || '').toUpperCase()] ?? office.state ?? '';
  const d = parseDistrict(office.district);
  const place = office.chamber === 'House' && d ? `${stateName} ${ordinal(d.number)}` : stateName;
  return [party, place].filter(Boolean).join(' · ');
}

/**
 * `Senate Committee on Armed Services` / `Armed Services Committee` → `Armed Services`.
 * LegiStorm names subcommittees as `<Parent> Committee <Name> Subcommittee`.
 */
export function shortCommittee(name: string): string {
  return name
    .replace(/^(senate|house|joint)\s+/i, '')
    .replace(/^(select\s+|permanent\s+select\s+|special\s+)?committee\s+on\s+(the\s+)?/i, '')
    .replace(/^subcommittee\s+on\s+(the\s+)?/i, '')
    .replace(/\s+committee$/i, '')
    .trim();
}

/** Full committees only — a member's subcommittee seats are not office facts. */
export function isSubcommittee(name: string): boolean {
  return /subcommittee/i.test(name);
}

/** Leadership roles worth printing next to a committee; plain and ex officio seats are not. */
function printableRole(role: string | null | undefined): string | null {
  const trimmed = (role ?? '').trim();
  if (!trimmed || /^member$/i.test(trimmed) || /ex\s*officio/i.test(trimmed)) return null;
  return trimmed;
}

function committeeLabels(ctx: BridgeMemberContext): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (label: string) => {
    const key = label.toLowerCase();
    if (!label || seen.has(key)) return;
    seen.add(key);
    out.push(label);
  };
  if (ctx.committeesWithRole?.length) {
    const full = ctx.committeesWithRole.filter((c) => !isSubcommittee(c.name));
    // Leadership first, then the rest in Directory order — the prototype's
    // `Armed Services (Chair) · Commerce, Science and Transportation · Rules`.
    const ranked = [...full].sort((a, b) => Number(Boolean(printableRole(b.role))) - Number(Boolean(printableRole(a.role))));
    for (const c of ranked) {
      const role = printableRole(c.role);
      push(role ? `${shortCommittee(c.name)} (${role})` : shortCommittee(c.name));
    }
    if (out.length) return out;
  }
  // Fallback: plain committee names plus leadership strings ("Chair — X").
  const leadership = new Map<string, string>();
  for (const entry of ctx.committeeLeadership ?? []) {
    const m = /^(.+?)\s+[—–-]+\s+(.+)$/.exec(entry);
    if (m) leadership.set(shortCommittee(m[2]!).toLowerCase(), m[1]!.trim());
  }
  for (const name of ctx.committees ?? []) {
    const short = shortCommittee(name);
    const role = leadership.get(short.toLowerCase());
    push(role ? `${short} (${role})` : short);
  }
  return out;
}

export function officeRefFromContext(ctx: BridgeMemberContext): OfficeRef {
  const focusAreas = (ctx.topIssues?.length
    ? [...ctx.topIssues]
        .sort((a, b) => b.stafferCount - a.stafferCount)
        .map((t) => ({ label: t.issue, salience: t.stafferCount }))
    : (ctx.focusAreas ?? []).map((label, i) => ({ label, salience: Math.max(0, 100 - i) }))
  ).filter((f) => f.label);
  return {
    memberId: ctx.id,
    member: memberLabel(ctx),
    memberName: ctx.memberName || ctx.fullName,
    chamber: ctx.chamber || null,
    party: ctx.party || null,
    partyName: ctx.partyName || null,
    state: ctx.state || null,
    district: ctx.district || null,
    committees: committeeLabels(ctx),
    focusAreas,
    bio: (ctx.bioNarrative ?? '').trim() || null,
    officeLocation: (ctx.officeLocation ?? '').trim() || null,
  };
}

export function emptyOffice(): ResolvedOffice {
  return {
    memberId: null,
    member: null,
    memberName: null,
    chamber: null,
    party: null,
    partyName: null,
    state: null,
    district: null,
    committees: [],
    focusAreas: [],
    bio: null,
    officeLocation: null,
    room: null,
    derivedFrom: null,
    correctedBy: null,
    alternatives: [],
  };
}

export function sameOffice(a: OfficeRef | null, b: OfficeRef | null): boolean {
  if (!a || !b) return false;
  if (a.memberId && b.memberId) return a.memberId === b.memberId;
  return (a.member ?? '').toLowerCase() === (b.member ?? '').toLowerCase();
}

/** Last-name match: `wicker` ↔ `Sen. Roger Wicker`. */
export function lastNameMatches(subdomain: string, memberName: string): boolean {
  const parts = memberName
    .replace(/[^A-Za-z\s'-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const last = (parts[parts.length - 1] ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return Boolean(last) && last === subdomain.toLowerCase().replace(/[^a-z]/g, '');
}

export interface OfficeDerivationInput {
  attendees: ResolvedAttendee[];
  /** Office implied by a scheduler-only or unresolved address domain. */
  inviteDomainOffice: OfficeRef | null;
  committee: { id: string; name: string } | null;
  room: string | null;
  /** Previous office — a user correction is authoritative and is kept. */
  previous: ResolvedOffice | null;
}

/** Prior offices that are authoritative and must survive a re-derivation
 *  untouched: an explicit "change office" correction, and a member picked
 *  directly from the Directory (step 3's Directory tab — there is no invite
 *  to derive an office FROM, so the pick itself is the whole signal). Without
 *  this, `resolveDocument()`'s next run — which fires automatically right
 *  after a manual meeting is added — would fall through every other branch
 *  (0 attendees means no votes, no invite domain, no committee) and land on
 *  `emptyOffice()`, silently wiping the office the user just chose. */
const AUTHORITATIVE_DERIVATIONS: readonly OfficeDerivation[] = ['user_correction', 'manual_selection'];

/**
 * Derive the meeting's office. Order of authority:
 *   1. an authoritative prior office — a user correction or a Directory pick
 *      (kept verbatim, room refreshed);
 *   2. a member who is on the invite themself;
 *   3. majority of the resolved staffers' office associations
 *      (an accepted stale association votes for the office the user chose);
 *   4. the office the invite domain implies (scheduler-only invites);
 *   5. the committee the staff belong to (member unknown — partial);
 *   6. nothing — the meeting is partial until corrected.
 */
export function deriveOffice(input: OfficeDerivationInput): ResolvedOffice {
  const { attendees, previous } = input;
  if (previous?.derivedFrom && AUTHORITATIVE_DERIVATIONS.includes(previous.derivedFrom)) {
    return { ...previous, room: input.room ?? previous.room };
  }
  const finish = (ref: OfficeRef, derivedFrom: OfficeDerivation, alternatives: OfficeRef[]): ResolvedOffice => ({
    ...ref,
    room: input.room ?? ref.officeLocation ?? null,
    derivedFrom,
    correctedBy: null,
    alternatives: alternatives.filter((alt) => !sameOffice(alt, ref)),
  });

  const memberOnInvite = attendees.find(
    (a) => a.state === 'resolved' && a.role === 'Member of Congress' && a.directoryOffice?.memberId,
  );
  if (memberOnInvite?.directoryOffice) {
    return finish(memberOnInvite.directoryOffice, 'member_on_invite', []);
  }

  const votes = new Map<string, { ref: OfficeRef; count: number; order: number }>();
  attendees.forEach((a, order) => {
    if (a.state !== 'resolved' || a.committee || !a.directoryOffice?.memberId) return;
    const key = a.directoryOffice.memberId;
    const entry = votes.get(key);
    if (entry) entry.count += 1;
    else votes.set(key, { ref: a.directoryOffice, count: 1, order });
  });
  if (votes.size) {
    const ranked = [...votes.values()].sort((a, b) => b.count - a.count || a.order - b.order);
    const winner = ranked[0]!;
    return finish(
      winner.ref,
      'staffer_office_association',
      ranked.slice(1).map((r) => r.ref),
    );
  }

  // Stale associations that have not been accepted yet: offer both, pick none.
  const stale = attendees.find((a) => a.state === 'stale');
  if (stale && (stale.inviteOffice || stale.directoryOffice)) {
    const base = stale.inviteOffice ?? stale.directoryOffice!;
    const alt = stale.inviteOffice ? stale.directoryOffice : null;
    const office = finish(base, 'invite_domain', alt ? [alt] : []);
    return office;
  }

  if (input.inviteDomainOffice) {
    return finish(input.inviteDomainOffice, 'invite_domain', []);
  }

  if (input.committee) {
    return {
      ...emptyOffice(),
      member: `${input.committee.name} (committee staff)`,
      memberName: input.committee.name,
      committees: [shortCommittee(input.committee.name)],
      room: input.room,
      derivedFrom: 'committee_staff_association',
    };
  }

  return { ...emptyOffice(), room: input.room };
}

/**
 * Why a meeting needs confirmation before delivery — a manually-added
 * meeting has no invite at all to read attendees from, distinct from a real
 * invite that only carried a scheduling address. `rollUpMeeting` sets
 * `needsConfirmation` for both (zero substantive attendees either way); this
 * tells the two apart so the surfaced text doesn't claim an invite exists
 * when one doesn't.
 */
export function confirmationReason(resolution: {
  attendees: ReadonlyArray<{ state: AttendeeState }>;
}): 'no_invite' | 'scheduler_only' {
  return resolution.attendees.length === 0 ? 'no_invite' : 'scheduler_only';
}

export function rollUpMeeting(attendees: ResolvedAttendee[], office: ResolvedOffice): {
  state: 'clean' | 'partial';
  needsConfirmation: boolean;
} {
  const substantive = attendees.filter((a) => a.state !== 'scheduler');
  const needsConfirmation = substantive.length === 0;
  const allResolved = attendees.every((a) => a.state === 'resolved');
  const officeKnown = Boolean(office.memberId);
  return {
    state: allResolved && officeKnown && !needsConfirmation ? 'clean' : 'partial',
    needsConfirmation,
  };
}

export function stateDetail(
  state: AttendeeState,
  extras: { name?: string | null; directoryMember?: string | null; inviteMember?: string | null } = {},
): string {
  switch (state) {
    case 'resolved':
      return 'Matches a Directory staffer whose office association is current.';
    case 'unresolved':
      return 'No Directory record for this address. Defense fellows and detailees are routinely absent.';
    case 'scheduler':
      return 'Scheduling address only. No substantive attendees on the invite yet.';
    case 'stale':
      return `Directory places ${extras.name ?? 'this staffer'} in ${
        extras.directoryMember ?? 'another'
      } office. The invite is from ${
        extras.inviteMember ? `${extras.inviteMember}'s` : 'a different'
      } address — a recent office change is the likely cause.`;
    default:
      return '';
  }
}

export const CONFIRMED_DETAIL = 'Confirmed by you. Overrides the Directory record for this document.';
