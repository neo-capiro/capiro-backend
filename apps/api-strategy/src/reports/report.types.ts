import type { ReportAudience, ReportFormat } from "./dto/report-export.dto.js";

export type ReportNodeKind =
  | "action"
  | "decision"
  | "gate"
  | "milestone"
  | "risk";

export interface NormalizedReportOptions {
  format: ReportFormat;
  audience: ReportAudience;
  useClientLogo: boolean;
  includeRoadmap: boolean;
  includeEvidenceAppendix: boolean;
  includeChangeLog: boolean;
  includeInternalNotes: boolean;
  includeAgentHistory: boolean;
}

export interface ReportIssue {
  code: string;
  message: string;
}

export interface ReportHealth {
  score: number;
  label: "On track" | "Needs attention" | "At risk";
  coveragePct: number;
  groundingPct: number;
  timelinessPct: number;
  totalNodes: number;
  ownedNodes: number;
  totalGates: number;
  groundedGates: number;
  overdueNodes: number;
}

export interface ReportCounts {
  nodes: number;
  actions: number;
  decisions: number;
  gates: number;
  milestones: number;
  risks: number;
  artifacts: number;
}

export interface ReportLogoDescriptor {
  available: boolean;
  supported: boolean;
  contentType: string | null;
  /** Intentionally omitted today: the private asset is read server-side. */
  url?: string;
  objectKey: string | null;
}

export interface ReportPreflight {
  report: {
    strategyId: string;
    title: string;
    type: string;
    ready: boolean;
    asOf: string;
    formats: ReportFormat[];
  };
  client: { id: string; name: string };
  version: { id: string | null; createdAt: string | null; note: string | null };
  health: ReportHealth;
  counts: ReportCounts;
  logo: Omit<ReportLogoDescriptor, "objectKey">;
  warnings: ReportIssue[];
  errors: ReportIssue[];
}

export interface ReportProvenanceSource {
  section: string;
  ref: string | null;
}

export interface ReportNode {
  id: string;
  kind: ReportNodeKind;
  subject: string;
  title: string;
  note: string | null;
  ownerAssigned: boolean;
  ownerName: string;
  status: string;
  startsOn: string;
  endsOn: string | null;
  openEnded: boolean;
  dependsOnIds: string[];
  sources: ReportProvenanceSource[];
  /** Source count before the bounded renderer sample is applied. */
  sourceCount?: number;
  targetLabel: string | null;
}

export interface ReportArtifact {
  nodeId: string;
  artifactType: string;
  artifactRef: string;
}

export interface ReportVersionEntry {
  id: string;
  note: string;
  authorKind: string;
  createdAt: string;
}

export interface ReportAgentRun {
  state: string;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  waitingReason: string | null;
}

export interface ReportChangeSet {
  summary: string;
  risk: string;
  status: string;
  createdAt: string;
  appliedAt: string | null;
}

export interface ExecutiveReportSnapshot {
  snapshotHash: string;
  asOf: string;
  strategy: {
    id: string;
    title: string;
    type: string;
    goal: string | null;
    summary: string | null;
    targetDate: string | null;
    ownerName: string;
    lastEditedAt: string | null;
  };
  client: {
    id: string;
    name: string;
    logo: ReportLogoDescriptor;
  };
  version: { id: string | null; createdAt: string | null; note: string | null };
  health: ReportHealth;
  counts: ReportCounts;
  nodes: ReportNode[];
  artifacts: ReportArtifact[];
  firmPhases: Array<{
    label: string;
    startFy: number;
    startQ: number;
    endFy: number;
    endQ: number;
  }>;
  referenceWindows: Array<{
    kind: string;
    label: string;
    startsOn: string | null;
    endsOn: string | null;
    fy: number | null;
  }>;
  context: {
    activeDocuments: number;
    staleDocuments: number;
    openMaterialConflicts: number;
  };
  activity: {
    versions: ReportVersionEntry[];
    agentRuns: ReportAgentRun[];
    changeSets: ReportChangeSet[];
  };
  options: NormalizedReportOptions;
  warnings: ReportIssue[];
  /** Fatal size-policy failures; renderers must never receive this snapshot. */
  capacityErrors: ReportIssue[];
}

export interface ClientLogoAsset {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg";
  dimensions?: { width: number; height: number };
}

export interface RenderedExecutiveReport {
  bytes: Buffer;
  contentType: string;
  extension: ReportFormat;
}
