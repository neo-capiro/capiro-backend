import {
  getLegiStormMemberId,
  getLegiStormOfficeId,
  getLegiStormStaffId,
  hasRequiredMemberIdentity,
  hasRequiredOfficeIdentity,
  hasRequiredStaffIdentity,
  type LegiStormMemberRecord,
  type LegiStormOfficeRecord,
  type LegiStormStaffRecord,
  type LegiStormVendorRecord,
} from './legistorm-types.js';

export type DirectoryMergeMode = 'incremental' | 'full';
export type DirectoryRecordKind = 'member' | 'staff' | 'office';

export interface DirectoryMergeCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  retired: number;
  duplicate: number;
  malformed: number;
}

export interface DirectorySnapshotInputCollections {
  members: unknown[];
  staff: unknown[];
  offices: unknown[];
}

export interface DirectorySnapshotActiveCollections {
  members: LegiStormMemberRecord[];
  staff: LegiStormStaffRecord[];
  offices: LegiStormOfficeRecord[];
}

export interface DirectorySnapshotMergeInput {
  mode: DirectoryMergeMode;
  previous: DirectorySnapshotInputCollections;
  incoming: DirectorySnapshotInputCollections;
  retiredIds: {
    office: number[];
    staff: number[];
  };
}

export interface DirectorySnapshotMergeResult {
  active: DirectorySnapshotActiveCollections;
  tombstones: {
    office: number[];
    staff: number[];
  };
  counts: {
    members: DirectoryMergeCounts;
    staff: DirectoryMergeCounts;
    offices: DirectoryMergeCounts;
    total: DirectoryMergeCounts;
  };
}

export class DirectorySnapshotMergeError extends Error {
  constructor(
    message: string,
    readonly counts: DirectoryMergeCounts,
  ) {
    super(message);
    this.name = 'DirectorySnapshotMergeError';
  }
}

export function mergeDirectorySnapshot(
  input: DirectorySnapshotMergeInput,
): DirectorySnapshotMergeResult {
  const officeTombstones = normalizeRetiredIds(input.retiredIds.office, 'office');
  const staffTombstones = normalizeRetiredIds(input.retiredIds.staff, 'staff');

  const members = replaceCompleteCollection(
    'member',
    input.previous.members,
    input.incoming.members,
    getLegiStormMemberId,
    hasRequiredMemberIdentity,
  );
  const staff = mergeCollection(
    'staff',
    input.mode,
    input.previous.staff,
    input.incoming.staff,
    getLegiStormStaffId,
    hasRequiredStaffIdentity,
    new Set(staffTombstones),
  );
  const offices = mergeCollection(
    'office',
    input.mode,
    input.previous.offices,
    input.incoming.offices,
    getLegiStormOfficeId,
    hasRequiredOfficeIdentity,
    new Set(officeTombstones),
  );

  return {
    active: {
      members: members.records as LegiStormMemberRecord[],
      staff: staff.records as LegiStormStaffRecord[],
      offices: offices.records as LegiStormOfficeRecord[],
    },
    tombstones: { office: officeTombstones, staff: staffTombstones },
    counts: {
      members: members.counts,
      staff: staff.counts,
      offices: offices.counts,
      total: sumCounts(members.counts, staff.counts, offices.counts),
    },
  };
}

type KeyReader = (record: unknown) => number | null;
type RecordGuard = (record: unknown) => record is LegiStormVendorRecord;

interface CollectionMergeResult {
  records: LegiStormVendorRecord[];
  counts: DirectoryMergeCounts;
}

function replaceCompleteCollection(
  kind: DirectoryRecordKind,
  previousRecords: unknown[],
  incomingRecords: unknown[],
  readKey: KeyReader,
  guard: RecordGuard,
): CollectionMergeResult {
  const previous = indexRecords(kind, previousRecords, readKey, guard);
  const incoming = indexRecords(kind, incomingRecords, readKey, guard);
  const counts = emptyCounts();

  for (const [id, record] of incoming) {
    const prior = previous.get(id);
    if (!prior) counts.inserted += 1;
    else if (recordsEqual(prior, record)) counts.unchanged += 1;
    else counts.updated += 1;
  }
  for (const id of previous.keys()) {
    if (!incoming.has(id)) counts.retired += 1;
  }

  return { records: sortedRecords(incoming), counts };
}

function mergeCollection(
  kind: DirectoryRecordKind,
  mode: DirectoryMergeMode,
  previousRecords: unknown[],
  incomingRecords: unknown[],
  readKey: KeyReader,
  guard: RecordGuard,
  retiredIds: ReadonlySet<number>,
): CollectionMergeResult {
  const previous = indexRecords(kind, previousRecords, readKey, guard);
  const incoming = indexRecords(kind, incomingRecords, readKey, guard);
  const active = new Map<number, LegiStormVendorRecord>(mode === 'incremental' ? previous : []);
  const counts = emptyCounts();

  for (const [id, record] of incoming) {
    const prior = previous.get(id);
    if (!prior) counts.inserted += 1;
    else if (recordsEqual(prior, record)) counts.unchanged += 1;
    else counts.updated += 1;
    active.set(id, record);
  }

  for (const id of previous.keys()) {
    if (incoming.has(id)) continue;
    if (mode === 'full' || retiredIds.has(id)) counts.retired += 1;
    else counts.unchanged += 1;
  }

  for (const id of retiredIds) {
    if (!active.has(id)) continue;
    if (incoming.has(id) || !previous.has(id)) counts.retired += 1;
    active.delete(id);
  }

  return { records: sortedRecords(active), counts };
}

function indexRecords(
  kind: DirectoryRecordKind,
  records: unknown[],
  readKey: KeyReader,
  guard: RecordGuard,
): Map<number, LegiStormVendorRecord> {
  const indexed = new Map<number, LegiStormVendorRecord>();
  for (const record of records) {
    const id = readKey(record);
    if (id === null || !guard(record)) {
      throw new DirectorySnapshotMergeError(`malformed ${kind} record`, {
        ...emptyCounts(),
        malformed: 1,
      });
    }
    if (indexed.has(id)) {
      throw new DirectorySnapshotMergeError(`duplicate ${kind} ID ${id}`, {
        ...emptyCounts(),
        duplicate: 1,
      });
    }
    indexed.set(id, record);
  }
  return indexed;
}

function normalizeRetiredIds(ids: number[], kind: 'office' | 'staff'): number[] {
  const unique = new Set<number>();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new DirectorySnapshotMergeError(`malformed retired ${kind} ID`, {
        ...emptyCounts(),
        malformed: 1,
      });
    }
    unique.add(id);
  }
  return [...unique].sort((left, right) => left - right);
}

function sortedRecords(
  records: ReadonlyMap<number, LegiStormVendorRecord>,
): LegiStormVendorRecord[] {
  return [...records.entries()].sort(([left], [right]) => left - right).map(([, record]) => record);
}

function recordsEqual(left: LegiStormVendorRecord, right: LegiStormVendorRecord): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalJson(nested)]),
  );
}

function emptyCounts(): DirectoryMergeCounts {
  return { inserted: 0, updated: 0, unchanged: 0, retired: 0, duplicate: 0, malformed: 0 };
}

function sumCounts(...counts: DirectoryMergeCounts[]): DirectoryMergeCounts {
  return counts.reduce(
    (total, current) => ({
      inserted: total.inserted + current.inserted,
      updated: total.updated + current.updated,
      unchanged: total.unchanged + current.unchanged,
      retired: total.retired + current.retired,
      duplicate: total.duplicate + current.duplicate,
      malformed: total.malformed + current.malformed,
    }),
    emptyCounts(),
  );
}
