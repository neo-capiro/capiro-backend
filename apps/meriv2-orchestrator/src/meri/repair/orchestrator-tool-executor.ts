import {
  DeduplicatingToolExecutor,
  bindCitationToLedgerEntries,
  evidenceProfileForTool,
  type RepairDocumentReference,
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
  /** The governed user request; identities literally present in it are projected. */
  request?: string;
  /** Explicit identities a caller already resolved; they win over request text. */
  identities?: Record<string, string | number | undefined>;
}

const ABSTRACT_FIELDS = new Set(['claimIds', 'evidenceClass', 'requiredFields']);
const UNREADABLE_STATES = new Set(['metadata_only', 'failed', 'pending', 'unsupported']);
const DOCUMENT_TOOL = /document|attachment|transcript/i;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** An identifier token must carry a digit; a plain word after "award" is never an id. */
function idToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token && token.length >= 4 && /\d/.test(token) ? token : undefined;
}

/**
 * Identities that appear literally in the governed request text. This is the
 * same input production supplies to the executor; nothing is inferred from it.
 */
export function requestIdentities(request: string | undefined): Record<string, string> {
  if (!request) return {};
  const pe = request.match(/\b\d{7}[A-Z]\b/i)?.[0];
  const bill = request.match(/\b(?:H\.?\s?R\.?|S\.)\s*\d{1,5}\b/i)?.[0];
  const piid = request.match(/\b[A-Z0-9]{4,6}-\d{2}-[A-Z]-\d{4}\b/i)?.[0];
  const opportunity = idToken(
    request.match(
      /\b(?:opportunity|notice|solicitation)\s*(?:id|number|no\.?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9_.-]{3,})\b/i,
    )?.[1],
  );
  const award = idToken(
    request.match(/\baward\s*(?:id|number|no\.?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9_.-]{3,})\b/i)?.[1],
  );
  return {
    ...(pe ? { peCode: pe.toUpperCase(), code: pe.toUpperCase() } : {}),
    ...(bill ? { billId: bill.replace(/\s+/g, ' ').trim().toUpperCase() } : {}),
    ...(piid ? { piid: piid.toUpperCase(), awardId: piid.toUpperCase() } : {}),
    ...(opportunity ? { opportunityId: opportunity } : {}),
    ...(award && !piid ? { awardId: award } : {}),
  };
}

/** Projects only values already present in the governed turn; it never guesses an id. */
export function projectRemedyArgs(
  call: RepairToolCall,
  schema: RepairToolSchema,
  context: RemedyProjectionContext,
  options: {
    /**
     * Do not project the request text into `query`/`search`. A document read
     * treats `query` as a literal in-document search, which would narrow the
     * read to a phrase that is not in the document and return no content.
     */
    omitRequestText?: boolean;
  } = {},
): Record<string, unknown> | null {
  const properties = schema.input_schema.properties ?? {};
  const supplied = Object.fromEntries(
    Object.entries(call.args).filter(
      ([key, value]) =>
        !ABSTRACT_FIELDS.has(key) && key in properties && value !== undefined && value !== null,
    ),
  );
  const candidates: Record<string, unknown> = {
    tenantId: context.tenantId,
    clientId: context.clientId,
    conversationId: context.conversationId,
    ...(options.omitRequestText ? {} : { query: context.request, search: context.request }),
    ...requestIdentities(context.request),
    ...context.identities,
  };
  for (const name of Object.keys(properties)) {
    if (
      supplied[name] === undefined &&
      candidates[name] !== undefined &&
      candidates[name] !== null
    ) {
      supplied[name] = candidates[name];
    }
  }
  const missing = (schema.input_schema.required ?? []).filter(
    (name) => supplied[name] === undefined || supplied[name] === null || supplied[name] === '',
  );
  return missing.length ? null : supplied;
}

/** A document read is content only when it names the document and carries text. */
export function documentContentReadable(value: unknown): boolean {
  const record = object(value);
  if (!record || record.error || record.blocked) return false;
  const coverage = object(record.coverage);
  if (coverage?.continuationBlocked === true || coverage?.missingContent === true) return false;
  // A listing without a document object is metadata, never content.
  if (Array.isArray(record.documents) && !object(record.document)) return false;
  const rows = Array.isArray(record.records) ? record.records.map(object) : [];
  return [record.text, record.content, ...rows.map((row) => object(row?.payload)?.text)].some(
    (text) => typeof text === 'string' && text.trim().length > 0,
  );
}

export interface OrchestratorToolExecutorInput {
  registry: Pick<ToolRegistry, 'get' | 'executionMetadata'>;
  schemas: readonly RepairToolSchema[];
  context: RemedyProjectionContext;
  citations: MeriCitation[];
  /** Same mutable Form B ledger used by final validation and claim-ledger rebuilds. */
  ledgerEntries: LedgerEntry[];
  invoke(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /**
   * The tenant-resolved evidence-accuracy mode used for the rest of the turn.
   * Defaults to stable numbering, which is what the 2c design prescribes.
   */
  evidenceAccuracyMode?: 'off' | 'shadow' | 'enforce';
  /** Documents the turn already knows; an unreadable one is refused without a tool call. */
  documentReferences?: readonly RepairDocumentReference[];
}

class GovernedRepairToolExecutor implements RepairToolExecutor {
  constructor(private readonly input: OrchestratorToolExecutorInput) {}

  async execute(
    call: RepairToolCall,
    options: { signal?: AbortSignal },
  ): Promise<RepairToolResult> {
    if (options.signal?.aborted) return failed('cancelled');
    const definition = this.input.registry.get(call.name);
    const metadata = this.input.registry.executionMetadata(call.name);
    if (!definition || definition.readOnly !== true || metadata?.executionMode !== 'read') {
      return failed('tool_not_read_only');
    }
    const schema = this.input.schemas.find((item) => item.name === call.name);
    if (!schema) return failed('tool_schema_unavailable');
    const documentRoute = isDocumentRoute(call.name, schema);
    const args = projectRemedyArgs(call, schema, this.input.context, {
      omitRequestText: documentRoute,
    });
    if (!args) return failed('no_concrete_route');
    if (documentRoute) {
      // Without the document id the call would be a file listing, not content.
      if (typeof args.documentId !== 'string' || !args.documentId.trim())
        return failed('no_concrete_route');
      const known = this.input.documentReferences?.find((item) => item.id === args.documentId);
      if (
        known &&
        (known.readable === false ||
          (known.contentState !== undefined && UNREADABLE_STATES.has(known.contentState)))
      ) {
        return unavailable('document_not_readable');
      }
    }
    let result: unknown;
    try {
      result = await this.input.invoke(call.name, args, options.signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'repair_retrieval_failed';
      return documentRoute && explicitDocumentUnavailable(reason)
        ? unavailable(reason)
        : failed(reason);
    }
    if (options.signal?.aborted) return failed('cancelled');
    const ownerError = object(result)?.error;
    if (ownerError)
      return documentRoute && explicitDocumentUnavailable(ownerError)
        ? unavailable(String(ownerError))
        : failed('repair_retrieval_failed');
    if (documentRoute && !documentContentReadable(result))
      return unavailable('document_content_unavailable');
    try {
      const projected = projectMeriToolEvidence({
        result,
        maxCharacters: 12_000,
        readOnly: true,
        inputProperties: schema.input_schema.properties,
      });
      const candidates = extractCitationsFromToolResult(call.name, projected, 1);
      const numbered = numberMeriEvidenceCitationsForMode(
        candidates,
        this.input.citations,
        this.input.evidenceAccuracyMode ?? 'enforce',
      );
      const ownerEntry: LedgerEntry = {
        tool: call.name,
        result,
        serialized: JSON.stringify(result),
      };
      const profile = evidenceProfileForTool(call.name);
      const evidence: RepairEvidence[] = numbered.citations.flatMap((citation) => {
        const id = citation.stableId || `${citation.tool}:${citation.id}`;
        const binding = bindCitationToLedgerEntries(citation, [ownerEntry], {
          expectedClientId: this.input.context.clientId,
        });
        if (!binding) return [];
        const item: RepairEvidence = {
          id,
          evidenceClass: profile.evidenceClass,
          sourceId: binding.recordId,
          sourceType: citation.tool,
          passage: binding.text,
          primary: binding.acquisitionState === 'consulted' && profile.primary,
          authoritative: binding.acquisitionState === 'consulted' && profile.authoritative,
          requirementIds: [],
          retrievedAt: new Date().toISOString(),
          ...(binding.version ? { version: binding.version } : {}),
          ...(binding.locator ? { locator: binding.locator } : {}),
          ...(binding.clientId ? { clientId: binding.clientId } : {}),
          ...(binding.documentId ? { documentId: binding.documentId } : {}),
          acquisitionState: binding.acquisitionState,
          evidenceKind: binding.evidenceKind,
          contentHash: binding.contentHash,
          ownerVerified: true,
        };
        return [item];
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
      if (!evidence.length) return failed('no_usable_evidence');
      if (evidence.every((item) => item.acquisitionState === 'discovered'))
        return failed('discovery_requires_consulted_source');
      return { ok: true, evidence };
    } catch (error) {
      return failed(error instanceof Error ? error.message : 'repair_retrieval_failed');
    }
  }
}

export function createOrchestratorToolExecutor(
  input: OrchestratorToolExecutorInput,
): RepairToolExecutor {
  return new DeduplicatingToolExecutor(new GovernedRepairToolExecutor(input));
}

function isDocumentRoute(name: string, schema: RepairToolSchema): boolean {
  return (
    'documentId' in (schema.input_schema.properties ?? {}) &&
    (name === 'read_client_documents' || DOCUMENT_TOOL.test(name))
  );
}

function failed(reason: string): RepairToolResult {
  return { ok: false, state: 'retrieval_failed', reason };
}

function unavailable(reason: string): RepairToolResult {
  return { ok: false, state: 'document_unavailable', reason };
}

function explicitDocumentUnavailable(reason: unknown): boolean {
  return /^(?:document_content_unavailable|document_not_readable|document_not_ready|attachment_not_ready)$/i.test(
    String(reason ?? '').trim(),
  );
}
