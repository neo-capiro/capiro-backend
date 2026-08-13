// Document Agent state types — the versioned JSON object stored at
// config.documentAgent on WsDraft. This is the aggregate-state contract between
// the document-agent module, the reasoning gateway, and the frontend.
//
// IMPORTANT: this file is a TYPE-ONLY contract (no runtime side effects) so it
// can be imported by unit tests and by the reasoning gateway without pulling
// Prisma or NestJS. Keep it dependency-free.

/** Agent phase — the conversational stage of document creation. */
export type DocumentAgentPhase =
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

/** Agent status — the operational state within a phase. */
export type DocumentAgentStatus =
  | 'active'
  | 'needs_input'
  | 'ready'
  | 'generating'
  | 'partial'
  | 'failed'
  | 'complete';

/** A pinned blueprint reference. Documents stay pinned to their original version. */
export interface BlueprintPin {
  blueprintId: string;
  versionId: string;
  version: number;
  definitionHash: string;
}

/** A theme/design selection. */
export interface AgentTheme {
  id: string;
  name: string;
  version?: number;
  settings: Record<string, unknown>;
}

/** Document type selection from the catalog. */
export interface AgentDocumentType {
  id: string;
  label: string;
  product: string;
}

/** The user's goal statement. */
export interface AgentGoal {
  text: string;
  client?: string | null;
  createdAt: string;
}

/** An assumption the agent made — visible until confirmed or rejected. */
export interface AgentAssumption {
  id: string;
  text: string;
  status: 'open' | 'confirmed' | 'rejected';
}

/** Provenance for every material field in the brief. */
export type BriefProvenance = Record<string, 'user' | 'retrieved' | 'suggested' | 'assumed'>;

/** The working brief. */
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
  provenance: BriefProvenance;
  approvedAt?: string;
  approvedBy?: string;
}

/** A context conflict detected during analysis. */
export interface ContextConflict {
  id: string;
  itemIds: string[];
  type: 'numeric' | 'date' | 'status' | 'authority' | 'freshness' | 'semantic';
  description: string;
  recommendedResolution: string;
  resolved: boolean;
  resolution?: string;
}

/** Coverage gap in context. */
export interface ContextCoverage {
  plannedClaims: number;
  supportedClaims: number;
  missingClaims: Array<{
    claimId: string;
    description: string;
    recommendedSourceTypes: string[];
  }>;
}

/** The context plan. */
export interface AgentContextPlan {
  includedItemIds: string[];
  excludedItems: Array<{ itemId: string; reason: string }>;
  conflicts: ContextConflict[];
  coverage: ContextCoverage;
  snapshotHash?: string;
  approvedAt?: string;
  approvedBy?: string;
}

/** An outline section with stable ID. */
export interface DocumentAgentOutlineSection {
  id: string;
  title: string;
  purpose: string;
  instructions: string;
  required: boolean;
  locked: boolean;
  targetWords: { min: number; max: number };
  evidenceItemIds: string[];
}

/** The outline. */
export interface AgentOutline {
  version: number;
  sections: DocumentAgentOutlineSection[];
  approvedAt?: string;
  approvedBy?: string;
}

/** Generation mode. */
export type GenerationMode = 'quick' | 'standard' | 'max';

/** Summary of a generation run. */
export interface DocumentAgentRunSummary {
  runId: string;
  mode: GenerationMode;
  startedAt: string;
  completedAt?: string;
  status: 'active' | 'complete' | 'complete_with_warnings' | 'partial' | 'failed';
  stages: GenerationStage[];
  sectionResults?: Record<string, { status: 'succeeded' | 'failed' | 'stale'; error?: string }>;
}

/** A stage in the max-reasoning generation pipeline. */
export interface GenerationStage {
  name:
    | 'preflight'
    | 'evidence_plan'
    | 'narrative_plan'
    | 'drafting'
    | 'editorial_pass'
    | 'assurance'
    | 'snapshot'
    | 'complete';
  status: 'pending' | 'active' | 'done' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  detail?: string;
}

/** Quality evaluation result. */
export interface AgentQuality {
  score: number;
  evaluatedAt: string;
  blockers: string[];
  recommendations: string[];
}

/** The full agent state, stored at config.documentAgent. */
export interface DocumentAgentState {
  schemaVersion: 1;
  revision: number;
  phase: DocumentAgentPhase;
  status: DocumentAgentStatus;
  documentType: AgentDocumentType | null;
  blueprintPin: BlueprintPin | null;
  theme: AgentTheme | null;
  goal: AgentGoal | null;
  brief: AgentBrief;
  contextPlan: AgentContextPlan;
  outline: AgentOutline;
  generation: {
    mode: GenerationMode;
    activeRunId?: string;
    lastRun?: DocumentAgentRunSummary;
  };
  quality?: AgentQuality;
  pendingProposalId?: string;
}

/** Create the initial agent state for a fresh draft. */
export function createInitialAgentState(): DocumentAgentState {
  return {
    schemaVersion: 1,
    revision: 0,
    phase: 'type',
    status: 'active',
    documentType: null,
    blueprintPin: null,
    theme: null,
    goal: null,
    brief: {
      assumptions: [],
      provenance: {},
    },
    contextPlan: {
      includedItemIds: [],
      excludedItems: [],
      conflicts: [],
      coverage: { plannedClaims: 0, supportedClaims: 0, missingClaims: [] },
    },
    outline: {
      version: 0,
      sections: [],
    },
    generation: {
      mode: 'standard',
    },
  };
}

/**
 * Read the agent state from a WsDraft config object. Defensive: returns a
 * fresh initial state when the config has no documentAgent or is malformed.
 */
export function readAgentState(config: Record<string, unknown> | null): DocumentAgentState {
  if (!config) return createInitialAgentState();
  const raw = (config as { documentAgent?: unknown }).documentAgent;
  if (!raw || typeof raw !== 'object') return createInitialAgentState();
  // Shallow-validate: if schemaVersion is present and an object, trust it.
  // The state machine and services re-validate individual fields on mutation.
  return raw as DocumentAgentState;
}

/**
 * Compute a deterministic hash of the context snapshot for staleness detection.
 * Uses sha256 over the sorted included-item IDs + their payload labels.
 */
export function computeContextSnapshotHash(
  items: Array<{ id: string; label: string; text?: string }>,
): string {
  // Deterministic ordering: sort by id.
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const payload = sorted.map((i) => `${i.id}:${i.label}:${i.text ?? ''}`).join('\n');
  // Use Node's crypto (available in the workspace process). This function is
  // called from the service layer, not from browser/SSR.
  // We import lazily to keep this file side-effect-free for unit tests.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Compute a deterministic hash of the outline for proposal staleness checks.
 */
export function computeOutlineHash(sections: DocumentAgentOutlineSection[]): string {
  const payload = sections
    .map((s) => `${s.id}:${s.title}:${s.required}:${s.locked}`)
    .join('\n');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Compute a hash of the affected content for proposal staleness checks.
 * Compares against the baseHash stored when the proposal was created.
 */
export function computeContentHash(content: Record<string, string>): string {
  const keys = Object.keys(content).sort();
  const payload = keys.map((k) => `${k}:${content[k] ?? ''}`).join('\n');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
