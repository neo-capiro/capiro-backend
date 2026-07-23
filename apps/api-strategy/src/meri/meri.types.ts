/*
 * Meri contract shapes exchanged with the orchestrator (/meri-api/strategy-*).
 * The orchestrator's terminal tools (propose_strategy_draft / propose_plan_edits)
 * return these; api-strategy validates + applies them. Dates are YYYY-MM-DD.
 */

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
}

export interface StrategyAssistantResponse {
  reply: string;
  summary?: string | null;
  edits: PlanEdit[];
  provenance?: PackProvenance;
}

/** REF-4 reference-editor assist: the orchestrator returns edited working rows. */
export interface StrategyReferenceAssistResponse {
  reply?: string;
  rows: unknown[];
}
