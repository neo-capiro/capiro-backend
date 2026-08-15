/**
 * Workspace Document Agent vNext — Type definitions.
 * Mirrors the backend contract from PR #922 / docs/workspace-document-agent-api.md.
 * These types are the frontend's source of truth for the agent state shape.
 */

// ── Agent State ────────────────────────────────────────────────────────────

export type AgentPhase =
  | 'type'
  | 'blueprint'
  | 'design'
  | 'goal'
  | 'brief'
  | 'context'
  | 'outline'
  | 'generate'
  | 'draft'
  | 'quality'
  | 'complete';

export type AgentStatus =
  | 'active'
  | 'needs_input'
  | 'ready'
  | 'generating'
  | 'partial'
  | 'failed'
  | 'complete';

export type Provenance = 'user' | 'retrieved' | 'suggested' | 'assumed';

export type GenerationMode = 'quick' | 'standard' | 'max';

export type RunStatus =
  | 'active'
  | 'complete'
  | 'complete_with_warnings'
  | 'partial'
  | 'failed';

export type StageStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export type StageName =
  | 'preflight'
  | 'evidence_plan'
  | 'narrative_plan'
  | 'drafting'
  | 'editorial_pass'
  | 'assurance'
  | 'snapshot'
  | 'complete';

export interface DocumentType {
  id: string;
  label: string;
  product: string;
}

export interface BlueprintPin {
  blueprintId: string;
  versionId: string;
  version: number;
  definitionHash: string;
}

export interface ThemeSettings {
  paperColor?: string;
  headingFont?: string;
  bodyFont?: string;
  margins?: string;
  pageSize?: 'letter' | 'a4';
  markPlacement?: 'left' | 'centered' | 'none';
  headerRule?: 'full' | 'none';
  coverPage?: boolean;
  signatureBlock?: boolean;
  evidenceAppendix?: boolean;
  pageNumbers?: boolean;
  letterheadFirstPageOnly?: boolean;
  [key: string]: unknown;
}

export interface AgentTheme {
  id: string;
  name: string;
  version?: number;
  settings: ThemeSettings;
}

export interface AgentGoal {
  text: string;
  client?: string;
  createdAt?: string;
}

export interface AgentAssumption {
  id: string;
  text: string;
  status: 'open' | 'confirmed' | 'rejected';
}

export interface AgentBrief {
  objective?: string;
  audience?: string;
  desiredAction?: string;
  subject?: string;
  centralArgument?: string;
  evidenceInstructions?: string;
  tone?: string;
  targetPages?: number;
  deadline?: string;
  assumptions: AgentAssumption[];
  provenance: Record<string, Provenance>;
  approvedAt?: string | null;
  approvedBy?: string | null;
}

export interface ContextCoverage {
  plannedClaims: number;
  supportedClaims: number;
  missingClaims: Array<{
    claimId: string;
    description: string;
    recommendedSourceTypes: string[];
  }>;
}

export type ConflictType =
  | 'numeric'
  | 'date'
  | 'status'
  | 'authority'
  | 'freshness'
  | 'semantic';

export interface ContextConflict {
  id: string;
  itemIds: string[];
  type: ConflictType;
  description: string;
  recommendedResolution: string;
  resolved: boolean;
  resolution?: string | null;
}

export interface ContextPlan {
  includedItemIds: string[];
  excludedItems: Array<{ itemId: string; reason: string }>;
  conflicts: ContextConflict[];
  coverage: ContextCoverage;
  snapshotHash?: string;
  approvedAt?: string | null;
  approvedBy?: string | null;
}

export interface OutlineSection {
  id: string;
  title: string;
  purpose: string;
  instructions: string;
  required: boolean;
  locked: boolean;
  targetWords: { min: number; max: number };
  evidenceItemIds: string[];
}

export interface AgentOutline {
  version: number;
  sections: OutlineSection[];
  approvedAt?: string | null;
  approvedBy?: string | null;
}

export interface GenerationStage {
  name: StageName;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  detail?: string;
}

export interface SectionResult {
  succeeded?: string[];
  failed?: string[];
  stale?: string[];
}

export interface GenerationRun {
  runId?: string;
  mode: GenerationMode;
  activeRunId?: string;
  startedAt?: string;
  completedAt?: string;
  status: RunStatus;
  stages: GenerationStage[];
  sectionResults?: Record<string, 'succeeded' | 'failed' | 'stale'>;
  lastRun?: {
    runId: string;
    mode: GenerationMode;
    status: RunStatus;
    startedAt: string;
    completedAt?: string;
  };
}

export interface AgentQualitySummary {
  score: number | null;
  evaluatedAt?: string;
  blockers: string[];
  recommendations: string[];
}

export interface AgentState {
  schemaVersion: number;
  revision: number;
  phase: AgentPhase;
  status: AgentStatus;
  documentType: DocumentType;
  blueprintPin: BlueprintPin;
  theme: AgentTheme;
  goal: AgentGoal;
  brief: AgentBrief;
  contextPlan: ContextPlan;
  outline: AgentOutline;
  generation: { mode: GenerationMode; activeRunId?: string; lastRun?: GenerationRun['lastRun'] };
  quality: AgentQualitySummary;
  pendingProposalId?: string | null;
}

export interface AgentStateResponse {
  state: AgentState;
}

// ── Messages ──────────────────────────────────────────────────────────────

export interface AgentMessage {
  id: string;
  role: 'agent' | 'user';
  text: string;
  createdAt: string;
  phase?: string;
  questions?: AgentQuestion[];
  proposalId?: string;
  allowedActions?: string[];
  status?: 'applied' | 'needs_resolution' | 'sent';
}

export interface AgentQuestion {
  id: string;
  label: string;
  required?: boolean;
}

export interface SendMessageScope {
  kind: 'whole_document' | 'selection';
  documentId?: string;
  sectionId?: string;
  quote?: string;
  start?: number;
  end?: number;
}

export interface SendMessageRequest {
  text: string;
  phase: string;
  expectedRevision: number;
  idempotencyKey?: string;
  scope?: SendMessageScope;
}

export interface SendMessageResponse {
  message: string;
  phase: string;
  revision: number;
  questions?: AgentQuestion[];
  stateSummary?: Partial<AgentState>;
  proposal?: { proposalId: string; type: string } | null;
  allowedActions?: string[];
}

// ── Proposals ──────────────────────────────────────────────────────────────

export type ProposalType =
  | 'outline_revision'
  | 'quality_fix'
  | 'selected_text_revision'
  | 'document_revision';

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export interface ProposalPayload {
  type: ProposalType;
  before?: unknown;
  after?: unknown;
  affectedSections?: string[];
  lockedSectionsTouched?: string[];
  diff?: string;
  [key: string]: unknown;
}

export interface AgentProposal {
  id: string;
  type: ProposalType;
  status: ProposalStatus;
  baseRevision: number;
  baseHash: string;
  payload: ProposalPayload;
  createdAt: string;
}

// ── Quality ────────────────────────────────────────────────────────────────

export type CheckStatus = 'success' | 'warning' | 'error' | 'info';
export type CheckSeverity = 'low' | 'medium' | 'high';

export interface QualityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fixable: boolean;
  severity: CheckSeverity;
}

export interface QualityResponse {
  score: number | null;
  readiness: string;
  blockers: string[];
  recommendations: string[];
  checks: QualityCheck[];
}

// ── Generation ─────────────────────────────────────────────────────────────

export interface GenerationStatusResponse {
  runId: string;
  mode: GenerationMode;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  stages: GenerationStage[];
  sectionResults?: Record<string, 'succeeded' | 'failed' | 'stale'>;
}

// ── Context Items ───────────────────────────────────────────────────────────

export interface ContextItem {
  id: string;
  label: string;
  sourceType?: string;
  authority?: string;
  freshness?: string;
  verification?: string;
  url?: string;
  included: boolean;
  exclusionReason?: string;
  payload?: Record<string, unknown>;
}

// ── Drafts ──────────────────────────────────────────────────────────────────

export interface DraftSummary {
  id: string;
  docTitle: string;
  documentType?: string;
  sector?: string;
  clientName?: string;
  phase?: string;
  status?: string;
  qualityScore?: number | null;
  updatedAt: string;
  lockedBy?: string | null;
  lockHeldAt?: string | null;
  config?: Record<string, unknown>;
}

export interface DraftDocument {
  id: string;
  title: string;
  body: string;
  order?: number;
}

export interface Draft {
  id: string;
  docTitle: string;
  sector?: string;
  clientName?: string;
  config: Record<string, unknown>;
  documents: DraftDocument[];
  createdAt: string;
  updatedAt: string;
}

// ── Blueprint / Template Studio ─────────────────────────────────────────────

export type BlueprintVersionStatus = 'draft' | 'published' | 'retired';

export interface BlueprintSummary {
  blueprintId: string;
  name: string;
  description?: string;
  scope: 'firm' | 'capiro_global';
  documentType?: string;
  status?: string;
  pinnedDocCount?: number;
  updatedAt?: string;
  versions?: BlueprintVersionSummary[];
}

export interface BlueprintVersionSummary {
  versionId: string;
  version: number;
  status: BlueprintVersionStatus;
  definitionHash?: string;
  updatedAt: string;
}

export interface BlueprintVersion {
  versionId: string;
  version: number;
  status: BlueprintVersionStatus;
  definitionHash?: string;
  definition: BlueprintDefinition;
  updatedAt: string;
}

export interface BlueprintDefinition {
  documentType?: string;
  intakeQuestions?: IntakeQuestion[];
  sections?: BlueprintSection[];
  evidencePolicy?: EvidencePolicy;
  contentRules?: Record<string, unknown>;
  approvalPolicy?: ApprovalPolicy;
  defaultTheme?: { id: string; name: string; settings?: ThemeSettings };
}

export interface IntakeQuestion {
  id: string;
  label: string;
  required?: boolean;
  answerSource?: 'user' | 'client_profile' | 'context' | 'meri_recommendation';
  condition?: { field: string; operator: string; value: unknown };
}

export interface BlueprintSection {
  id: string;
  title: string;
  required: boolean;
  removable: boolean;
  reorderable: boolean;
  lockedByDefault: boolean;
  targetWords?: { min: number; max: number };
  evidenceRules?: unknown[];
  purpose?: string;
  instructions?: string;
}

export interface EvidencePolicy {
  minimumSources?: number;
  primarySourcesPreferred?: boolean;
  citationRequiredFor?: string[];
  freshnessRules?: unknown[];
}

export interface ApprovalPolicy {
  clientFacingApprovalRequired: boolean;
  permittedApproverRoles: string[];
}

// ── Delivery ───────────────────────────────────────────────────────────────

export interface PreflightResponse {
  requiresApproval: boolean;
  approvalPolicy: {
    clientFacingApprovalRequired: boolean;
    permittedApproverRoles: string[];
  };
  isStale: boolean;
}

export interface ShareLinkResponse {
  shareId: string;
  token: string;
  expiresAt: string | null;
}

export interface PublicShareDocument {
  docTitle: string;
  body: string;
  documentType?: string;
  expiresAt?: string;
  sections?: Array<{ title: string; body: string }>;
  theme?: AgentTheme;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type AgentErrorCode =
  | 'DOCUMENT_AGENT_REVISION_CONFLICT'
  | 'PROPOSAL_STALE'
  | 'BLUEPRINT_IMMUTABLE'
  | 'PREFLIGHT_FAILED'
  | 'REASONING_UNAVAILABLE';

export interface AgentError {
  statusCode: number;
  message: string;
  code: AgentErrorCode | string;
}

// ── Recommendation ─────────────────────────────────────────────────────────

export interface RecommendResponse {
  documentType: DocumentType;
  recommendedBlueprints: Array<{
    blueprintId: string;
    name: string;
    slug?: string;
    versionId?: string;
    version?: number;
    definitionHash?: string;
  }>;
  recommendedTheme: { id: string; name: string };
  questions: AgentQuestion[];
  rationale: string;
}

// ── Catalog ─────────────────────────────────────────────────────────────────

export interface CatalogResponse {
  documentTypes: DocumentType[];
}

// ── Comments ────────────────────────────────────────────────────────────────

export interface WorkspaceComment {
  id: string;
  documentId: string;
  authorName: string;
  authorId?: string;
  text: string;
  createdAt: string;
  resolved?: boolean;
  parentId?: string | null;
  isGuest?: boolean;
  replies?: WorkspaceComment[];
}

// ── Collaborators ──────────────────────────────────────────────────────────

export interface Collaborator {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'editor' | 'reviewer' | 'viewer';
  status: 'pending' | 'accepted' | 'declined';
}

// ── Versions ───────────────────────────────────────────────────────────────

export interface DraftVersion {
  id: string;
  version: number;
  label?: string;
  createdAt: string;
  createdBy?: string;
  config: Record<string, unknown>;
}

// ── Edit Lock ──────────────────────────────────────────────────────────────

export interface EditLock {
  heldBy: string | null;
  heldByName?: string;
  acquiredAt: string | null;
  staleAfterMs?: number;
}
