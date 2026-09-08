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
  /** Ask the orchestrator for grounded executive prose (falls back to facts). */
  includeNarrative: boolean;
  /** Profile congressional member offices referenced by included plan steps. */
  includeMemberProfiles: boolean;
}

export interface ReportIssue {
  code: string;
  message: string;
}

export interface ReportHealth {
  score: number;
  label: "On track" | "Needs attention" | "At risk" | "No steps";
  coveragePct: number;
  groundingPct: number | null;
  timelinessPct: number | null;
  totalNodes: number;
  ownedNodes: number;
  totalGates: number;
  groundedGates: number;
  datedNodes: number;
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
  memberOffices: ReportMemberOfficeSummary;
  narrative: ReportNarrativeSummary;
  warnings: ReportIssue[];
  errors: ReportIssue[];
}

export interface ReportProvenanceSource {
  section: string;
  ref: string | null;
  /** Resolved against an audience-eligible context fact. */
  resolved?: boolean;
}

/**
 * The stored `targetRef` snapshot on a plan step, reduced to the fields a
 * report may use. `memberId` is a directory contact id and is never rendered;
 * it keys the member-office lookup and the embedded photo.
 */
export interface ReportMemberRef {
  memberId: string;
  memberName: string | null;
  party: string | null;
  state: string | null;
  chamber: string | null;
  committee: string | null;
  sourceDirectory: "congress" | "state" | "staff" | null;
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
  memberRef?: ReportMemberRef | null;
}

/** One congressional office referenced by included plan steps (from stored targetRefs). */
export interface ReportMemberProfile extends ReportMemberRef {
  /** Display name, falling back to the stored target label. */
  name: string;
  /** Included plan steps that target this office, in plan order. */
  nodeIds: string[];
}

export interface ReportMemberOfficeAddress {
  label: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  fax: string | null;
}

/**
 * Directory-resolved detail for a member office. Fetched at export time from
 * the Directory service (not part of the snapshot hash: it is public-record
 * reference data, not strategy content the user edits).
 */
export interface ReportMemberDetail {
  memberId: string;
  name: string;
  party: string | null;
  state: string | null;
  chamber: string | null;
  district: string | null;
  committees: string[];
  washingtonOffice: ReportMemberOfficeAddress | null;
  photoUrl: string | null;
  photoSource: string | null;
  /** True when the Directory returned a record; false when only targetRef data is known. */
  resolved: boolean;
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
  /** Member offices referenced by included nodes; empty when profiles are off. */
  members: ReportMemberProfile[];
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

/** A sanitized raster asset; the same contract the client logo uses. */
export type ReportRasterAsset = ClientLogoAsset;

/**
 * Export-time material that is NOT part of the hashed snapshot: generated
 * prose (already verified), Directory member detail, and fetched photo bytes.
 * Renderers must degrade gracefully when any of it is absent.
 */
export interface ReportRenderExtras {
  narrative?: import("./report-narrative.types.js").VerifiedReportNarrative | null;
  memberDetails?: ReportMemberDetail[];
  memberPhotos?: ReadonlyMap<string, ReportRasterAsset>;
}

export interface ReportMemberOfficeSummary {
  /** Distinct member offices referenced by included plan steps. */
  referenced: number;
  /** Offices the Directory resolved (name, party, Washington office). */
  resolved: number;
  /** Resolved offices with an embeddable portrait. */
  withPhoto: number;
}

export interface ReportNarrativeSummary {
  /** Whether the server can generate grounded prose for this request. */
  available: boolean;
  /** Why it is unavailable (feature disabled, orchestrator unconfigured...). */
  reason: string | null;
  /** Whether the caller asked for prose. */
  requested: boolean;
}

export interface RenderedExecutiveReport {
  bytes: Buffer;
  contentType: string;
  extension: ReportFormat;
}
