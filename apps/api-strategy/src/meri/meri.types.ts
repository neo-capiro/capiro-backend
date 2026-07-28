/*
 * Meri contract shapes exchanged with the orchestrator (/meri-api/strategy-*).
 * The orchestrator's terminal tools (propose_strategy_draft / propose_plan_edits)
 * return these; api-strategy validates + applies them. Dates are YYYY-MM-DD.
 */

import type { Violation } from '@capiro/strategy-verifier';

/** The resolved tenant AI credential forwarded to the orchestrator (BYOK, D19). */
export interface ResolvedAiProvider {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  usedTenantKey: boolean;
  modelOverridden: boolean;
}

/** A node the orchestrator proposes for a fresh draft (CRT-11/12). */
export interface DraftNode {
  kind: string;
  subject: string;
  title: string;
  note?: string | null;
  status?: string | null;
  ownerUserId?: string | null;
  startsOn: string;
  endsOn?: string | null;
  openEnded?: boolean;
  /** A3: 0-based indexes into the draft node list (mapped to uuids on persist). */
  dependsOn?: number[];
  /** A9: pack section(s) that ground this node. */
  sources?: Array<{ section: string; ref?: string }>;
}

/** Which pack sections were included (CTX-6 provenance — names + counts, not content). */
export interface PackProvenance {
  sections: Array<{ name: string; count: number }>;
  omitted?: string[];
}

export interface StrategyDraftResponse {
  summary: string;
  nodes: DraftNode[];
  provenance?: PackProvenance;
  /** A5: verifier findings from the orchestrator's draft repair loop (advisory). */
  violations?: Violation[];
  /** A8: whether the client context pack was complete. */
  groundingHealth?: GroundingHealth;
}

export type PlanEditOp = 'add' | 'update' | 'remove' | 'retime';

/** One edit the assistant proposes against an existing strategy (NOD-4 / MRI-3). */
export interface PlanEdit {
  op: PlanEditOp;
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
  /** A3: node ids this step depends on (existing nodes; add/update ops). */
  dependsOn?: string[];
  /** A9: pack section(s) that ground this node. */
  sources?: Array<{ section: string; ref?: string }>;
}

/**
 * Stage E: one open MATERIAL fact conflict, with both fact texts verbatim —
 * the orchestrator's health note (and the web banner) name factA vs factB.
 */
export interface StewardHealthConflict {
  id: string;
  factAId: string;
  factBId: string;
  factA: string;
  factB: string;
}

/**
 * Stage E wire-contract (2): the fact-level health block api-strategy forwards
 * in the draft/assistant orchestrator body as `stewardHealth`; the orchestrator
 * carries it back through the response `groundingHealth`.
 */
export interface StewardHealth {
  status: 'ok' | 'degraded' | 'conflicted';
  missingRequired: string[];
  openMaterialConflicts: StewardHealthConflict[];
}

/**
 * Stage E wire-contract (2): one Steward fact line forwarded in the
 * draft/assistant orchestrator body (`stewardFacts`). The orchestrator renders
 * '- [fact:<id>] <fact> (<authority>, as of <asOf>)' and instructs Meri to cite
 * with ref 'fact:<id>'.
 */
export interface StewardFactLine {
  id: string;
  fact: string;
  sourceRef: string;
  documentTitle: string;
  templateKey: string;
  authority: string | null;
  asOf: string | null; // YYYY-MM-DD | null
}

/** A8: grounding-health signal the orchestrator returns (from the context pack).
 *  Stage E upgrades it to carry the stewardHealth through ('conflicted' +
 *  openMaterialConflicts) so the web banner can consume it. */
export interface GroundingHealth {
  status: 'ok' | 'degraded' | 'conflicted';
  missingRequired: string[];
  omittedOptional: string[];
  openMaterialConflicts?: StewardHealthConflict[];
}

/**
 * Phase 5 §3.3 — one context gap in plain language, closed-mapped from an
 * internal key/conflict so the API response and the seeded chat message can
 * never leak a raw template key, enum identifier, or database column.
 * `affectedNodeIds` drives the node-level `needs context` marker (§6);
 * `canAttach` tells the web whether the composer's attachment affordance can
 * resolve this gap (true for a missing document, false for a Steward
 * conflict — that resolves only through the Steward review, not an upload).
 */
export interface PublicContextGap {
  code: string;
  label: string;
  affectedNodeIds: string[];
  canAttach: boolean;
}

/**
 * Phase 5 §4.3 — the typed 422 a draft returns when it cannot be persisted.
 * `STRATEGY_DRAFT_INPUT_REQUIRED`: the residual hard errors trace to missing/
 * degraded context — more input (a document, a clarified goal) can plausibly
 * fix it. `STRATEGY_DRAFT_INVALID`: the plan is structurally broken (a
 * dependency cycle, or hard errors that survive even with clean grounding) —
 * no attachment fixes that, so `requiredInputs` is empty and `violations`
 * carries the concrete reasons instead.
 */
export interface StrategyDraftErrorBody {
  code: 'STRATEGY_DRAFT_INPUT_REQUIRED' | 'STRATEGY_DRAFT_INVALID';
  message: string;
  requiredInputs: Array<{ code: string; label: string; canAttach: boolean }>;
  violations?: Array<{ message: string }>;
}

// ---------------------------------------------------------------------------
// Stage E wire-contract (1): POST /meri-api/steward-extract
// ---------------------------------------------------------------------------

/** One extracted fact the Steward orchestrator surface returns. */
export interface StewardExtractedFact {
  fact: string;
  /** Stable markdown-locate ref ('heading:<text>' / 'row:<heading>:<n>') —
   *  re-validated against the stored content before persisting. */
  sourceRef: string;
  authority: string | null;
  asOf: string | null; // YYYY-MM-DD | null
  confidence: number; // 0-1
  citation: string; // verbatim source snippet
}

/** One conflict the orchestrator detected between a NEW fact and an existing one. */
export interface StewardExtractedConflict {
  /** Index into the returned `facts` array (remapped after ref-validation drops). */
  newFactIndex: number;
  existingFactId: string;
  material: boolean;
  rationale: string;
}

export interface StewardExtractResponse {
  facts: StewardExtractedFact[];
  conflicts: StewardExtractedConflict[];
  summary: string;
}

export interface StrategyAssistantResponse {
  reply: string;
  summary?: string | null;
  edits: PlanEdit[];
  provenance?: PackProvenance;
  /** A8: whether the client context pack was complete. */
  groundingHealth?: GroundingHealth;
}

/** REF-4 reference-editor assist: the orchestrator returns edited working rows. */
export interface StrategyReferenceAssistResponse {
  reply?: string;
  rows: unknown[];
}

// ---------------------------------------------------------------------------
// Stage-G grounded content: POST /meri-api/strategy-document-draft
// ---------------------------------------------------------------------------

/** One drafted body section — heading + sanitized HTML + optional provenance. */
export interface DocumentDraftSection {
  heading: string;
  html: string;
  sources?: Array<{ section: string; ref?: string }>;
}

/** The full node-scoped document/message draft the orchestrator returns. */
export interface NodeDocumentDraftResponse {
  title: string | null;
  summary: string | null;
  sections: DocumentDraftSection[];
  provenance?: PackProvenance;
  groundingHealth?: GroundingHealth;
  /** The model that actually produced this draft (for provenance stamping —
   *  NOT reliably available from the resolved AI provider on the global-key
   *  path, so it MUST come back from the orchestrator response). */
  model: string | null;
}
