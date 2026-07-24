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

/**
 * A8/E: whether Meri's Client Context Pack was complete for the last
 * draft/assist. Stage E upgrades it from section-presence to fact-level
 * health: an unresolved MATERIAL Steward conflict ⇒ status 'conflicted' and
 * `openMaterialConflicts` names the two disagreeing facts verbatim (the
 * editor banner renders factA vs factB). Annotate-only — never blocks.
 */
export interface GroundingHealth {
  status: 'ok' | 'degraded' | 'conflicted';
  missingRequired: string[];
  omittedOptional: string[];
  openMaterialConflicts?: OpenMaterialConflict[];
}

/** One open material Steward conflict carried on stewardHealth/groundingHealth. */
export interface OpenMaterialConflict {
  id: string;
  factAId: string;
  factBId: string;
  factA: string;
  factB: string;
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

/*
 * ---- Stage E: the Context Steward (/strategy-api/context/{facts,conflicts,health}) ----
 * Mirrors sp_context_fact / sp_context_conflict. The Steward NEVER mutates
 * strategy nodes — these are review-surface reads plus fact-reject /
 * conflict-resolve / conflict-dismiss writes on the sp_context_* tables only.
 */

export type ContextFactState = 'active' | 'superseded' | 'stale' | 'rejected';

/** One structured fact the Steward extracted from a context document. */
export interface ContextFact {
  id: string;
  documentId: string;
  clientId: string | null;
  fact: string;
  /** Stage D closed-set anchor: 'heading:<text>' or 'row:<heading>:<n>'. */
  sourceRef: string;
  authority: string | null;
  asOf: string | null; // ISO date
  confidence: number | null; // 0–1 extraction confidence
  state: ContextFactState;
  /** Verbatim source snippet. */
  citation: string | null;
  /** Denormalized source-document display fields (when the API provides them). */
  documentTitle: string | null;
  templateKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ContextConflictState = 'open' | 'resolved' | 'dismissed';

/** The embedded fact view a conflict row carries for side-by-side display. */
export interface ContextConflictFact {
  id: string;
  fact: string;
  documentTitle: string | null;
  authority: string | null;
  asOf: string | null;
  clientId: string | null;
}

/** Two facts in material disagreement (sp_context_conflict). */
export interface ContextConflict {
  id: string;
  factAId: string;
  factBId: string;
  /** Derived from the facts server-side (conflict rows carry no client column). */
  clientId: string | null;
  material: boolean;
  state: ContextConflictState;
  resolutionNote: string | null;
  factA: ContextConflictFact | null;
  factB: ContextConflictFact | null;
  createdAt: string;
}

/** GET /context/health?clientId=… — per-client Steward context health. */
export interface ContextHealth {
  status: 'ok' | 'degraded' | 'conflicted';
  /** Missing REQUIRED template keys/names for this client. */
  missingRequired: string[];
  /** Count of stale source documents still in rotation. */
  staleDocuments: number;
  openMaterialConflicts: OpenMaterialConflict[];
}

/** POST /context/documents/:id/extract — Steward extraction result. */
export interface ExtractFactsResult {
  inserted: number;
  /** COUNT of model-cited refs that could not be located in the source (dropped, never persisted). */
  droppedRefs: number;
  conflicts: number;
  summary: string | null;
}

/** POST /context/conflicts/:id/resolve — pick the controlling fact + why. */
export interface ResolveConflictInput {
  controllingFactId: string;
  note: string;
}

/*
 * ---- Stage F: the agent surface (/strategy-api/agents/*) ----
 * Mirrors sp_change_set / sp_agent_mission / sp_agent_run. ChangeSet ops reuse
 * the Meri assistant PlanEdit shape and are re-validated server-side on apply
 * (the web renders them read-only as a diff). Rows arrive via the tolerant
 * normalizers in agents/agent-utils.ts.
 */

export type ChangeSetRisk = 'low' | 'medium' | 'high' | 'critical';
export type ChangeSetStatus =
  | 'proposed'
  | 'approved'
  | 'applied'
  | 'rejected'
  | 'stale'
  | 'undone';

/** One proposed edit (the Meri assistant PlanEdit shape, rendered read-only). */
export interface ChangeSetOp {
  op: 'add' | 'update' | 'remove' | 'retime' | string;
  nodeId?: string;
  kind?: string;
  subject?: string;
  title?: string;
  note?: string | null;
  status?: string | null;
  ownerUserId?: string | null;
  startsOn?: string;
  endsOn?: string | null;
  openEnded?: boolean;
  dependsOn?: string[];
  sources?: Array<{ section: string; ref?: string }>;
}

/** sp_change_set — a Watcher (or person) proposed edit-set awaiting review. */
export interface ChangeSet {
  id: string;
  strategyId: string;
  runId: string | null;
  summary: string;
  ops: ChangeSetOp[];
  /** Selective-approval subset (what apply replays); null = all ops. */
  approvedOps: ChangeSetOp[] | null;
  risk: ChangeSetRisk;
  status: ChangeSetStatus;
  strategyVersionId: string;
  appliedVersionId: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  rejectedByUserId: string | null;
  rejectedAt: string | null;
  appliedByUserId: string | null;
  appliedAt: string | null;
  undoneByUserId: string | null;
  undoneAt: string | null;
  /** null ⇒ Watcher/system proposal. */
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MissionState = 'draft' | 'active' | 'paused' | 'completed' | 'failed' | 'canceled';
export type RunState =
  | 'queued'
  | 'planning'
  | 'waiting_for_input'
  | 'executing'
  | 'ready_for_review'
  | 'completed'
  | 'failed'
  | 'canceled';

/** sp_agent_mission — a standing mission ("Keep this strategy on track"). */
export interface AgentMission {
  id: string;
  strategyId: string | null;
  clientId: string | null;
  name: string;
  description: string | null;
  state: MissionState;
  cadence: 'daily' | 'weekly' | null;
  nextRunAt: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** sp_agent_run — one execution of a mission. findings is raw JSON (see extractRunFindings). */
export interface AgentRun {
  id: string;
  missionId: string;
  strategyId: string | null;
  state: RunState;
  trigger: 'manual' | 'scheduled' | 'event' | string;
  findings: Record<string, unknown> | null;
  waitingReason: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** One display-ready finding flattened out of a run's findings JSON. */
export interface RunFinding {
  code: string | null;
  severity: 'error' | 'warning' | 'info';
  message: string;
  suggestion?: string;
  nodeIds?: string[];
}

/** POST /agents/missions — create a standing mission (starts draft; PATCH to activate). */
export interface CreateMissionInput {
  strategyId?: string;
  clientId?: string;
  name: string;
  description?: string;
  cadence?: 'daily' | 'weekly';
}

/** PATCH /agents/missions/:id — state moves go through MISSION_TRANSITIONS server-side. */
export interface UpdateMissionInput {
  state?: MissionState;
  name?: string;
  description?: string | null;
  cadence?: 'daily' | 'weekly' | null;
  nextRunAt?: string | null;
}

/** POST /agents/change-sets/:id/approve — opIndexes selects a SUBSET of ops (omit = all). */
export interface ApproveChangeSetInput {
  opIndexes?: number[];
}

/** POST /agents/missions/:id/run-check — normalized result (tolerant of shape). */
export interface RunCheckResult {
  run: AgentRun | null;
  findings: RunFinding[];
  /** ChangeSets the check proposed (ids), when the API reports them. */
  changeSetIds: string[];
}

/*
 * ---- Stage G: the Execution Agent (/strategy-api/agents/execution/*) ----
 * The Execution Agent STAGES artifacts (Workspace drafts / Outreach records)
 * and DRAFTS outreach sends against a plan node, then parks for human review.
 * It is an sp_agent_run whose findings JSON carries the planned/staged TASKS
 * (and, for a task awaiting send approval, the staged outreach preview). Rows
 * arrive via the tolerant normalizers in agents/agent-utils.ts.
 *
 * SAFETY (plan §G, non-negotiable): the actual EXTERNAL SEND is HARD-DISABLED
 * until Stage H security evals — the backend gates it behind an env that does
 * not exist yet (STRATEGY_EXECUTION_SEND_ENABLED) and the web mirrors that: the
 * send-approval control is fully wired but INERT. No autonomous external
 * contact happens in Stage G.
 */

/** The three task kinds the Execution Agent plans/stages. */
export type ExecutionTaskType = 'workspace_draft' | 'outreach_record' | 'await_send_approval';

/**
 * A task's lifecycle within a run. `planned` = in the reviewed plan, not yet
 * acted on; `staged` = the artifact (WsDraft/OutreachRecord) was created;
 * `awaiting_approval` = an await_send_approval task parked for the send gate;
 * `blocked` = could not proceed (see blockedReason); `done`/`skipped` terminal.
 */
export type ExecutionTaskStatus =
  | 'planned'
  | 'staged'
  | 'awaiting_approval'
  | 'blocked'
  | 'done'
  | 'skipped';

/**
 * The staged outreach preview an await_send_approval task carries — echoed for
 * review, NEVER sent in Stage G. The approval binds to `contentHash`; a later
 * edit changes the hash so any prior approval (`approvedContentHash`) no longer
 * matches and is invalidated. `approvalToken` is the (inert) resume token.
 */
export interface SendApprovalPreview {
  subject: string | null;
  /** The staged body the send would carry (rendered as text — never as HTML). */
  body: string | null;
  recipients: string[];
  /** The ask being made of the recipients. */
  ask: string | null;
  /** The intended send window (e.g. a date range or "this week"). */
  window: string | null;
  /** Resume/approval token — wired for Stage H, inert in Stage G. */
  approvalToken: string | null;
  /** Hash the current staged content reduces to. */
  contentHash: string | null;
  /** Hash a prior approval was bound to; !== contentHash ⇒ that approval is stale. */
  approvedContentHash: string | null;
}

/** One planned/staged task off a run's findings JSON. */
export interface ExecutionTask {
  /** Stable id within the run (server-assigned; falls back to the array index). */
  id: string;
  type: ExecutionTaskType;
  nodeId: string | null;
  title: string;
  status: ExecutionTaskStatus;
  /** Created artifact ref (WsDraft id / OutreachRecord id) once staged. */
  artifactRef: string | null;
  /** Precise, human-readable reason a task is blocked (never a generic error). */
  blockedReason: string | null;
  /** Present only for await_send_approval tasks. */
  send: SendApprovalPreview | null;
}

/** sp_agent_run projected for the Execution surface (findings carry the tasks). */
export interface ExecutionRun {
  id: string;
  missionId: string;
  strategyId: string | null;
  state: RunState;
  trigger: string;
  /** The waiting_for_input reason verbatim — the blocked-state copy. */
  waitingReason: string | null;
  error: string | null;
  summary: string | null;
  tasks: ExecutionTask[];
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/**
 * POST /agents/execution/plan — stage a node's execution plan for review.
 * Mirrors the server ExecutionPlanDto: a run belongs to an ACTIVE mission
 * (missionId anchors it), strategyId is the optional override the editor always
 * supplies, and kind selects the artifact (Workspace draft / staged — unsent —
 * outreach). The UI-facing 'workspace_draft'|'outreach_record' intent is mapped
 * to this 'workspace'|'outreach' kind at the call site.
 */
export interface PlanExecutionInput {
  missionId: string;
  strategyId?: string;
  nodeId: string;
  kind: 'workspace' | 'outreach';
}

/** POST /agents/execution/runs/:id/resume — carries the (inert) send-approval token. */
export interface ResumeRunInput {
  approvalToken?: string;
}
