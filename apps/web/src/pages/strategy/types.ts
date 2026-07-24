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

/** A9: per-node grounding — the pack section(s) a Meri-authored node cites. */
export interface NodeProvenance {
  sources?: Array<{ section: string; ref?: string }>;
}

/** A4/A6: a realism finding from the shared strategy verifier. */
export interface Violation {
  code: string;
  severity: 'error' | 'warning';
  nodeIds: string[];
  message: string;
  suggestion?: string;
}

/** A8: whether Meri's Client Context Pack was complete for the last draft/assist. */
export interface GroundingHealth {
  status: 'ok' | 'degraded';
  missingRequired: string[];
  omittedOptional: string[];
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
  dependsOnIds: string[]; // A2/A3: sibling steps that must complete first
  provenance: NodeProvenance | null; // A9
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
  meriSummary: string | null;
  draftedByMeri: boolean;
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
  /** A6: verifier findings from the last draft/assist (transient — recomputed per Meri call). */
  violations?: Violation[];
  /** A8: grounding health from the last Meri draft/assist. */
  groundingHealth?: GroundingHealth | null;
}

export interface FirmPhase {
  id: string;
  label: string;
  startFy: number;
  startQ: number;
  endFy: number;
  endQ: number;
  position: number;
  updatedByUserId?: string | null;
  updatedAt?: string | null;
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

export interface StrategyVersion {
  id: string;
  authorKind: 'person' | 'meri';
  authorUserId: string | null;
  note: string;
  restoredFromVersionId: string | null;
  createdAt: string;
}

export interface VersionsPage {
  items: StrategyVersion[];
  nextCursor: string | null;
}

/** Manual node create (SHL-7). meriAuthored is server-set (never client). */
export interface CreateNodeInput {
  kind: NodeKind;
  subject: NodeSubject;
  title: string;
  note?: string | null;
  ownerUserId?: string | null;
  status?: NodeStatus;
  startsOn: string; // YYYY-MM-DD
  endsOn?: string | null;
  openEnded?: boolean;
}

/** Partial node update (NOD-5/7, TLN-12). changeNote = version/flash label. */
export interface UpdateNodeInput {
  kind?: NodeKind;
  subject?: NodeSubject;
  title?: string;
  note?: string | null;
  ownerUserId?: string | null;
  status?: NodeStatus;
  startsOn?: string;
  endsOn?: string | null;
  openEnded?: boolean;
  changeNote?: string;
}

/** POST /strategies/:id/nodes/:nodeId/artifacts — node→Capiro back-link (RTE-3). */
export interface RecordArtifactInput {
  artifactType: ArtifactType;
  artifactRef: string;
}

/** PUT /firm-phases row (PHS-4). endFy/endQ are the EXCLUSIVE end boundary. */
export interface FirmPhaseInput {
  label: string;
  startFy: number;
  startQ: number;
  endFy: number;
  endQ: number;
}

/** PUT /reference-calendars/:kind row (REF-5). Congress = dates; PPBE = fy. */
export interface ReferenceForkRow {
  label: string;
  startsOn?: string | null;
  endsOn?: string | null;
  fy?: number | null;
  tone?: string | null;
}

/** POST /strategies/draft — AI create from goal (+ optional docs). CRT-11/12. */
export interface DraftStrategyInput {
  clientId: string;
  type: StrategyType;
  goal?: string;
  meriContext?: string;
  ownerUserId?: string;
  targetDate?: string;
  attachmentIds?: string[];
}

/** POST /strategies/:id/assistant — rail edit engine (NOD-4 / MRI-3). */
export interface AssistantInput {
  scope: 'node' | 'strategy';
  nodeId?: string;
  instruction: string;
  attachmentIds?: string[];
}

export interface AssistantResponse {
  reply: string;
  summary: string | null;
  strategy: StrategyDetail;
}

export interface PatchStrategyInput {
  title?: string;
  type?: StrategyType;
  goal?: string | null;
  meriContext?: string | null;
  targetDate?: string | null;
  ownerUserId?: string;
  changeNote?: string;
}

/*
 * ---- Stage D: context documents (/strategy-api/context/*) ----
 * Mirrors sp_context_document. Frontmatter is the parsed + validated YAML
 * front-matter block (flat `key: value` scalars only — the Stage D grammar).
 */

export type ContextScope = 'once' | 'node' | 'strategy' | 'client' | 'firm';
export type ContextDocState = 'draft' | 'active' | 'superseded' | 'archived';

/** Flat scalar map — the Stage D front-matter grammar has no nesting. */
export type ContextFrontmatter = Record<string, string | number | boolean | null>;

export interface ContextDocumentListItem {
  id: string;
  clientId: string | null;
  scope: ContextScope;
  scopeRef: string | null;
  /** Pack template id, e.g. "01_strategy_brief" (00–13 contract). */
  templateKey: string;
  title: string;
  state: ContextDocState;
  frontmatter: ContextFrontmatter | null;
  checksum: string;
  supersedesId: string | null;
  validUntil: string | null; // ISO date — staleness horizon
  createdByUserId: string;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContextDocumentDetail extends ContextDocumentListItem {
  /** Raw markdown body (front-matter lives in `frontmatter`). */
  content: string;
}

/** POST /context/documents — raw markdown incl. its front-matter block. */
export interface UploadContextDocumentInput {
  content: string;
  clientId?: string | null;
}

/** One field-level validation error from the upload 400 body. */
export interface ContextFieldError {
  field: string;
  message: string;
}

/** GET /context/documents/:id/sections — one heading/row anchor. */
export interface ContextSection {
  /** Stable anchor to hand back to GET .../locate?ref=… */
  ref: string;
  heading: string;
  level: number;
  /** 1-based line of the heading inside `content` (when the API provides it). */
  line: number | null;
}

/** GET /context/documents/:id/locate?ref=… — exact source lines (no LLM). */
export interface ContextLocateResult {
  ref: string;
  /** 1-based inclusive line range inside `content`. */
  startLine: number | null;
  endLine: number | null;
  /** The exact source lines, when the API echoes them. */
  lines: string[] | null;
}
