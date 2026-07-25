/*
 * P0-1: the pure snapshot-vs-current diff behind the restore impact preview and
 * behind the restore itself. No Nest/Prisma imports so it stays trivially
 * unit-testable (restore-impact.spec.ts).
 *
 * The audit requires the user to see, BEFORE restoring, exactly which nodes are
 * added, changed and removed — and to be told what removing a node does to the
 * Workspace drafts, Outreach records, runs and provenance that reference it.
 * VersionService computes both the preview and the write plan from THIS module,
 * so the preview can never disagree with what the restore actually does.
 *
 * Five buckets, because soft delete makes "added" ambiguous:
 *  - added     — in the snapshot, no row at all today (a hard-deleted node): re-CREATED
 *  - revived   — in the snapshot, present but ARCHIVED today: un-archived, and its
 *                detached artifacts re-attach
 *  - changed   — in the snapshot and live today, with at least one differing field
 *  - unchanged — in the snapshot and live today, byte-identical
 *  - removed   — live today, absent from the snapshot: ARCHIVED (never deleted)
 */

/** The comparable field set. Mirrors SnapshotNode minus identity/audit fields. */
export const COMPARED_FIELDS = [
  'kind',
  'subject',
  'title',
  'note',
  'ownerUserId',
  'status',
  'startsOn',
  'endsOn',
  'openEnded',
  'dependsOnIds',
  'targetRef',
] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];

/** A snapshot node as stored on sp_version.snapshot (see versioning.ts SnapshotNode). */
export interface ImpactSnapshotNode {
  id: string;
  kind: string;
  subject: string;
  title: string;
  note: string | null;
  ownerUserId: string | null;
  status: string;
  startsOn: string;
  endsOn: string | null;
  openEnded: boolean;
  dependsOnIds?: string[];
  targetRef?: unknown;
  /** Absent on snapshots cut before P0-1 added it — see VersionService.restore. */
  provenance?: unknown;
}

/** A current sp_node row (subset), including archived ones. */
export interface ImpactCurrentNode {
  id: string;
  kind: string;
  subject: string;
  title: string;
  note: string | null;
  ownerUserId: string | null;
  status: string;
  startsOn: Date | string | null;
  endsOn: Date | string | null;
  openEnded: boolean;
  dependsOnIds: string[];
  targetRef?: unknown;
  provenance?: unknown;
  archivedAt: Date | string | null;
}

export interface ImpactNodeRef {
  id: string;
  title: string;
  kind: string;
  subject: string;
}

export interface ImpactChangedNode extends ImpactNodeRef {
  /** Which of COMPARED_FIELDS differ (snapshot value vs current value). */
  changedFields: ComparedField[];
}

export interface RestoreNodeDiff {
  added: ImpactNodeRef[];
  revived: ImpactNodeRef[];
  changed: ImpactChangedNode[];
  unchanged: ImpactNodeRef[];
  removed: ImpactNodeRef[];
}

/** ISO calendar-date for a @db.Date value; null-safe. Mirrors versioning.isoDate. */
function isoDay(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Key-order-independent JSON serialization, so a targetRef/provenance snapshot
 * that round-tripped through JSONB with different key order does NOT read as a
 * change (which would make every restore look like it edits every targeted node).
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function nodeRef(n: { id: string; title: string; kind: string; subject: string }): ImpactNodeRef {
  return { id: n.id, title: n.title, kind: n.kind, subject: n.subject };
}

/** The snapshot-side value of a compared field, normalized for comparison. */
function snapValue(n: ImpactSnapshotNode, f: ComparedField): string {
  switch (f) {
    case 'startsOn':
      return String(isoDay(n.startsOn));
    case 'endsOn':
      return String(isoDay(n.endsOn));
    case 'dependsOnIds':
      // Order-insensitive: dependency edges are a SET, and createMany/update
      // round-trips do not guarantee array order.
      return stableStringify([...(n.dependsOnIds ?? [])].sort());
    case 'targetRef':
      return stableStringify(n.targetRef ?? null);
    case 'openEnded':
      return String(!!n.openEnded);
    default:
      return String(n[f] ?? null);
  }
}

/** The current-row value of a compared field, normalized the same way. */
function curValue(n: ImpactCurrentNode, f: ComparedField): string {
  switch (f) {
    case 'startsOn':
      return String(isoDay(n.startsOn));
    case 'endsOn':
      return String(isoDay(n.endsOn));
    case 'dependsOnIds':
      return stableStringify([...(n.dependsOnIds ?? [])].sort());
    case 'targetRef':
      return stableStringify(n.targetRef ?? null);
    case 'openEnded':
      return String(!!n.openEnded);
    default:
      return String(n[f] ?? null);
  }
}

/** Which compared fields differ between a snapshot node and its current row. */
export function changedFieldsOf(snap: ImpactSnapshotNode, cur: ImpactCurrentNode): ComparedField[] {
  return COMPARED_FIELDS.filter((f) => snapValue(snap, f) !== curValue(cur, f));
}

/**
 * Classify every node into the five buckets. `currentNodes` MUST include archived
 * rows (that is what distinguishes `revived` from `added`).
 */
export function diffSnapshotAgainstCurrent(
  snapshotNodes: ImpactSnapshotNode[],
  currentNodes: ImpactCurrentNode[],
): RestoreNodeDiff {
  const byId = new Map(currentNodes.map((n) => [n.id, n]));
  const snapIds = new Set(snapshotNodes.map((n) => n.id));

  const diff: RestoreNodeDiff = {
    added: [],
    revived: [],
    changed: [],
    unchanged: [],
    removed: [],
  };

  for (const snap of snapshotNodes) {
    const cur = byId.get(snap.id);
    if (!cur) {
      diff.added.push(nodeRef(snap));
      continue;
    }
    if (cur.archivedAt != null) {
      // Revival is itself a material change regardless of field equality — the
      // node re-enters the plan — so it is reported separately, never as
      // "unchanged".
      diff.revived.push(nodeRef(snap));
      continue;
    }
    const changedFields = changedFieldsOf(snap, cur);
    if (changedFields.length) diff.changed.push({ ...nodeRef(snap), changedFields });
    else diff.unchanged.push(nodeRef(snap));
  }

  for (const cur of currentNodes) {
    if (cur.archivedAt != null) continue; // already archived — a restore does not re-archive
    if (!snapIds.has(cur.id)) diff.removed.push(nodeRef(cur));
  }

  return diff;
}

/**
 * True when the snapshot carries a provenance opinion that differs from the live
 * row. Restore uses this to put grounding back on a node whose USER-VISIBLE fields
 * are identical (so it isn't in `changed`) but whose provenance drifted — without
 * it, "restore puts provenance back" would only hold for changed/revived nodes.
 *
 * A snapshot cut before P0-1 has NO provenance key: that is "no opinion", so this
 * returns false and the live value is left alone (never blanked).
 */
export function provenanceDiffers(snap: ImpactSnapshotNode, cur: ImpactCurrentNode): boolean {
  if (snap.provenance === undefined) return false;
  return stableStringify(snap.provenance ?? null) !== stableStringify(cur.provenance ?? null);
}

/** True when restoring this snapshot would change nothing at all. */
export function isNoOpRestore(diff: RestoreNodeDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.revived.length === 0 &&
    diff.changed.length === 0 &&
    diff.removed.length === 0
  );
}
