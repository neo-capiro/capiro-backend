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
 * Legislative Districts API (v2.023.07/legislative_districts) — UNLIKE the
 * Congressional API's member/staff/office records, a district record is FLAT
 * at the top level (no nested `district: {...}` wrapper). Both `/congress/list`
 * and `/congress/zipcode` return this SAME shape (one OpenAPI schema,
 * CongressDistrict). `status`/`effective_date`/`enacted_date` are genuinely
 * optional on the wire — verified live 2026-07-24: a `/congress/zipcode` result
 * can omit them entirely while a `/congress/list?status=F` result always
 * carries them (that's how a future, enacted-but-not-yet-effective map is
 * distinguished from the current one for the SAME district_no).
 */
export type LegiStormCongressDistrictMember = LegiStormVendorRecord & {
  id: number;
  bioguide_id: string;
  preferred_first?: string;
  preferred_last?: string;
  party_name?: string;
  status?: string;
  outgoing_status?: string | null;
};

export type LegiStormCongressDistrictRecord = LegiStormVendorRecord & {
  id: number;
  office_type: string; // 'House' | 'Senate'
  state: string;
  name: string;
  // The OpenAPI spec types both of these as `string`, but a live-verified
  // response (2026-07-24, /congress/zipcode?zip=20001) returned district_no
  // as a JSON NUMBER (1), not a string. Accepting either shape defensively
  // rather than trusting one source over the other; callers must String()
  // this, never assume a type.
  district_no: number | string | null;
  senate_class: number | string | null;
  /** 'C' current | 'F' future (enacted, not yet effective). Absent on some responses. */
  status?: 'C' | 'F';
  effective_date?: string | null;
  enacted_date?: string | null;
  members: LegiStormCongressDistrictMember[];
  /**
   * A LegiStorm-hosted URL that embeds our own API key in the URL PATH (NOT a
   * query param, NOT header auth) — e.g.
   * ".../getKMLByHash/hash/<key>/state_id/DC/...". Treat as a SECRET: never
   * send to a browser, never log verbatim, never persist raw in our own
   * database. Fetch once server-side and re-host the content under our own
   * S3 key (see LegislativeDistrict.kmlS3Key).
   */
  kml?: string;
};

export function getLegiStormCongressDistrictId(record: unknown): number | null {
  if (!isVendorRecord(record)) return null;
  return positiveInteger(record.id);
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

export function hasRequiredCongressDistrictIdentity(
  record: unknown,
): record is LegiStormCongressDistrictRecord {
  if (getLegiStormCongressDistrictId(record) === null || !isVendorRecord(record)) return false;
  return (
    typeof record.office_type === 'string' &&
    record.office_type.trim().length > 0 &&
    typeof record.state === 'string' &&
    record.state.trim().length > 0 &&
    typeof record.name === 'string' &&
    record.name.trim().length > 0 &&
    Array.isArray(record.members)
  );
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
