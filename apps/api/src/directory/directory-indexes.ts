/**
 * Complete person + committee indexes built at snapshot-cache construction time.
 *
 * The cached directory payload only retains the transformed contacts/staffers/
 * committees; it drops the raw LegiStorm rows and keeps only committee LEADERSHIP.
 * These indexes preserve the full source rows (by stable ID) and every ordinary
 * committee membership, plus reverse person->committee and normalized-name lookups,
 * so the detail/dictionary endpoints (Task 12) can resolve any member/staff/committee
 * by ID and invert a person name to their committees.
 *
 * Identity joins are EXACT (by office_id / member.member_id / staff.id) — never by
 * name similarity. Names are normalized only for user query matching.
 */
import type { DirectoryCommittee } from './directory.service.js';

export type DirectoryPersonType = 'member' | 'staff';

export interface DirectoryPersonRef {
  personType: DirectoryPersonType;
  id: string; // member-{member_id} | staff-{staff.id}
  sourceId: number;
  fullName: string;
  title: string;
  photoUrl: string | null;
  photoSource: 'legistorm' | 'capiro_overlay' | null;
  party: string | null;
  state: string | null;
  district: string | null;
  isCurrent: boolean;
}

export interface DirectoryCommitteeMembership {
  committeeId: string; // committee-{office_id}
  person: DirectoryPersonRef;
  membershipType: DirectoryPersonType;
  position: string | null; // Chair, Ranking Member, Member, Staff Director…
  party: string | null;
  rank: number | null;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  sourceUpdatedAt: string | null;
}

/** A raw vendor row kept verbatim for the detail endpoints. */
export type SourceRow = Record<string, unknown>;

/** A staffer's issue area, reverse-indexed from the owning member's staffer_issues. */
export interface DirectoryStaffIssueLink {
  issueName: string | null;
  memberId: number | null;
  updatedAt: string | null;
}

/** A staffer's functional role, reverse-indexed from the owning member's staffer_roles. */
export interface DirectoryStaffRoleLink {
  roleName: string | null;
  memberId: number | null;
  updatedAt: string | null;
}

export interface DirectoryIndexes {
  membersById: Map<number, SourceRow>;
  membersByBioguideId: Map<string, SourceRow>;
  staffById: Map<number, SourceRow>;
  /** committee id -> every membership (members AND staff), not just leadership. */
  membershipsByCommitteeId: Map<string, DirectoryCommitteeMembership[]>;
  /** person id -> committee ids they are associated with (current or former). */
  committeesByPersonId: Map<string, string[]>;
  /** normalized person name -> person ids (member + staff). */
  normalizedPersonNameIndex: Map<string, string[]>;
  /** normalized committee name / code -> office_id (query matching only). */
  committeeAliases: Map<string, number>;
  /** staff.id -> issue areas, aggregated from every member's staffer_issues. */
  staffIssuesByStaffId: Map<number, DirectoryStaffIssueLink[]>;
  /** staff.id -> functional roles, aggregated from every member's staffer_roles. */
  staffRolesByStaffId: Map<number, DirectoryStaffRoleLink[]>;
  /**
   * staff.id -> display name, captured from the member-side staffer objects. Lets
   * the staff detail render a minimal profile for a staffer who appears via a
   * member's roster but has no /staff/list row (would otherwise 404).
   */
  staffNamesByStaffId: Map<number, string>;
}

export interface BuildDirectoryIndexesInput {
  members: unknown[];
  staff: unknown[];
  /** Already-identified federal committees (identity + code/name/parent). */
  committees: DirectoryCommittee[];
}

/** Lowercase, strip punctuation + common suffixes, collapse whitespace. */
export function normalizePersonName(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[.,'"()]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAlias(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function memberFullName(profile: SourceRow | undefined): string {
  return [
    profile?.preferred_first_name ?? profile?.first_name,
    profile?.preferred_last_name ?? profile?.last_name,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function staffFullName(staff: SourceRow | undefined): string {
  return [
    staff?.preferred_first_name ?? staff?.first_name,
    staff?.preferred_last_name ?? staff?.last_name,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function isRecord(value: unknown): value is SourceRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Select a member's CURRENT office from member_offices (stored oldest-first):
 * an in-office term, else the newest non-expired term, else the last (newest)
 * entry. Never the first array element — that is the OLDEST/former term, whose
 * party/state/district can differ from the member's current values after
 * redistricting, a chamber switch, or a party switch. Single source of truth for
 * every member-office selection (indexes, search results, contact builder).
 */
export function selectCurrentMemberOffice(rawOffices: unknown): SourceRow | null {
  const offices = (Array.isArray(rawOffices) ? rawOffices : []).filter(isRecord);
  return (
    offices.find((o) => String(o.status ?? '').toLowerCase() === 'in office') ??
    offices.find((o) => !o.end_date || String(o.end_date) >= '2026-01-01') ??
    offices[offices.length - 1] ??
    null
  );
}

function memberPhotoUrl(photos: unknown): string | null {
  if (!Array.isArray(photos)) return null;
  const pick =
    photos.find((p: SourceRow) => p?.status === 'public' && p?.is_directory)?.url ??
    photos.find((p: SourceRow) => p?.status === 'public' && p?.is_primary)?.url ??
    photos.find((p: SourceRow) => p?.status === 'public')?.url ??
    null;
  return typeof pick === 'string' && pick.trim() ? pick : null;
}

export function buildDirectoryIndexes(input: BuildDirectoryIndexesInput): DirectoryIndexes {
  const membersById = new Map<number, SourceRow>();
  const membersByBioguideId = new Map<string, SourceRow>();
  const staffById = new Map<number, SourceRow>();
  const membershipsByCommitteeId = new Map<string, DirectoryCommitteeMembership[]>();
  const committeesByPersonId = new Map<string, string[]>();
  const normalizedPersonNameIndex = new Map<string, string[]>();
  const committeeAliases = new Map<string, number>();
  const staffIssuesByStaffId = new Map<number, DirectoryStaffIssueLink[]>();
  const staffRolesByStaffId = new Map<number, DirectoryStaffRoleLink[]>();
  const staffNamesByStaffId = new Map<number, string>();
  const captureStaffName = (staffId: number, staffer: SourceRow | undefined): void => {
    if (staffNamesByStaffId.has(staffId) || !isRecord(staffer)) return;
    const nm = [
      staffer.preferred_first_name ?? staffer.first_name,
      staffer.preferred_last_name ?? staffer.last_name,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (nm) staffNamesByStaffId.set(staffId, nm);
  };

  // Valid federal committees only (identity + display from the built list).
  const committeeByOfficeId = new Map<number, DirectoryCommittee>();
  for (const committee of input.committees) {
    committeeByOfficeId.set(committee.officeId, committee);
    const nameAlias = normalizeAlias(committee.name);
    if (nameAlias) committeeAliases.set(nameAlias, committee.officeId);
    if (committee.committeeCode) {
      committeeAliases.set(normalizeAlias(committee.committeeCode), committee.officeId);
    }
    membershipsByCommitteeId.set(committee.id, []);
  }

  const addNameIndex = (name: string, personId: string): void => {
    const key = normalizePersonName(name);
    if (!key) return;
    const ids = normalizedPersonNameIndex.get(key) ?? [];
    if (!ids.includes(personId)) ids.push(personId);
    normalizedPersonNameIndex.set(key, ids);
  };

  const addPersonCommittee = (personId: string, committeeId: string): void => {
    const ids = committeesByPersonId.get(personId) ?? [];
    if (!ids.includes(committeeId)) ids.push(committeeId);
    committeesByPersonId.set(personId, ids);
  };

  // Dedupe memberships by (committeeId, personId, source membership id) — never name.
  const seenMembership = new Set<string>();
  const addMembership = (membership: DirectoryCommitteeMembership, sourceMembershipId: unknown): void => {
    const dedupeKey = `${membership.committeeId}|${membership.person.id}|${String(sourceMembershipId ?? '')}`;
    if (seenMembership.has(dedupeKey)) return;
    seenMembership.add(dedupeKey);
    membershipsByCommitteeId.get(membership.committeeId)!.push(membership);
    addPersonCommittee(membership.person.id, membership.committeeId);
  };

  // ---- Members: index rows + member committee memberships ----
  for (const row of input.members) {
    if (!isRecord(row)) continue;
    const member = isRecord(row.member) ? row.member : undefined;
    const memberId = Number(member?.member_id);
    if (!Number.isFinite(memberId)) continue;
    membersById.set(memberId, row);
    const bioguideId = typeof member?.bioguide_id === 'string' ? member.bioguide_id : '';
    if (bioguideId) membersByBioguideId.set(bioguideId, row);

    // Reverse-index this member's staffer issue/role links by staff.id, so the
    // staff detail can aggregate a staffer's issues/roles across EVERY member they
    // serve (LegiStorm attaches these on the member, not the staffer, record).
    for (const entry of Array.isArray(row.staffer_issues) ? row.staffer_issues : []) {
      if (!isRecord(entry)) continue;
      const staffId = Number((entry.staffer as SourceRow)?.id);
      if (!Number.isFinite(staffId)) continue;
      captureStaffName(staffId, entry.staffer as SourceRow);
      // Skip name-less rows (mirrors buildMemberStaff) so blank issues never
      // enter the index and inflate the staffer's Issue-areas count.
      const issueName = typeof entry.issue_name === 'string' ? entry.issue_name.trim() : '';
      if (!issueName) continue;
      const list = staffIssuesByStaffId.get(staffId) ?? [];
      list.push({
        issueName,
        memberId,
        updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : null,
      });
      staffIssuesByStaffId.set(staffId, list);
    }
    for (const entry of Array.isArray(row.staffer_roles) ? row.staffer_roles : []) {
      if (!isRecord(entry)) continue;
      const staffId = Number((entry.staffer as SourceRow)?.id);
      if (!Number.isFinite(staffId)) continue;
      captureStaffName(staffId, entry.staffer as SourceRow);
      const roleName = typeof entry.role_name === 'string' ? entry.role_name.trim() : '';
      if (!roleName) continue;
      const list = staffRolesByStaffId.get(staffId) ?? [];
      list.push({
        roleName,
        memberId,
        updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : null,
      });
      staffRolesByStaffId.set(staffId, list);
    }

    const profile = isRecord(member?.profile) ? member!.profile : undefined;
    const fullName = memberFullName(profile);
    const personId = `member-${memberId}`;
    if (fullName) addNameIndex(fullName, personId);

    const office = selectCurrentMemberOffice(row.member_offices);
    const ref: DirectoryPersonRef = {
      personType: 'member',
      id: personId,
      sourceId: memberId,
      fullName,
      title: '',
      photoUrl: memberPhotoUrl(row.photos),
      photoSource: memberPhotoUrl(row.photos) ? 'legistorm' : null,
      party: typeof office?.party === 'string' ? office.party : null,
      state: typeof office?.state_id === 'string' ? office.state_id : null,
      district:
        office?.district_no === undefined || office?.district_no === null
          ? null
          : String(office.district_no),
      isCurrent: true,
    };

    const committees = Array.isArray(row.committees) ? row.committees : [];
    for (const committee of committees) {
      if (!isRecord(committee)) continue;
      const officeId = Number((committee.committee_office as SourceRow)?.office_id);
      if (!committeeByOfficeId.has(officeId)) continue;
      const detail = committeeByOfficeId.get(officeId)!;
      addMembership(
        {
          committeeId: detail.id,
          person: { ...ref, title: String(committee.position ?? 'Member') },
          membershipType: 'member',
          position: committee.position ? String(committee.position) : 'Member',
          party: typeof committee.party_id === 'string' ? committee.party_id : ref.party,
          rank: Number.isFinite(Number(committee.rank)) ? Number(committee.rank) : null,
          status: committee.status === undefined ? null : (committee.status as string | null),
          startedAt: typeof committee.start_date === 'string' ? committee.start_date : null,
          endedAt: typeof committee.end_date === 'string' ? committee.end_date : null,
          sourceUpdatedAt: typeof committee.updated_at === 'string' ? committee.updated_at : null,
        },
        committee.id,
      );
    }
  }

  // ---- Staff: index rows + staff committee positions ----
  for (const row of input.staff) {
    if (!isRecord(row)) continue;
    const staff = isRecord(row.staff) ? row.staff : undefined;
    const staffId = Number(staff?.id);
    if (!Number.isFinite(staffId)) continue;
    staffById.set(staffId, row);

    const fullName = staffFullName(staff);
    const personId = `staff-${staffId}`;
    if (fullName) addNameIndex(fullName, personId);

    const positions = Array.isArray(row.positions) ? row.positions : [];
    for (const position of positions) {
      if (!isRecord(position)) continue;
      const officeId = Number((position.office as SourceRow)?.office_id);
      if (!committeeByOfficeId.has(officeId)) continue; // committee positions only
      const detail = committeeByOfficeId.get(officeId)!;
      const isCurrent = position.is_current === true;
      const title = String(position.position_title ?? position.position_type ?? 'Staff');
      addMembership(
        {
          committeeId: detail.id,
          person: {
            personType: 'staff',
            id: personId,
            sourceId: staffId,
            fullName,
            title,
            photoUrl: null, // staff photos are nullable; never member-substituted
            photoSource: null,
            party: null,
            state: null,
            district: null,
            isCurrent,
          },
          membershipType: 'staff',
          position: title,
          party: null,
          rank: null,
          status: isCurrent ? 'current' : 'former',
          startedAt: typeof position.start_date === 'string' ? position.start_date : null,
          endedAt: typeof position.end_date === 'string' ? position.end_date : null,
          sourceUpdatedAt: typeof position.updated_at === 'string' ? position.updated_at : null,
        },
        position.id,
      );
    }
  }

  // Deterministic membership ordering: current first, then by rank, then name.
  for (const roster of membershipsByCommitteeId.values()) {
    roster.sort((a, b) => {
      if (a.person.isCurrent !== b.person.isCurrent) return a.person.isCurrent ? -1 : 1;
      if (a.membershipType !== b.membershipType) return a.membershipType === 'member' ? -1 : 1;
      const rankA = a.rank ?? Number.MAX_SAFE_INTEGER;
      const rankB = b.rank ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return a.person.fullName.localeCompare(b.person.fullName);
    });
  }

  return {
    membersById,
    membersByBioguideId,
    staffById,
    membershipsByCommitteeId,
    committeesByPersonId,
    normalizedPersonNameIndex,
    committeeAliases,
    staffIssuesByStaffId,
    staffRolesByStaffId,
    staffNamesByStaffId,
  };
}
