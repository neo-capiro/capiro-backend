import type {
  CommitteeChamber,
  CommitteeKind,
  CommitteeMemberRef,
  DirectoryCommittee,
  DirectoryCommitteeStaffer,
} from './directory.types.js';

// Federal congressional committee offices in the LegiStorm office-list, keyed by
// their `office_type`. The snapshot is dominated by ~2,300 STATE-legislature
// committees; this whitelist keeps only the federal House/Senate/Joint committees
// and subcommittees (~234 offices) so committee staff don't get polluted with
// state offices.
const FED_COMMITTEE_OFFICE_TYPES: Record<
  string,
  { chamber: CommitteeChamber; kind: CommitteeKind }
> = {
  'House Committee': { chamber: 'House', kind: 'committee' },
  'Senate Committee': { chamber: 'Senate', kind: 'committee' },
  'Joint Committee': { chamber: 'Joint', kind: 'committee' },
  'House Subcommittee': { chamber: 'House', kind: 'subcommittee' },
  'Senate Subcommittee': { chamber: 'Senate', kind: 'subcommittee' },
};

/** A single office normalized from either the live-array or legacy-object shape. */
interface NormalizedOfficeRow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  office: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  office_member_addresses: any[];
}

// Builds the committee catalog (from office-list) and the per-committee staff
// roster (from staff-list `positions[].office`). A staffer can appear under
// multiple committees; within one committee we keep a single entry per person,
// preferring their current position and a titled role.
export function buildCommitteeIndex(officeRaw: unknown, staffRaw: unknown[], membersRaw: unknown[]) {
  // Normalize BOTH the live array shape ([{ office, office_member_addresses, ... }])
  // and the legacy object shape ({ office: [...], office_member_addresses: [...] }).
  // The live combined file is an array; the old code assumed the object shape and
  // silently produced an empty committee catalog against real data.
  const rows = normalizeOfficeRows(officeRaw);
  const offices = rows.map((row) => row.office);
  const committeesByOfficeId = new Map<number, DirectoryCommittee>();

  // Committee leadership (Chair / Ranking Member / Vice Chair) lives on the
  // MEMBER side as committees[].position; invert it into an officeId -> roles map.
  const leadershipByOffice = buildCommitteeLeadershipMap(membersRaw);

  // Committee office phone/address comes from each office's office_member_addresses.
  const contactByOffice = buildOfficeContactMap(rows);

  for (const office of offices as any[]) {
    const meta = FED_COMMITTEE_OFFICE_TYPES[String(office?.office_type ?? '')];
    const officeId = Number(office?.office_id);
    if (!meta || !Number.isFinite(officeId)) continue;
    const name = String(office?.name ?? '').trim();
    if (!name) continue;
    const leadership = leadershipByOffice.get(officeId);
    const contact = contactByOffice.get(officeId);
    committeesByOfficeId.set(officeId, {
      id: `committee-${officeId}`,
      officeId,
      name,
      chamber: meta.chamber,
      kind: meta.kind,
      committeeCode: office?.congress_committee_code
        ? String(office.congress_committee_code)
        : null,
      parentOfficeId: Number(office?.parent_office?.office_id) || null,
      staffCount: 0,
      chair: leadership?.chair ?? null,
      rankingMember: leadership?.rankingMember ?? null,
      viceChairs: leadership?.viceChairs ?? [],
      phone: contact?.phone ?? '',
      officeLocation: contact?.officeLocation ?? '',
    });
  }

  // committee id -> (staffId -> staffer), deduped per person per committee.
  const rosterById = new Map<string, Map<number, DirectoryCommitteeStaffer>>();
  const staffList = Array.isArray(staffRaw) ? staffRaw : [];

  for (const row of staffList as any[]) {
    const staff = row?.staff;
    const staffId = Number(staff?.id);
    if (!Number.isFinite(staffId)) continue;
    const fullName = [
      staff?.preferred_first_name ?? staff?.first_name,
      staff?.preferred_last_name ?? staff?.last_name,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!fullName) continue;

    const emails = Array.isArray(row?.staff_emails) ? row.staff_emails : [];
    const email = String(
      emails.find(
        (entry: any) =>
          typeof entry?.contact_string === 'string' && entry.contact_string.includes('@'),
      )?.contact_string ?? '',
    );
    const addresses = Array.isArray(row?.office_member_addresses)
      ? row.office_member_addresses
      : [];
    const address = addresses.find((entry: any) => entry?.is_main) ?? addresses[0];
    const phone = String(address?.phone ?? '');
    const officeLocation = [address?.address1, address?.city, address?.state_id]
      .filter(Boolean)
      .join(', ');

    const positions = Array.isArray(row?.positions) ? row.positions : [];
    for (const position of positions) {
      const officeId = Number(position?.office?.office_id);
      const committee = committeesByOfficeId.get(officeId);
      if (!committee) continue;

      const byStaffId =
        rosterById.get(committee.id) ?? new Map<number, DirectoryCommitteeStaffer>();
      const isCurrent = Boolean(position?.is_current);
      const title = String(position?.position_title ?? position?.position_type ?? 'Staff');
      const existing = byStaffId.get(staffId);
      // Prefer a current position; otherwise keep the first seen.
      if (!existing || (isCurrent && !existing.isCurrent)) {
        byStaffId.set(staffId, {
          id: `staff-${staffId}`,
          fullName,
          title,
          email,
          phone,
          officeLocation,
          isCurrent,
          committee: {
            id: committee.id,
            name: committee.name,
            chamber: committee.chamber,
            kind: committee.kind,
          },
        });
      }
      rosterById.set(committee.id, byStaffId);
    }
  }

  const committeeStaff = new Map<string, DirectoryCommitteeStaffer[]>();
  for (const committee of committeesByOfficeId.values()) {
    const roster = [...(rosterById.get(committee.id)?.values() ?? [])].sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
      return left.fullName.localeCompare(right.fullName);
    });
    committee.staffCount = roster.filter((staffer) => staffer.isCurrent).length;
    committeeStaff.set(committee.id, roster);
  }

  const committees = [...committeesByOfficeId.values()].sort((left, right) => {
    if (right.staffCount !== left.staffCount) return right.staffCount - left.staffCount;
    return left.name.localeCompare(right.name);
  });

  return { committees, committeeStaff };
}

// officeId -> { chair, rankingMember, viceChairs[] } from members' committees[].position.
function buildCommitteeLeadershipMap(
  membersRaw: unknown[],
): Map<
  number,
  { chair?: CommitteeMemberRef; rankingMember?: CommitteeMemberRef; viceChairs: string[] }
> {
  const map = new Map<
    number,
    { chair?: CommitteeMemberRef; rankingMember?: CommitteeMemberRef; viceChairs: string[] }
  >();
  const members = Array.isArray(membersRaw) ? membersRaw : [];
  for (const row of members as any[]) {
    const memberId = Number(row?.member?.member_id);
    if (!Number.isFinite(memberId)) continue;
    const profile = row?.member?.profile;
    const name = [
      profile?.preferred_first_name ?? profile?.first_name,
      profile?.preferred_last_name ?? profile?.last_name,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!name) continue;
    const ref: CommitteeMemberRef = { id: `member-${memberId}`, name };
    const committees = Array.isArray(row?.committees) ? row.committees : [];
    for (const committee of committees) {
      const officeId = Number(committee?.committee_office?.office_id);
      const position = String(committee?.position ?? '').trim();
      if (!Number.isFinite(officeId) || !position) continue;
      const entry = map.get(officeId) ?? { viceChairs: [] };
      if (position === 'Chair' && !entry.chair) entry.chair = ref;
      else if (position === 'Ranking Member' && !entry.rankingMember) entry.rankingMember = ref;
      else if (position === 'Vice Chair') entry.viceChairs.push(name);
      map.set(officeId, entry);
    }
  }
  return map;
}

/**
 * Normalize the office combined file into `{ office, office_member_addresses }`
 * rows, tolerating BOTH shapes:
 *   - LIVE array: [{ office: {...}, office_member_addresses: [...], ... }, ...]
 *   - LEGACY object: { office: [...offices], office_member_addresses: [...flat] }
 * For the legacy shape the flat addresses are grouped back onto their office by
 * office_id so downstream code can treat every row uniformly. Pure/defensive:
 * any other shape yields an empty list.
 */
function normalizeOfficeRows(officeRaw: unknown): NormalizedOfficeRow[] {
  if (Array.isArray(officeRaw)) {
    return (officeRaw as any[]).map((row) => ({
      office: row?.office ?? null,
      office_member_addresses: Array.isArray(row?.office_member_addresses)
        ? row.office_member_addresses
        : [],
    }));
  }
  const legacy = officeRaw as any;
  if (legacy && Array.isArray(legacy.office)) {
    const flat = Array.isArray(legacy.office_member_addresses)
      ? legacy.office_member_addresses
      : [];
    const addressesByOfficeId = new Map<number, any[]>();
    for (const entry of flat as any[]) {
      const officeId = Number(entry?.office?.office_id);
      if (!Number.isFinite(officeId)) continue;
      const list = addressesByOfficeId.get(officeId) ?? [];
      list.push(entry);
      addressesByOfficeId.set(officeId, list);
    }
    return (legacy.office as any[]).map((office) => ({
      office,
      office_member_addresses: addressesByOfficeId.get(Number(office?.office_id)) ?? [],
    }));
  }
  return [];
}

// officeId -> { phone, officeLocation } from each office's office_member_addresses.
function buildOfficeContactMap(
  rows: NormalizedOfficeRow[],
): Map<number, { phone: string; officeLocation: string }> {
  const map = new Map<number, { phone: string; officeLocation: string }>();
  for (const row of rows) {
    const officeId = Number(row.office?.office_id);
    if (!Number.isFinite(officeId)) continue;
    const addresses = row.office_member_addresses ?? [];
    if (addresses.length === 0) continue;
    // Prefer the main office address.
    const entry = addresses.find((address: any) => address?.is_main) ?? addresses[0];
    map.set(officeId, {
      phone: String(entry?.phone ?? ''),
      officeLocation: [entry?.address1, entry?.city, entry?.state_id, entry?.zip]
        .filter(Boolean)
        .join(', '),
    });
  }
  return map;
}
