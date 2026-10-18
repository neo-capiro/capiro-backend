import type { DirectoryContact } from './directory.types.js';
import type { DirectoryMemberDetail, DirectoryStaffDetail } from './directory-detail.types.js';
import { selectCurrentMemberOffice, type DirectoryCommitteeMembership, type DirectoryIndexes, type SourceRow } from './directory-indexes.js';
import { memberPhotoRecords, resolveMemberPhoto, resolveStaffPhoto, type DirectoryPhotoOverlay } from './directory-photo.js';

export interface DirectoryDetailSnapshot {
  sourceId: string;
  contacts: DirectoryContact[];
  indexes: DirectoryIndexes;
  photoOverlay: DirectoryPhotoOverlay;
}

export function projectMemberDetail(base: DirectoryDetailSnapshot, row: SourceRow): DirectoryMemberDetail {
  const member = (row.member ?? {}) as Record<string, any>;
  const numericId = Number(member.member_id);
  const profile = (member.profile ?? {}) as Record<string, any>;
  const bio = (profile.bio_details ?? {}) as Record<string, any>;
  const personId = `member-${numericId}`;
  const overlay = base.photoOverlay.people[personId] ?? null;
  const selected = resolveMemberPhoto(row.photos, overlay);
  const contact = base.contacts.find((c) => c.id === personId);
  return {
    kind: 'member',
    id: personId,
    source: {
      snapshotId: base.sourceId,
      memberId: numericId,
      lastUpdatedAt: latestUpdatedAt([row.member_offices, row.committees, row.leaderships]),
    },
    identity: {
      memberId: numericId,
      bioguideId: String(member.bioguide_id ?? ''),
      icpsrId: Number.isFinite(Number(member.icpsr_id)) ? Number(member.icpsr_id) : null,
      lisMemberId: member.lis_member_id == null ? null : String(member.lis_member_id),
      firstName: String(profile.first_name ?? ''),
      lastName: String(profile.last_name ?? ''),
      preferredFirstName: profile.preferred_first_name ?? null,
      preferredLastName: profile.preferred_last_name ?? null,
      suffix: profile.suffix ?? null,
      gender: profile.gender ?? null,
    },
    bioDetails: {
      dob: bio.dob ?? null,
      dateOfDeath: bio.date_of_death ?? null,
      placeOfBirth: bio.pob ?? null,
      hometown: bio.hometown ?? null,
      nativeOf: bio.native_of ?? null,
      majMin: bio.maj_min ?? null,
      partyName: bio.party_name ?? null,
      occupation: bio.occupation ?? null,
      pronunciation: bio.pronunciation ?? null,
      raceName: bio.race_name ?? null,
      religionName: bio.religion_name ?? null,
    },
    photos: memberPhotoRecords(row.photos),
    selectedPhotoUrl: selected.url,
    photoSource: selected.source,
    offices: mapMemberOffices(row.member_offices),
    officeAddresses: mapStaffOfficeAddresses(row.office_member_addresses),
    committees: membershipsForPerson(base.indexes, personId),
    leaderships: mapLeaderships(row.leaderships),
    socialContacts: mapContactMethods(row.social_media),
    staffRoles: mapStaffRoles(row.staffer_roles),
    staffIssues: mapStaffIssues(row.staffer_issues),
    enrichments: {
      bioOverlay: Boolean(contact?.bio?.narrative),
      pressOverlay: Boolean(contact?.rssFeedUrl || contact?.newsPressUrl),
    },
  };
}

export function projectStaffDetail(base: DirectoryDetailSnapshot, row: SourceRow, numericId: number): DirectoryStaffDetail {
  const staff = (row.staff ?? {}) as Record<string, any>;
  const bio = (staff.bio_details ?? {}) as Record<string, any>;
  const personId = `staff-${numericId}`;
  const overlay = base.photoOverlay.people[personId] ?? null;
  const photo = resolveStaffPhoto(null, overlay); // entitlement returns no staff photo today
  const positions = Array.isArray(row.positions) ? row.positions : [];
  const memberAssociations = [
    ...new Map(
      positions
        .map((p: any) => Number(p?.member?.member_id))
        .filter((id: number) => Number.isFinite(id))
        .map((id: number) => {
          const ref = resolveMemberRef(base.indexes, id);
          return [
            id,
            {
              id: `member-${id}`,
              memberId: id,
              fullName: ref.fullName,
              party: ref.party,
              state: ref.state,
              district: ref.district,
            },
          ];
        }),
    ).values(),
  ];
  const issues = (base.indexes.staffIssuesByStaffId.get(numericId) ?? []).map((link) => ({
    issueName: link.issueName,
    memberId: link.memberId,
    memberName:
      link.memberId != null ? resolveMemberRef(base.indexes, link.memberId).fullName || null : null,
    updatedAt: link.updatedAt,
  }));
  const roles = (base.indexes.staffRolesByStaffId.get(numericId) ?? []).map((link) => ({
    roleName: link.roleName,
    memberId: link.memberId,
    memberName:
      link.memberId != null ? resolveMemberRef(base.indexes, link.memberId).fullName || null : null,
    updatedAt: link.updatedAt,
  }));
  return {
    kind: 'staff',
    id: personId,
    source: {
      snapshotId: base.sourceId,
      staffId: numericId,
      lastUpdatedAt: latestUpdatedAt([row.positions]),
    },
    identity: {
      staffId: numericId,
      firstName: String(staff.first_name ?? ''),
      lastName: String(staff.last_name ?? ''),
      preferredFirstName: staff.preferred_first_name ?? null,
      preferredLastName: staff.preferred_last_name ?? null,
      suffix: staff.suffix ?? null,
      gender: staff.gender ?? null,
    },
    bioDetails: {
      dob: bio.dob ?? null,
      dateOfDeath: bio.date_of_death ?? null,
      hometown: bio.hometown ?? null,
      placeOfBirth: bio.pob ?? null,
      nativeOf: bio.native_of ?? null,
      majMin: bio.maj_min ?? null,
      partyName: bio.party_name ?? null,
      occupation: bio.occupation ?? null,
      pronunciation: bio.pronunciation ?? null,
      raceName: bio.race_name ?? null,
      religionName: bio.religion_name ?? null,
    },
    photoUrl: photo.url,
    photoSource: photo.source,
    emails: mapContactMethods(row.staff_emails),
    socialContacts: mapContactMethods(row.social_media),
    officeAddresses: mapStaffOfficeAddresses(row.office_member_addresses),
    positions: mapStaffPositions(row.positions),
    memberAssociations,
    committeeAssociations: membershipsForPerson(base.indexes, personId),
    issues,
    roles,
    availability: {
      photo: photo.url ? 'available' : 'not_provided',
      socialContacts: mapContactMethods(row.social_media).length ? 'available' : 'not_provided',
    },
  };
}

/**
 * Minimal staff detail for a staffer who appears via a member's roster but has no
 * /staff/list row (name + issues + roles + member associations; everything else
 * "not provided"). Prevents a 404 when such a staffer's profile is opened.
 */
export function projectRosterOnlyStaffDetail(base: DirectoryDetailSnapshot, numericId: number, name: string): DirectoryStaffDetail {
  const personId = `staff-${numericId}`;
  const parts = name.split(' ').filter(Boolean);
  const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : name;
  const lastName = parts.length > 1 ? parts[parts.length - 1]! : '';
  const overlay = base.photoOverlay.people[personId] ?? null;
  const photo = resolveStaffPhoto(null, overlay);
  const memberName = (memberId: number | null): string | null =>
    memberId != null ? resolveMemberRef(base.indexes, memberId).fullName || null : null;
  const issues = (base.indexes.staffIssuesByStaffId.get(numericId) ?? []).map((link) => ({
    issueName: link.issueName,
    memberId: link.memberId,
    memberName: memberName(link.memberId),
    updatedAt: link.updatedAt,
  }));
  const roles = (base.indexes.staffRolesByStaffId.get(numericId) ?? []).map((link) => ({
    roleName: link.roleName,
    memberId: link.memberId,
    memberName: memberName(link.memberId),
    updatedAt: link.updatedAt,
  }));
  const memberIds = [
    ...new Set(
      [...issues, ...roles]
        .map((x) => x.memberId)
        .filter((id): id is number => id != null),
    ),
  ];
  const memberAssociations = memberIds.map((id) => {
    const ref = resolveMemberRef(base.indexes, id);
    return {
      id: `member-${id}`,
      memberId: id,
      fullName: ref.fullName,
      party: ref.party,
      state: ref.state,
      district: ref.district,
    };
  });
  return {
    kind: 'staff',
    id: personId,
    source: { snapshotId: base.sourceId, staffId: numericId, lastUpdatedAt: null },
    identity: {
      staffId: numericId,
      firstName,
      lastName,
      preferredFirstName: null,
      preferredLastName: null,
      suffix: null,
      gender: null,
    },
    bioDetails: {
      dob: null,
      dateOfDeath: null,
      hometown: null,
      placeOfBirth: null,
      nativeOf: null,
      majMin: null,
      partyName: null,
      occupation: null,
      pronunciation: null,
      raceName: null,
      religionName: null,
    },
    photoUrl: photo.url,
    photoSource: photo.source,
    emails: [],
    socialContacts: [],
    officeAddresses: [],
    positions: [],
    memberAssociations,
    committeeAssociations: membershipsForPerson(base.indexes, personId),
    issues,
    roles,
    availability: {
      photo: photo.url ? 'available' : 'not_provided',
      socialContacts: 'not_provided',
    },
  };
}

export function membershipsForPerson(idx: DirectoryIndexes, personId: string): DirectoryCommitteeMembership[] {
  const committeeIds = idx.committeesByPersonId.get(personId) ?? [];
  return committeeIds.flatMap((cid) =>
    (idx.membershipsByCommitteeId.get(cid) ?? []).filter((m) => m.person.id === personId),
  );
}

function mapMemberOffices(raw: unknown): DirectoryMemberDetail['offices'] {
  return (Array.isArray(raw) ? raw : []).filter((o) => o && typeof o === 'object').map((o: any) => ({
    officeId: Number.isFinite(Number(o.office?.office_id)) ? Number(o.office.office_id) : null,
    name: o.office?.name ?? null,
    officeTypeId: o.office_type_id ?? null,
    state: o.state_id ?? null,
    district: o.district_no == null ? null : String(o.district_no),
    party: o.party ?? null,
    senateClass: o.senate_class == null ? null : String(o.senate_class),
    outgoingStatus: o.outgoing_status ?? null,
    status: o.status ?? null,
    startDate: o.start_date ?? null,
    endDate: o.end_date ?? null,
    updatedAt: o.updated_at ?? null,
  }));
}

function mapLeaderships(raw: unknown): DirectoryMemberDetail['leaderships'] {
  return (Array.isArray(raw) ? raw : []).filter((l) => l && typeof l === 'object').map((l: any) => ({
    position: l.position ?? null,
    startDate: l.start_date ?? null,
    endDate: l.end_date ?? null,
    updatedAt: l.updated_at ?? null,
  }));
}

function mapContactMethods(raw: unknown): DirectoryMemberDetail['socialContacts'] {
  return (Array.isArray(raw) ? raw : [])
    .filter((c) => c && typeof c === 'object' && typeof (c as any).contact_string === 'string')
    .map((c: any) => ({
      type: c.contact_type ?? null,
      value: String(c.contact_string),
      updatedAt: c.updated_at ?? null,
    }));
}

function mapStaffRoles(raw: unknown): DirectoryMemberDetail['staffRoles'] {
  return (Array.isArray(raw) ? raw : []).filter((r) => r && typeof r === 'object').map((r: any) => ({
    memberId: Number.isFinite(Number(r.staffer?.member_id ?? r.member_id)) ? Number(r.staffer?.member_id ?? r.member_id) : null,
    roleName: r.role_name ?? null,
    updatedAt: r.updated_at ?? null,
  }));
}

function mapStaffIssues(raw: unknown): DirectoryMemberDetail['staffIssues'] {
  return (Array.isArray(raw) ? raw : []).filter((r) => r && typeof r === 'object').map((r: any) => ({
    memberId: Number.isFinite(Number(r.member_id)) ? Number(r.member_id) : null,
    issueName: r.issue_name ?? null,
    updatedAt: r.updated_at ?? null,
  }));
}

function mapStaffPositions(raw: unknown): DirectoryStaffDetail['positions'] {
  return (Array.isArray(raw) ? raw : []).filter((p) => p && typeof p === 'object').map((p: any) => {
    const m = p.member && typeof p.member === 'object' ? p.member : null;
    const profile = m?.profile && typeof m.profile === 'object' ? m.profile : null;
    const memberFullName = profile
      ? [profile.preferred_first_name ?? profile.first_name, profile.preferred_last_name ?? profile.last_name]
          .filter(Boolean)
          .join(' ')
          .trim()
      : '';
    return {
      officeId: Number.isFinite(Number(p.office?.office_id)) ? Number(p.office.office_id) : null,
      officeName: p.office?.name ?? null,
      memberId: Number.isFinite(Number(m?.member_id)) ? Number(m.member_id) : null,
      title: p.position_title ?? null,
      positionType: p.position_type ?? null,
      isCurrent: p.is_current === true,
      isOnLeave: p.is_on_leave === true,
      startDate: p.start_date ?? null,
      endDate: p.end_date ?? null,
      updatedAt: p.updated_at ?? null,
      member: m
        ? {
            memberId: Number.isFinite(Number(m.member_id)) ? Number(m.member_id) : null,
            fullName: memberFullName || null,
            party: typeof m.party === 'string' ? m.party : null,
            state: typeof m.state_id === 'string' ? m.state_id : null,
            district: m.district_no === undefined || m.district_no === null ? null : String(m.district_no),
            officeTypeId:
              m.office_type_id === undefined || m.office_type_id === null
                ? null
                : String(m.office_type_id),
          }
        : null,
    };
  });
}

function mapStaffOfficeAddresses(raw: unknown): DirectoryStaffDetail['officeAddresses'] {
  return (Array.isArray(raw) ? raw : [])
    .filter((a) => a && typeof a === 'object')
    .map((a: any) => ({
      addressId: Number.isFinite(Number(a.id)) ? Number(a.id) : null,
      officeId: Number.isFinite(Number(a.office?.office_id)) ? Number(a.office.office_id) : null,
      officeName: a.office?.name ?? null,
      label: a.title ?? null,
      address1: a.address1 ?? null,
      address2: a.address2 ?? null,
      city: a.city ?? null,
      state: a.state_id ?? null,
      zip: a.zip ?? null,
      zipExt: a.zip_ext ?? null,
      phone: a.phone ?? null,
      fax: a.fax ?? null,
      isMain: a.is_main === true,
      publicNotes: a.public_notes ?? null,
      updatedAt: a.updated_at ?? null,
    }));
}

/** Resolve a member's canonical display fields from the indexed member row. */
function resolveMemberRef(
  indexes: DirectoryIndexes,
  memberId: number,
): { fullName: string; party: string | null; state: string | null; district: string | null } {
  const row = indexes.membersById.get(memberId) as Record<string, any> | undefined;
  const member = (row?.member ?? {}) as Record<string, any>;
  const profile = (member.profile ?? {}) as Record<string, any>;
  const fullName = [
    profile.preferred_first_name ?? profile.first_name,
    profile.preferred_last_name ?? profile.last_name,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  // Use the authoritative current-office selector (in-office > open end_date >
  // last term), NOT the first array element: member_offices is stored
  // oldest-first, so .find(first) would surface a stale/former term's
  // party/state/district for any multi-term member.
  const office = selectCurrentMemberOffice(row?.member_offices);
  return {
    fullName,
    party: typeof office?.party === 'string' ? office.party : null,
    state: typeof office?.state_id === 'string' ? office.state_id : null,
    district:
      office?.district_no === undefined || office?.district_no === null
        ? null
        : String(office.district_no),
  };
}

function latestUpdatedAt(sources: unknown[]): string | null {
  let latest: string | null = null;
  for (const source of sources) {
    for (const entry of Array.isArray(source) ? source : []) {
      const updatedAt = (entry as any)?.updated_at;
      if (typeof updatedAt === 'string' && (latest === null || updatedAt > latest)) latest = updatedAt;
    }
  }
  return latest;
}
