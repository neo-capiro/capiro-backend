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

export interface ReportInclusion {
  /** Every live node before audience and quality filtering. */
  liveNodes: number;
  includedNodes: number;
  omittedNodes: number;
  includedByStatus: Record<string, number>;
  omittedByStatus: Record<string, number>;
  placeholderNodes: number;
}

export type ReportNarrativeSectionKey =
  | "situation"
  | "outcomes"
  | "ask"
  | "stakeholders"
  | "constraints"
  | "timing"
  | "evidence"
  | "decisions"
  | "intelligence"
  | "governance";

export interface ReportNarrativeItem {
  text: string;
  label: string | null;
  sourceTitle: string;
  sourceRef: string | null;
  authority: string | null;
  asOf: string | null;
  confidence: number | null;
}

export interface ReportNarrativeSection {
  key: ReportNarrativeSectionKey;
  title: string;
  items: ReportNarrativeItem[];
}

export interface ReportContextDocument {
  id: string;
  title: string;
  templateKey: string;
  authority: string | null;
  confidentiality: string | null;
  asOf: string | null;
  validUntil: string | null;
  updatedAt: string;
  highlightCount: number;
}

export interface ReportContextFact {
  id: string;
  text: string;
  documentTitle: string;
  templateKey: string;
  sourceRef: string;
  authority: string | null;
  asOf: string | null;
  confidence: number | null;
}

export interface ReportSectionReadiness {
  id:
    | "summary"
    | "context"
    | "priorities"
    | "decisions_risks"
    | "roadmap"
    | "accountability"
    | "evidence";
  label: string;
  state: "ready" | "thin" | "empty" | "excluded";
  availableCount: number;
  message: string;
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
    audience: ReportAudience;
    format: ReportFormat;
    snapshotHash: string;
    readiness: "ready" | "review" | "blocked";
  };
  client: { id: string; name: string };
  version: { id: string | null; createdAt: string | null; note: string | null };
  health: ReportHealth;
  allLiveHealth: ReportHealth;
  counts: ReportCounts;
  inclusion: ReportInclusion;
  content: {
    contextDocuments: number;
    excludedContextDocuments: number;
    narrativeSections: number;
    narrativeItems: number;
    contextFacts: number;
    evidenceLinkedNodes: number;
  };
  sections: ReportSectionReadiness[];
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
    profile?: {
      description: string | null;
      productDescription: string | null;
      profileType: string | null;
      sectorTag: string | null;
      website: string | null;
    };
  };
  version: { id: string | null; createdAt: string | null; note: string | null };
  health: ReportHealth;
  allLiveHealth: ReportHealth;
  counts: ReportCounts;
  inclusion: ReportInclusion;
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
    includedDocuments: number;
    excludedDocuments: number;
    staleDocuments: number;
    openMaterialConflicts: number;
    documents: ReportContextDocument[];
    facts: ReportContextFact[];
    sections: ReportNarrativeSection[];
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
