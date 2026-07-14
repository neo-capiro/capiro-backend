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
