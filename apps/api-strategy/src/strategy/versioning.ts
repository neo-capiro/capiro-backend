/*
 * Pure versioning helpers (plan §4 versioning policy, unit-tested in
 * versioning.spec.ts). No Nest/Prisma imports so these stay trivially testable.
 *
 * Policy: one version per mutation batch. Consecutive MANUAL field edits by the
 * SAME person within COALESCE_WINDOW_MS fold into the latest version
 * (autosave-style); adds, deletes, Meri edit-sets, and restores always cut a
 * fresh version.
 */

export const COALESCE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** ISO calendar-date (YYYY-MM-DD) for a @db.Date value, preserving the stored day. */
export function isoDate(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  return new Date(d).toISOString().slice(0, 10);
}

/** Full ISO timestamp for a DateTime value. */
export function isoDateTime(d: Date | string): string {
  return new Date(d).toISOString();
}

export interface SnapshotNode {
  id: string;
  kind: string;
  subject: string;
  title: string;
  note: string | null;
  ownerUserId: string | null;
  status: string;
  startsOn: string; // YYYY-MM-DD
  endsOn: string | null; // YYYY-MM-DD | null
  openEnded: boolean;
  dependsOnIds: string[]; // A2: node-id edges (preserved on restore — ids are stable)
  meriAuthored: boolean;
  createdByUserId: string;
  createdAt: string; // ISO
}

export interface StrategySnapshot {
  meta: {
    id: string;
    clientId: string;
    title: string;
    type: string;
    goal: string | null;
    meriContext: string | null;
    meriSummary: string | null;
    targetDate: string | null; // YYYY-MM-DD | null
    ownerUserId: string;
    createdByUserId: string;
    createdAt: string; // ISO
  };
  nodes: SnapshotNode[];
}

/** Row shapes buildSnapshot accepts (subset of the Prisma models). */
export interface SnapshotStrategyRow {
  id: string;
  clientId: string;
  title: string;
  type: string;
  goal: string | null;
  meriContext: string | null;
  meriSummary: string | null;
  targetDate: Date | string | null;
  ownerUserId: string;
  createdByUserId: string;
  createdAt: Date | string;
}
export interface SnapshotNodeRow {
  id: string;
  kind: string;
  subject: string;
  title: string;
  note: string | null;
  ownerUserId: string | null;
  status: string;
  startsOn: Date | string;
  endsOn: Date | string | null;
  openEnded: boolean;
  dependsOnIds: string[];
  meriAuthored: boolean;
  createdByUserId: string;
  createdAt: Date | string;
}

/** Build the full strategy-meta+nodes snapshot stored on a version. */
export function buildSnapshot(
  strategy: SnapshotStrategyRow,
  nodes: SnapshotNodeRow[],
): StrategySnapshot {
  return {
    meta: {
      id: strategy.id,
      clientId: strategy.clientId,
      title: strategy.title,
      type: strategy.type,
      goal: strategy.goal ?? null,
      meriContext: strategy.meriContext ?? null,
      meriSummary: strategy.meriSummary ?? null,
      targetDate: isoDate(strategy.targetDate),
      ownerUserId: strategy.ownerUserId,
      createdByUserId: strategy.createdByUserId,
      createdAt: isoDateTime(strategy.createdAt),
    },
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      subject: n.subject,
      title: n.title,
      note: n.note ?? null,
      ownerUserId: n.ownerUserId ?? null,
      status: n.status,
      startsOn: isoDate(n.startsOn)!,
      endsOn: isoDate(n.endsOn),
      openEnded: n.openEnded,
      dependsOnIds: n.dependsOnIds ?? [],
      meriAuthored: n.meriAuthored,
      createdByUserId: n.createdByUserId,
      createdAt: isoDateTime(n.createdAt),
    })),
  };
}

export interface LatestVersionRef {
  authorKind: string;
  authorUserId: string | null;
  restoredFromVersionId: string | null;
  coalescible: boolean;
  createdAt: Date | string;
}

/**
 * Whether an incoming person field-edit should fold into `latest` instead of
 * cutting a fresh version. True only when the latest version is ITSELF a
 * coalescible field-edit batch (not an add/delete/create/restore/Meri version)
 * by the SAME author inside the window — so structural events always stand
 * alone in history while rapid field edits collapse.
 */
export function isCoalescible(
  latest: LatestVersionRef | null | undefined,
  incoming: { authorUserId: string | null; nowMs: number },
): boolean {
  if (!latest) return false;
  if (!latest.coalescible) return false;
  if (latest.authorKind !== 'person') return false;
  if (latest.restoredFromVersionId != null) return false;
  if (latest.authorUserId == null || incoming.authorUserId == null) return false;
  if (latest.authorUserId !== incoming.authorUserId) return false;
  return incoming.nowMs - new Date(latest.createdAt).getTime() <= COALESCE_WINDOW_MS;
}
