/** Exact owner data types extracted from b8b7262aa0ae8b4d9ef30e75df41b147b2d6e3cf. No runtime imports. */
import type { CanonicalMaterializationBinding } from './objective-planner-materialization.js';

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
  targetRef?: unknown; // who this node's outreach/workspace action is for (opaque; no Prisma types in this pure file)
  /**
   * P0-1: A9 per-node grounding (cited pack sections/facts). Recorded on the
   * snapshot so a restore can put provenance back instead of erasing it. On a
   * snapshot cut BEFORE P0-1 this key is ABSENT (not null), which restore treats
   * as "this snapshot has no opinion — leave the live value alone"; an explicit
   * null means the node genuinely had none.
   */
  provenance?: unknown;
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

type Canonical = CanonicalMaterializationBinding['canonical'];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Data = { [key: string]: Json };

export type CanonicalSourceSchedule = {
  subtype: 'task' | 'milestone'; startOn: string; dueOn: string;
};

export type CanonicalTaskBaseline = {
  name: string; description: string; schedule: CanonicalSourceSchedule; dependencies: string[];
};

export type CanonicalTaskIndexEntry = {
  sourceNodeId: string; taskId: string; createdVersion: number; appliedVersion: number;
  firstOwnerReceiptId: string; originalGroupKeys: string[]; baseline: CanonicalTaskBaseline;
};

export type CanonicalPlannerRow = { id: string; version: number; archived: boolean; data: Data };

export type CanonicalSourceEdge = {
  sourceNodeId: string; dependsOnSourceNodeId: string;
  disposition: 'task_dependency' | 'context_only' | 'archived_source';
};

export interface CanonicalRegenerationInput {
  canonical: Canonical;
  ownerReceiptId: string;
  previous: {
    canonical: Canonical; applicationRequestId: string; applicationAckSha256: string;
    ownerReceiptId: string; ownerReceiptSha256: string;
    project: { createdVersion: number; appliedVersion: number; baseline: { name: string; description: string } };
    taskIndex: CanonicalTaskIndexEntry[];
  };
  project: CanonicalPlannerRow;
  currentTasks: CanonicalPlannerRow[];
  proposed: {
    project: { name: string; description: string };
    tasks: Array<{ sourceNodeId: string; newTaskId: string | null; fields: {
      name: string; description: string; schedule: CanonicalSourceSchedule;
    } }>;
    sourceNodeIds: string[];
    edges: CanonicalSourceEdge[];
  };
  /** Complete tenant task IDs/edges, not a permission-filtered page. Values are
   * private validation inputs and are never copied into a public issue. */
  allTasks: Array<{ id: string; dependencies: string[] }>;
}

export interface CanonicalFieldDecision {
  field: 'name' | 'description' | 'schedule' | 'dependencies';
  resolution: 'source_applied' | 'unchanged' | 'human_preserved';
  baselineSha256: string; proposedSha256: string; observedSha256: string; appliedSha256: string;
  scheduleGuardSha256?: string;
}

export interface CanonicalRegenerationPlan {
  receiptVersion: 3;
  phase: 'planned';
  canonical: Canonical;
  previous: { applicationRequestId: string; applicationAckSha256: string; ownerReceiptId: string; ownerReceiptSha256: string };
  project: {
    id: string; createdVersion: number; beforeVersion: number; appliedVersion: number; write: boolean;
    data: Data; baseline: { name: string; description: string }; fields: CanonicalFieldDecision[];
  };
  tasks: Array<{
    sourceNodeId: string; taskId: string; createdVersion: number; beforeVersion: number | null;
    appliedVersion: number | null; disposition: 'created' | 'updated' | 'reused' | 'retained';
    /** For created rows these are SOURCE fields only. The owner supplies its
     * normal creation defaults. Reused rows include unchanged human data. */
    data: Data | null; fields: CanonicalFieldDecision[];
  }>;
  taskIndex: Array<CanonicalTaskIndexEntry & { active: boolean }>;
  edges: Array<CanonicalSourceEdge & { applied: boolean }>;
  mergedGraphSha256: string;
  counts: { createdProjects: 0; updatedProjects: number; createdTasks: number; updatedTasks: number;
    reusedTasks: number; retainedTasks: number; humanPreservedFields: number };
}
