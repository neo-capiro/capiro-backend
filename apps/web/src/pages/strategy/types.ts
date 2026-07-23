/*
 * Strategy Planner API response shapes (/strategy-api). Dates arrive as ISO
 * strings over JSON; callers parse with new Date(). Mirrors the sp_* models.
 */

export type StrategyType =
  | 'appropriations'
  | 'authorization'
  | 'regulatory'
  | 'coalition'
  | 'procurement'
  | 'earmark';

export type NodeKind = 'action' | 'decision' | 'gate' | 'milestone' | 'risk';
export type NodeSubject =
  | 'deliverable'
  | 'submission'
  | 'member'
  | 'committee'
  | 'ask'
  | 'agency'
  | 'outcome'
  | 'optics';
export type NodeStatus = 'draft' | 'in_progress' | 'internal_review' | 'active' | 'suggested';
export type ArtifactType = 'workspace_draft' | 'outreach_record';
export type ReferenceKind = 'congress_milestone' | 'ppbe_lane_bar' | 'ppbe_current_phase';

export interface StrategyListItem {
  id: string;
  clientId: string;
  title: string;
  type: StrategyType;
  ownerUserId: string;
  createdByUserId: string;
  lastEditedByUserId: string | null;
  lastEditedAt: string | null;
  createdAt: string;
  nodeCount: number;
}

export interface StrategyNode {
  id: string;
  strategyId: string;
  kind: NodeKind;
  subject: NodeSubject;
  title: string;
  note: string | null;
  ownerUserId: string | null;
  status: NodeStatus;
  startsOn: string; // ISO date
  endsOn: string | null;
  openEnded: boolean;
  meriAuthored: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyNodeArtifact {
  id: string;
  strategyId: string;
  nodeId: string;
  artifactType: ArtifactType;
  artifactRef: string;
  createdAt: string;
}

export interface StrategyDetail {
  id: string;
  clientId: string;
  title: string;
  type: StrategyType;
  goal: string | null;
  meriContext: string | null;
  targetDate: string | null;
  ownerUserId: string;
  createdByUserId: string;
  lastEditedByUserId: string | null;
  lastEditedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  nodes: StrategyNode[];
  artifacts: StrategyNodeArtifact[];
}

export interface FirmPhase {
  id: string;
  label: string;
  startFy: number;
  startQ: number;
  endFy: number;
  endQ: number;
  position: number;
}

export interface ReferenceRow {
  id: string;
  kind: ReferenceKind;
  label: string;
  fy: number | null;
  startsOn: string | null;
  endsOn: string | null;
  tone: string | null;
  position: number;
}

export interface ReferenceCalendars {
  congress: ReferenceRow[];
  ppbeLanes: ReferenceRow[];
  ppbeCurrentPhases: ReferenceRow[];
  source: Record<string, 'baseline' | 'override'>;
}

export interface CreateStrategyInput {
  clientId: string;
  type: StrategyType;
  title?: string;
  goal?: string;
  ownerUserId?: string;
  targetDate?: string;
  meriContext?: string;
}
