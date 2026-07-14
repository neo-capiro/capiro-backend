import {
  getLegiStormMemberId,
  getLegiStormOfficeId,
  getLegiStormStaffId,
  hasRequiredMemberIdentity,
  hasRequiredOfficeIdentity,
  hasRequiredStaffIdentity,
  isVendorRecord,
  type LegiStormMemberRecord,
} from './legistorm-types.js';

export interface DirectoryValidationCollections {
  members: unknown[];
  staff: unknown[];
  offices: unknown[];
}

export type DirectoryApprovalGate =
  | 'memberCountChange'
  | 'staffCountDrop'
  | 'officeCountDrop'
  | 'committeeMembershipDrop'
  | 'photoCoverageDrop';

export interface DirectoryValidationApproval {
  approvedBy: string;
  approvedAt: string;
  reason: string;
  gates: DirectoryApprovalGate[];
}

export interface DirectorySnapshotValidationInput {
  previous: DirectoryValidationCollections;
  next: DirectoryValidationCollections;
  retiredIds: { staff: number[]; office: number[] };
  approval?: unknown;
}

export interface DirectoryValidationGate {
  name: string;
  passed: boolean;
  detail: string;
}

export interface DirectorySnapshotValidationReport {
  valid: boolean;
  errors: string[];
  gates: DirectoryValidationGate[];
  approval: DirectoryValidationApproval | null;
  metrics: {
    previous: DirectoryAggregateMetrics;
    next: DirectoryAggregateMetrics;
    memberPhotoCoverage: { previous: number; next: number };
  };
}

export interface DirectoryAggregateMetrics {
  members: number;
  staff: number;
  offices: number;
  committeeMemberships: number;
}

export function validateDirectorySnapshot(
  input: DirectorySnapshotValidationInput,
): DirectorySnapshotValidationReport {
  const errors: string[] = [];
  const gates: DirectoryValidationGate[] = [];
  const approval = validatedApproval(input.approval, errors);
  const approvedGates = new Set(approval?.gates ?? []);

  const identityErrors: string[] = [];
  validateIdentities(input.next, identityErrors);
  validateCurrentMemberOffices(input.next.members, identityErrors);
  errors.push(...identityErrors);
  gates.push({
    name: 'identity-and-current-office',
    passed: identityErrors.length === 0,
    detail:
      identityErrors.length === 0
        ? 'all required identities are unique and current members have offices'
        : `${identityErrors.length} identity/current-office error(s)`,
  });

  const previous = aggregateMetrics(input.previous);
  const next = aggregateMetrics(input.next);
  const previousPhotoCoverage = photoCoverage(input.previous.members);
  const nextPhotoCoverage = photoCoverage(input.next.members);

  const memberRatio = previous.members === 0 ? 1 : next.members / previous.members;
  addGate(
    gates,
    errors,
    'member-count',
    (memberRatio >= 0.9 && memberRatio <= 1.1) || approvedGates.has('memberCountChange'),
    `member count ratio ${formatRatio(memberRatio)} must remain within 0.900–1.100`,
  );

  addDropGate({
    kind: 'staff',
    previousRecords: input.previous.staff,
    nextRecords: input.next.staff,
    retiredIds: input.retiredIds.staff,
    readId: getLegiStormStaffId,
    approved: approvedGates.has('staffCountDrop'),
    gates,
    errors,
  });
  addDropGate({
    kind: 'office',
    previousRecords: input.previous.offices,
    nextRecords: input.next.offices,
    retiredIds: input.retiredIds.office,
    readId: getLegiStormOfficeId,
    approved: approvedGates.has('officeCountDrop'),
    gates,
    errors,
  });

  const committeeRatio =
    previous.committeeMemberships === 0
      ? 1
      : next.committeeMemberships / previous.committeeMemberships;
  addGate(
    gates,
    errors,
    'committee-memberships',
    committeeRatio >= 0.9 || approvedGates.has('committeeMembershipDrop'),
    `committee membership count fell to ${formatRatio(committeeRatio)} of previous`,
  );

  const photoDrop = previousPhotoCoverage - nextPhotoCoverage;
  addGate(
    gates,
    errors,
    'member-photo-coverage',
    photoDrop <= 0.05 + Number.EPSILON || approvedGates.has('photoCoverageDrop'),
    `member photo coverage fell by ${formatRatio(photoDrop)}`,
  );

  return {
    valid: errors.length === 0,
    errors,
    gates,
    approval,
    metrics: {
      previous,
      next,
      memberPhotoCoverage: { previous: previousPhotoCoverage, next: nextPhotoCoverage },
    },
  };
}

function validatedApproval(
  approval: unknown,
  errors: string[],
): DirectoryValidationApproval | null {
  if (approval === undefined) return null;
  if (!isVendorRecord(approval)) return invalidApproval(errors);
  // Property access below can throw for hostile inputs (e.g. proxy/getter-backed
  // objects). Parsing must fail closed, never propagate, so guard the whole body.
  try {
    const allowed = new Set<DirectoryApprovalGate>([
      'memberCountChange',
      'staffCountDrop',
      'officeCountDrop',
      'committeeMembershipDrop',
      'photoCoverageDrop',
    ]);
    const { approvedBy, approvedAt, reason, gates } = approval;
    if (
      typeof approvedBy !== 'string' ||
      typeof approvedAt !== 'string' ||
      typeof reason !== 'string' ||
      !Array.isArray(gates)
    ) {
      return invalidApproval(errors);
    }
    const timestamp = Date.parse(approvedAt);
    const validTimestamp =
      !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === approvedAt;
    // Validate by index rather than Array.every()/new Set(): both skip sparse-array
    // holes, so a hole (e.g. `new Array(1)`) would otherwise be accepted and later
    // serialized as `[null]`. Reject holes, non-strings, unknown gates, and duplicates,
    // and persist only the validated entries.
    const cleanGates: DirectoryApprovalGate[] = [];
    let validGates = gates.length > 0;
    if (validGates) {
      const seen = new Set<DirectoryApprovalGate>();
      for (let index = 0; index < gates.length; index += 1) {
        const gate = gates[index];
        if (typeof gate !== 'string' || !allowed.has(gate as DirectoryApprovalGate)) {
          validGates = false;
          break;
        }
        const typedGate = gate as DirectoryApprovalGate;
        if (seen.has(typedGate)) {
          validGates = false;
          break;
        }
        seen.add(typedGate);
        cleanGates.push(typedGate);
      }
    }
    if (
      approvedBy.trim().length === 0 ||
      reason.trim().length === 0 ||
      !validTimestamp ||
      !validGates
    ) {
      return invalidApproval(errors);
    }
    return {
      approvedBy,
      approvedAt,
      reason,
      gates: cleanGates,
    };
  } catch {
    return invalidApproval(errors);
  }
}

function invalidApproval(errors: string[]): null {
  errors.push('invalid directory validation approval provenance');
  return null;
}

function validateIdentities(collections: DirectoryValidationCollections, errors: string[]): void {
  validateIdentityCollection(
    'member',
    collections.members,
    hasRequiredMemberIdentity,
    getLegiStormMemberId,
    errors,
  );
  validateIdentityCollection(
    'staff',
    collections.staff,
    hasRequiredStaffIdentity,
    getLegiStormStaffId,
    errors,
  );
  validateIdentityCollection(
    'office',
    collections.offices,
    hasRequiredOfficeIdentity,
    getLegiStormOfficeId,
    errors,
  );
}

function validateIdentityCollection(
  kind: 'member' | 'staff' | 'office',
  records: unknown[],
  guard: (record: unknown) => boolean,
  readId: (record: unknown) => number | null,
  errors: string[],
): void {
  const seen = new Set<number>();
  for (const record of records) {
    if (!guard(record)) {
      errors.push(`malformed ${kind} record`);
      continue;
    }
    const id = readId(record)!;
    if (seen.has(id)) errors.push(`duplicate ${kind} ID ${id}`);
    else seen.add(id);
  }
}

function validateCurrentMemberOffices(members: unknown[], errors: string[]): void {
  for (const record of members) {
    if (!hasRequiredMemberIdentity(record)) continue;
    if (!hasCurrentOffice(record)) {
      errors.push(`member ID ${record.member.member_id} has no current office`);
    }
  }
}

function hasCurrentOffice(member: LegiStormMemberRecord): boolean {
  if (!Array.isArray(member.member_offices)) return false;
  return member.member_offices.some((office) => {
    if (!isVendorRecord(office)) return false;
    if (!isVendorRecord(office.office)) return false;
    if (
      typeof office.office.office_id !== 'number' ||
      !Number.isSafeInteger(office.office.office_id) ||
      office.office.office_id <= 0 ||
      typeof office.office.name !== 'string' ||
      office.office.name.trim().length === 0
    ) {
      return false;
    }
    if (office.is_current === false) return false;
    const status = typeof office.status === 'string' ? office.status.trim().toLowerCase() : '';
    if (status && status !== 'in office') return false;
    if (office.is_current === true) return true;
    if (status === 'in office') return true;
    return typeof office.end_date === 'string' && office.end_date.startsWith('2100-');
  });
}

function aggregateMetrics(collections: DirectoryValidationCollections): DirectoryAggregateMetrics {
  return {
    members: collections.members.length,
    staff: collections.staff.length,
    offices: collections.offices.length,
    committeeMemberships: collections.members.reduce<number>((total, member) => {
      if (!isVendorRecord(member)) return total;
      const memberships = Array.isArray(member.committees)
        ? member.committees
        : Array.isArray(member.committee_memberships)
          ? member.committee_memberships
          : [];
      return total + memberships.length;
    }, 0),
  };
}

function photoCoverage(members: unknown[]): number {
  if (members.length === 0) return 1;
  const withPhoto = members.filter((member) => {
    if (!isVendorRecord(member) || !Array.isArray(member.photos)) return false;
    return member.photos.some(
      (photo) =>
        isVendorRecord(photo) &&
        typeof photo.url === 'string' &&
        photo.url.trim().length > 0 &&
        photo.status !== 'inactive',
    );
  }).length;
  return withPhoto / members.length;
}

interface DropGateInput {
  kind: 'staff' | 'office';
  previousRecords: unknown[];
  nextRecords: unknown[];
  retiredIds: number[];
  readId: (record: unknown) => number | null;
  approved: boolean;
  gates: DirectoryValidationGate[];
  errors: string[];
}

function addDropGate(input: DropGateInput): void {
  const drop = Math.max(0, input.previousRecords.length - input.nextRecords.length);
  const allowedDrop = input.previousRecords.length * 0.05;
  const previousIds = idSet(input.previousRecords, input.readId);
  const nextIds = idSet(input.nextRecords, input.readId);
  const retiredIds = new Set(input.retiredIds);
  const removedIds = [...previousIds].filter((id) => !nextIds.has(id));
  const missingTombstones = removedIds.filter((id) => !retiredIds.has(id));
  addGate(
    input.gates,
    input.errors,
    `${input.kind}-retirement`,
    missingTombstones.length === 0,
    `${input.kind} identities removed without tombstones: ${missingTombstones.join(',')}`,
  );
  const passed = drop <= allowedDrop + Number.EPSILON || input.approved;
  addGate(
    input.gates,
    input.errors,
    `${input.kind}-count`,
    passed,
    `${input.kind} count fell by ${drop}; approval and ${drop} matching retired IDs required above five percent`,
  );
}

function idSet(records: unknown[], readId: (record: unknown) => number | null): Set<number> {
  const ids = new Set<number>();
  for (const record of records) {
    const id = readId(record);
    if (id !== null) ids.add(id);
  }
  return ids;
}

function addGate(
  gates: DirectoryValidationGate[],
  errors: string[],
  name: string,
  passed: boolean,
  detail: string,
): void {
  gates.push({ name, passed, detail });
  if (!passed) errors.push(detail);
}

function formatRatio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : 'invalid';
}
