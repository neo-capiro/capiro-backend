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

/** A8: grounding-health signal the orchestrator returns (from the context pack). */
export interface GroundingHealth {
  status: 'ok' | 'degraded';
  missingRequired: string[];
  omittedOptional: string[];
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
