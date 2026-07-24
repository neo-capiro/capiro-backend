export type LegiStormVendorRecord = Record<string, unknown>;

export type LegiStormMemberRecord = LegiStormVendorRecord & {
  member: LegiStormVendorRecord & {
    member_id: number;
    bioguide_id: string;
    profile: LegiStormVendorRecord;
  };
};

export type LegiStormStaffRecord = LegiStormVendorRecord & {
  staff: LegiStormVendorRecord & {
    id: number;
    first_name: string;
    last_name: string;
  };
};

export type LegiStormOfficeRecord = LegiStormVendorRecord & {
  office: LegiStormVendorRecord & {
    office_id: number;
    name: string;
  };
};

export function isVendorRecord(value: unknown): value is LegiStormVendorRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function getLegiStormMemberId(record: unknown): number | null {
  if (!isVendorRecord(record) || !isVendorRecord(record.member)) return null;
  return positiveInteger(record.member.member_id);
}

export function getLegiStormStaffId(record: unknown): number | null {
  if (!isVendorRecord(record) || !isVendorRecord(record.staff)) return null;
  return positiveInteger(record.staff.id);
}

export function getLegiStormOfficeId(record: unknown): number | null {
  if (!isVendorRecord(record) || !isVendorRecord(record.office)) return null;
  return positiveInteger(record.office.office_id);
}

export function hasRequiredMemberIdentity(record: unknown): record is LegiStormMemberRecord {
  if (getLegiStormMemberId(record) === null || !isVendorRecord(record)) return false;
  const member = record.member;
  return (
    isVendorRecord(member) &&
    typeof member.bioguide_id === 'string' &&
    member.bioguide_id.trim().length > 0 &&
    isVendorRecord(member.profile)
  );
}

export function hasRequiredStaffIdentity(record: unknown): record is LegiStormStaffRecord {
  if (getLegiStormStaffId(record) === null || !isVendorRecord(record)) return false;
  const staff = record.staff;
  return (
    isVendorRecord(staff) &&
    typeof staff.first_name === 'string' &&
    staff.first_name.trim().length > 0 &&
    typeof staff.last_name === 'string' &&
    staff.last_name.trim().length > 0
  );
}

export function hasRequiredOfficeIdentity(record: unknown): record is LegiStormOfficeRecord {
  if (getLegiStormOfficeId(record) === null || !isVendorRecord(record)) return false;
  const office = record.office;
  return isVendorRecord(office) && typeof office.name === 'string' && office.name.trim().length > 0;
}

/**
 * Return the original vendor object without projecting it through a reduced DTO.
 * Downstream merge and archive code relies on this to preserve fields added by
 * LegiStorm before Capiro explicitly models them.
 */
export function retainVendorRecord<T extends LegiStormVendorRecord>(record: T): T {
  return record;
}

/**
 * Privately Funded Travel API (WS-F, LegiStorm gaps/enrichment plan) —
 * /trips/list. Verified against the real Congressional API OpenAPI spec
 * (TripListResponse et al.). A traveler is EITHER a member (traveler_member)
 * OR a staffer (traveler_staffer) — never both, per the spec's own
 * description. There is no /trips/retired-ids endpoint (confirmed: only
 * caucus/office/staff/townhall have one) — trips have no tombstone
 * mechanism at all, an accepted limitation, not an oversight.
 */
export type LegiStormCorePerson = LegiStormVendorRecord & {
  id?: number;
  first_name?: string;
  last_name?: string;
  preferred_first_name?: string;
  preferred_last_name?: string;
};

export type LegiStormMemberShort = LegiStormVendorRecord & {
  member_id: number;
  profile?: LegiStormCorePerson;
  state_id?: string;
  district_no?: string | null;
  office_type_id?: string;
  party?: string;
};

export type LegiStormTripDestination = LegiStormVendorRecord & {
  id: number;
  name?: string;
  state_id?: string;
};

export type LegiStormTripSponsor = LegiStormVendorRecord & {
  id: number;
  name?: string;
};

export type LegiStormTripTravelerStaffer = LegiStormVendorRecord & {
  staffer?: LegiStormCorePerson;
  positions?: unknown[];
};

export type LegiStormTripRecord = LegiStormVendorRecord & {
  id: number;
  approver?: LegiStormMemberShort;
  traveler_member?: LegiStormMemberShort | null;
  traveler_staffer?: LegiStormTripTravelerStaffer | null;
  companion_name?: string | null;
  companion_status?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  duration?: number | null;
  purpose?: string | null;
  comment?: string | null;
  total_cost?: number | null;
  transportation_expenses?: number | null;
  lodging_expenses?: number | null;
  meal_expenses?: number | null;
  other_expenses?: number | null;
  companion_transportation_expenses?: number | null;
  companion_lodging_expenses?: number | null;
  companion_other_expenses?: number | null;
  destinations?: LegiStormTripDestination[];
  sponsors?: LegiStormTripSponsor[];
  filed_date?: string | null;
  amended_date?: string | null;
  updated_at?: string | null;
};

export function getLegiStormTripId(record: unknown): number | null {
  if (!isVendorRecord(record)) return null;
  return positiveInteger(record.id);
}

/**
 * Minimal identity bar (matches the other guards' spirit): a valid id, AND
 * at least one of traveler_member/traveler_staffer present — a trip record
 * with no traveler at all is junk data, not a real record.
 */
export function hasRequiredTripIdentity(record: unknown): record is LegiStormTripRecord {
  if (getLegiStormTripId(record) === null || !isVendorRecord(record)) return false;
  return isVendorRecord(record.traveler_member) || isVendorRecord(record.traveler_staffer);
}
