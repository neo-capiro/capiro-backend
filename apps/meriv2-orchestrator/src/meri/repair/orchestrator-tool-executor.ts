import {
  DeduplicatingToolExecutor,
  type RepairEvidence,
  type RepairToolCall,
  type RepairToolResult,
  type RepairToolExecutor,
  type ToolRegistry,
  type LedgerEntry,
} from '@capiro/meriv2-core';
import { extractCitationsFromToolResult, type MeriCitation } from '@capiro/shared';
import { numberMeriEvidenceCitationsForMode } from '../meriv3/meriv3-context-evidence.js';
import { projectMeriToolEvidence } from '../meriv3/meriv3-tool-evidence.js';

export interface RepairToolSchema {
  name: string;
  input_schema: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface RemedyProjectionContext {
  tenantId: string;
  clientId?: string | null;
  conversationId?: string;
  request?: string;
  identities?: Record<string, string | number | undefined>;
}

const ABSTRACT_FIELDS = new Set(['claimIds', 'evidenceClass', 'requiredFields']);

/** Projects only values already present in the governed turn; it never guesses an id. */
export function projectRemedyArgs(
  call: RepairToolCall,
  schema: RepairToolSchema,
  context: RemedyProjectionContext,
): Record<string, unknown> | null {
  const properties = schema.input_schema.properties ?? {};
  const supplied = Object.fromEntries(
    Object.entries(call.args).filter(([key]) => !ABSTRACT_FIELDS.has(key) && key in properties),
  );
  const candidates: Record<string, unknown> = {
    tenantId: context.tenantId,
    clientId: context.clientId,
    conversationId: context.conversationId,
    query: context.request,
    search: context.request,
    ...context.identities,
  };
  for (const name of Object.keys(properties)) {
    if (supplied[name] === undefined && candidates[name] !== undefined && candidates[name] !== null) {
      supplied[name] = candidates[name];
    }
  }
  const missing = (schema.input_schema.required ?? []).filter(
    (name) => supplied[name] === undefined || supplied[name] === null || supplied[name] === '',
  );
  return missing.length ? null : supplied;
}

export interface OrchestratorToolExecutorInput {
  registry: Pick<ToolRegistry, 'get' | 'executionMetadata'>;
  schemas: readonly RepairToolSchema[];
  context: RemedyProjectionContext;
  citations: MeriCitation[];
  /** Same mutable Form B ledger used by final validation and claim-ledger rebuilds. */
  ledgerEntries: LedgerEntry[];
  invoke(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

class GovernedRepairToolExecutor implements RepairToolExecutor {
  constructor(private readonly input: OrchestratorToolExecutorInput) {}

  async execute(call: RepairToolCall, options: { signal?: AbortSignal }): Promise<RepairToolResult> {
    if (options.signal?.aborted) return failed('cancelled');
    const definition = this.input.registry.get(call.name);
    const metadata = this.input.registry.executionMetadata(call.name);
    if (!definition || definition.readOnly !== true || metadata?.executionMode !== 'read') {
      return failed('tool_not_read_only');
    }
    const schema = this.input.schemas.find((item) => item.name === call.name);
    if (!schema) return failed('tool_schema_unavailable');
    const args = projectRemedyArgs(call, schema, this.input.context);
    if (!args) return failed('no_concrete_route');
    try {
      const result = await this.input.invoke(call.name, args, options.signal);
      if (options.signal?.aborted) return failed('cancelled');
      const projected = projectMeriToolEvidence({
        result,
        maxCharacters: 12_000,
        readOnly: true,
        inputProperties: schema.input_schema.properties,
      });
      const candidates = extractCitationsFromToolResult(call.name, projected, 1);
      const numbered = numberMeriEvidenceCitationsForMode(candidates, this.input.citations, 'enforce');
      const evidence: RepairEvidence[] = numbered.citations.map((citation) => {
        const id = citation.stableId || `${citation.tool}:${citation.id}`;
        const passage = citation.snippet?.trim() || JSON.stringify(projected);
        const item: RepairEvidence = {
          id,
          evidenceClass: 'official_government_data',
          sourceId: citation.id || id,
          sourceType: citation.tool,
          passage,
          primary: true,
          authoritative: true,
          requirementIds: [],
          retrievedAt: new Date().toISOString(),
          locator: `[${citation.n}]`,
        };
        return item;
      });
      for (const citation of numbered.citations) {
        const prior = this.input.citations.findIndex((item) =>
          citation.stableId
            ? item.tool === citation.tool && item.stableId === citation.stableId
            : item.tool === citation.tool && item.id === citation.id,
        );
        if (prior < 0) this.input.citations.push(citation);
        else this.input.citations[prior] = citation;
      }
      if (evidence.length) {
        this.input.ledgerEntries.push({
          tool: call.name,
          serialized: JSON.stringify(projected),
          result: projected,
          rowCount: evidence.length,
        });
      }
      return evidence.length ? { ok: true, evidence } : failed('no_usable_evidence');
    } catch (error) {
      return failed(error instanceof Error ? error.message : 'repair_retrieval_failed');
    }
  }
}

export function createOrchestratorToolExecutor(input: OrchestratorToolExecutorInput): RepairToolExecutor {
  return new DeduplicatingToolExecutor(new GovernedRepairToolExecutor(input));
}

function failed(reason: string): RepairToolResult {
  return { ok: false, state: 'retrieval_failed', reason };
}
