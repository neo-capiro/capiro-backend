import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  GOVERNED_STEERING_COLUMNS_SQL,
  LAYER_BY_TYPE,
  governedSteeringRowDecision,
  type LedgerEntry,
  type MeriGovernedTurnContext,
  type SteeringRow,
} from '@capiro/meriv2-core';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import {
  governedRecallSuppressionEnabled,
  governedRecallSuppressionSql,
} from '../memory/memory-recall-suppression.helpers.js';
import {
  canonicalMemoryEligibilitySql,
  includeCanonicalGovernedMemoryRow,
  type CanonicalGovernedMemoryRow,
} from '../retrieval/adapters/governed-memory-eligibility.helpers.js';
import { researchJsonSha256 } from './meri-research-durable-result.js';
import type { MeriResearchHandoff } from './meri-research-handoff.js';
import { researchMetadata } from './meri-research-run-state.js';
import { publicResearchSourceTool } from './meri-report-provenance.js';

/**
 * Producer-input coverage for research reports (Stage 2 re-check adapter).
 *
 * Every non-user input a report's producer saw falls in exactly one class:
 * - governed: a Context Plane packet item, a Context Plane evidence record in a
 *   supported domain, or a handoff attachment. Its identity and current version
 *   are pinned at publication and re-read from the canonical owner on every
 *   report read; a missing, changed, walled or no-longer-admitted input
 *   withholds the body.
 * - public: a tool whose result reads only global/public datasets, or a failed
 *   tool call that returned no content. Nothing private to re-check.
 * - receipted: a durable owner read, re-checked by the existing receipt path.
 * - unsupported: everything else (conversation summary, assistant turns,
 *   inherited citations, tools without an owner proof, unsupported domains).
 *   Any unsupported input keeps publication fail-closed.
 */

export type ResearchProducerInputMode =
  | 'source_free'
  | 'covered_inputs'
  | 'governed_inputs'
  | 'unsupported_private_inputs';

/**
 * Tools whose results come only from global/public datasets or the public web
 * (audited 2026-10-06 against each implementation). Excluded on purpose:
 * search_committee_hearings and get_representation (tenant client data), and
 * search_federal_contract_awards, search_federal_subawards and
 * search_contract_vehicles (tenant-filtered when a client is pinned).
 * get_program_element and search_program_elements add only the reader's own
 * watch flag, and research reports are readable only by their author.
 */
export const PUBLIC_DATA_RESEARCH_TOOLS: ReadonlySet<string> = new Set([
  'get_program_element',
  'search_program_elements',
  'get_pe_budget_timeline',
  'get_pe_report_language',
  'get_pe_contractors',
  'get_pe_bills',
  'search_congress_bills',
  'search_floor_votes',
  'search_cbo_cost_estimates',
  'search_crs_reports',
  'search_gao_reports',
  'get_committee_roster',
  'list_members',
  'search_federal_awards',
  'search_federal_grants',
  'search_procurement_forecasts',
  'search_sam_opportunities',
  'query_regulatory_dockets',
  'search_lda_filings',
  'search_sec_filings',
  'search_fara_registrations',
  'get_certification_status',
  'search_public_web',
  'query_economic_data',
  'search_state_bills',
  'get_state_bill_status',
  'get_legal_reference',
  // Receipted public sources whose reads are public even when not durably
  // qualified (a partial page or bill read): no tenant context is read.
  'get_bill_status',
  'read_bill_text',
  'scrape_web_page',
]);

/**
 * Whether a research run may admit this tool: its results are either re-checked
 * by a durable owner receipt or public. Any other read would make the report's
 * producer inputs unsupported, so research does not offer it.
 */
export function researchProducerInputCoverableTool(name: string): boolean {
  return Boolean(publicResearchSourceTool(name)) || PUBLIC_DATA_RESEARCH_TOOLS.has(name);
}

export const GOVERNED_CONTEXT_RECORD_DOMAINS = [
  'clients',
  'contacts',
  'strategies_work',
  'institutional_knowledge',
] as const;
type GovernedContextRecordDomain = (typeof GOVERNED_CONTEXT_RECORD_DOMAINS)[number];
const GOVERNED_DOMAIN_SET = new Set<string>(GOVERNED_CONTEXT_RECORD_DOMAINS);

const STRATEGY_WORK_KINDS = [
  'strategy',
  'context_document',
  'context_fact',
  'context_conflict',
] as const;
type StrategyWorkKind = (typeof STRATEGY_WORK_KINDS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface ResearchContextRecordRef {
  domain: GovernedContextRecordDomain;
  /** Canonical owner id; strategies_work keeps its `<kind>:<uuid>` form. */
  id: string;
}

/** Built from the runtime's own view of the producer inputs. No bodies. */
export interface ResearchProducerInputDraftV1 {
  version: 1;
  packet: { packetId: string; memoryItemIds: string[] } | null;
  /** Null when the bounded evidence projection dropped the record's update time. */
  records: Array<ResearchContextRecordRef & { observedUpdatedAt: string | null }>;
  attachments: Array<{ id: string; sourceMessageId: string | null; contentSha256: string }>;
  publicToolResults: string[];
  failedToolResults: number;
}

/** Pinned at publication; private session metadata only, never a public projection. */
export interface ResearchProducerInputManifestV1 {
  version: 1;
  packet: {
    packetId: string;
    items: Array<{ memoryItemId: string; updatedAt: string; sectionsSha256: string }>;
  } | null;
  records: Array<ResearchContextRecordRef & { updatedAt: string; versionSha256: string | null }>;
  attachments: Array<{ id: string; sourceMessageId: string | null; contentSha256: string }>;
  publicToolResults: string[];
  failedToolResults: number;
}

/** Category counts only: tool names and domains, never ids, hashes or text. */
export interface ResearchProducerInputCategories {
  unsupported: Record<string, number>;
  covered: Record<string, number>;
}

export interface ResearchProducerInputClassification {
  producerInputSha256: string;
  producerInputMode: ResearchProducerInputMode;
  clientContextSha256: string | null;
  producerInputDraft: ResearchProducerInputDraftV1 | null;
  producerInputCategories: ResearchProducerInputCategories;
}

type LedgerEntryWithReceipt = LedgerEntry & {
  durableSafeRead?: { tool: string; executionId: string };
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bump(map: Record<string, number>, key: string, count = 1): void {
  if (count > 0) map[key] = (map[key] ?? 0) + count;
}

const FAILURE_KEYS = new Set([
  'error',
  'message',
  'detail',
  'code',
  'tool',
  'status',
  'reason',
  'hint',
  'retryable',
  'retryAfterMs',
  'success',
  'ok',
  'blocked',
]);

/** A logical failure that carries no source content (no records, rows or body). */
export function contentFreeToolFailure(result: unknown): boolean {
  const value = record(result);
  if (!value) return false;
  const failed =
    value.error === true ||
    typeof value.error === 'string' ||
    value.blocked === true ||
    value.success === false ||
    value.ok === false ||
    value.status === 'failed' ||
    value.status === 'error';
  return failed && Object.keys(value).every((key) => FAILURE_KEYS.has(key));
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function recordKey(ref: ResearchContextRecordRef): string {
  return `${ref.domain}\u0000${ref.id}`;
}

/**
 * Classify the producer inputs a research turn actually saw. Pure: the API's
 * own governed context is the authority for what entered the prompt; the
 * ledger only says which tool results the model received.
 */
export function classifyResearchProducerInputs(input: {
  hashMaterial: unknown;
  durableTools: string[];
  /** Durable reads whose step, receipt and owner classification agree (declared sources). */
  qualifiedDurableExecutionIds: ReadonlySet<string>;
  clientContext: string | null | undefined;
  governedContext: MeriGovernedTurnContext | undefined;
  handoff: MeriResearchHandoff | null;
  inherited: { citations: number; unavailable: number; omitted: number };
  ledgerEntries: readonly LedgerEntryWithReceipt[];
}): ResearchProducerInputClassification {
  const unsupported: Record<string, number> = {};
  const covered: Record<string, number> = {};
  const { handoff, governedContext: governed } = input;

  if (handoff?.summary) bump(unsupported, 'handoff_summary');
  bump(
    unsupported,
    'assistant_handoff_turns',
    handoff?.messages.filter((message) => message.role === 'assistant').length ?? 0,
  );
  bump(unsupported, 'inherited_citations', input.inherited.citations);
  bump(unsupported, 'inherited_unavailable', input.inherited.unavailable);
  bump(unsupported, 'inherited_omitted', input.inherited.omitted);

  const attachments = (handoff?.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    sourceMessageId: attachment.sourceMessageId ?? null,
    contentSha256: attachment.contentSha256,
  }));
  if (attachments.some((attachment) => !SHA256_RE.test(attachment.contentSha256)))
    bump(unsupported, 'handoff_attachment_unversioned');
  bump(covered, 'handoff_attachments', attachments.length);

  // The governed factory supplies the Context Plane prompt as the client
  // context. That prompt is covered input by input below, so its per-compile
  // packet id must not be pinned as a whole-prompt hash.
  const clientContextGoverned = Boolean(
    governed && input.clientContext && input.clientContext === governed.prompt,
  );
  const clientContextSha256 =
    input.clientContext && !clientContextGoverned
      ? createHash('sha256').update(input.clientContext).digest('hex')
      : null;

  const packetItems = governed?.contextPacket.items ?? [];
  let packet: ResearchProducerInputDraftV1['packet'] = null;
  if (packetItems.length) {
    const packetId = governed?.contextPacket.packetId;
    if (!packetId || !UUID_RE.test(packetId)) {
      bump(unsupported, 'context_packet_unpersisted', packetItems.length);
    } else if (packetItems.some((item) => !UUID_RE.test(item.id))) {
      bump(unsupported, 'context_packet_item_unrecognized');
    } else {
      packet = { packetId, memoryItemIds: sortedUnique(packetItems.map((item) => item.id)) };
      bump(covered, 'context_packet_items', packet.memoryItemIds.length);
    }
  }

  const records = new Map<string, ResearchProducerInputDraftV1['records'][number]>();
  for (const evidence of governed?.evidence?.records ?? []) {
    const provenance = record(evidence.provenance);
    if (evidence.recordId.startsWith('steering:')) {
      const memoryItemId =
        typeof provenance?.memoryItemId === 'string'
          ? provenance.memoryItemId
          : evidence.recordId.slice('steering:'.length);
      if (packet?.memoryItemIds.includes(memoryItemId)) bump(covered, 'steering_records');
      else bump(unsupported, 'steering_outside_packet');
      continue;
    }
    if (!GOVERNED_DOMAIN_SET.has(evidence.domain)) {
      bump(unsupported, `context_record:${evidence.domain}`);
      continue;
    }
    const domain = evidence.domain as GovernedContextRecordDomain;
    const id = evidence.sourceRecordId ?? evidence.recordId;
    const observedUpdatedAt =
      typeof provenance?.recordUpdatedAt === 'string' ? provenance.recordUpdatedAt : null;
    if (!contextRecordIdValid(domain, id)) {
      bump(unsupported, `context_record_unrecognized:${domain}`);
      continue;
    }
    const ref = { domain, id, observedUpdatedAt };
    const existing = records.get(recordKey(ref));
    if (existing && existing.observedUpdatedAt !== observedUpdatedAt) {
      bump(unsupported, `context_record_conflicting_versions:${domain}`);
      continue;
    }
    records.set(recordKey(ref), ref);
    bump(covered, `context_record:${domain}`);
  }

  const publicTools = new Set<string>();
  let failedToolResults = 0;
  for (const entry of input.ledgerEntries) {
    if (entry.durableSafeRead) {
      // Receipted public sources are re-checked by the receipt path. A receipt
      // for any other tool has no owner proof and was never re-checked before.
      if (!publicResearchSourceTool(entry.durableSafeRead.tool))
        bump(unsupported, `receipted_unowned_tool:${entry.durableSafeRead.tool}`);
      // A receipted read the model saw that will not be declared as a report
      // source would escape the read-time re-check.
      else if (!input.qualifiedDurableExecutionIds.has(entry.durableSafeRead.executionId))
        bump(unsupported, `receipted_unqualified_tool:${entry.durableSafeRead.tool}`);
      continue;
    }
    if (entry.tool === 'context_plane') {
      if (!governed?.evidence?.records.length) bump(unsupported, 'context_plane_unattested');
      continue;
    }
    // Inherited document observations are counted with the inherited inputs.
    if (record(entry.result)?.origin === 'conversation') continue;
    if (contentFreeToolFailure(entry.result)) {
      failedToolResults += 1;
      continue;
    }
    if (PUBLIC_DATA_RESEARCH_TOOLS.has(entry.tool)) {
      publicTools.add(entry.tool);
      bump(covered, `public_tool:${entry.tool}`);
      continue;
    }
    bump(unsupported, `unreceipted_tool:${entry.tool}`);
  }
  bump(covered, 'failed_tool_results', failedToolResults);

  const draft: ResearchProducerInputDraftV1 = {
    version: 1,
    packet,
    records: [...records.values()].sort((left, right) =>
      recordKey(left).localeCompare(recordKey(right)),
    ),
    attachments: [...attachments].sort((left, right) => left.id.localeCompare(right.id)),
    publicToolResults: [...publicTools].sort(),
    failedToolResults,
  };
  const governedInputs = Boolean(
    draft.packet || draft.records.length || draft.attachments.length,
  );
  const durableTools = sortedUnique(input.durableTools);
  const producerInputMode: ResearchProducerInputMode = Object.keys(unsupported).length
    ? 'unsupported_private_inputs'
    : governedInputs
      ? 'governed_inputs'
      : durableTools.length || clientContextSha256
        ? 'covered_inputs'
        : 'source_free';
  return {
    producerInputSha256: researchJsonSha256({
      version: 2,
      hashMaterial: input.hashMaterial,
      toolsUsed: durableTools,
      clientContextSha256,
      unsupported,
      covered,
      draft,
    }),
    producerInputMode,
    clientContextSha256,
    producerInputDraft: producerInputMode === 'governed_inputs' ? draft : null,
    producerInputCategories: { unsupported, covered },
  };
}

const MODE_RANK: Record<ResearchProducerInputMode, number> = {
  source_free: 0,
  covered_inputs: 1,
  governed_inputs: 2,
  unsupported_private_inputs: 3,
};

export interface ResearchProducerInputs {
  producerInputSha256: string;
  producerInputMode: ResearchProducerInputMode;
  clientContextSha256: string | null;
  producerInputDraft?: ResearchProducerInputDraftV1 | null;
  producerInputCategories?: ResearchProducerInputCategories;
}

/**
 * Child findings enter the parent prompt, so the parent's producer inputs are
 * the union of its own and every admitted child's.
 */
export function joinResearchProducerInputs(
  parent: ResearchProducerInputs,
  children: readonly ResearchProducerInputs[],
): ResearchProducerInputs {
  if (!children.length) return parent;
  const all = [parent, ...children];
  const unsupported: Record<string, number> = {};
  const covered: Record<string, number> = {};
  for (const item of all) {
    for (const [key, count] of Object.entries(item.producerInputCategories?.unsupported ?? {}))
      bump(unsupported, key, count);
    for (const [key, count] of Object.entries(item.producerInputCategories?.covered ?? {}))
      bump(covered, key, count);
  }
  let mode = all.reduce<ResearchProducerInputMode>(
    (strongest, item) =>
      MODE_RANK[item.producerInputMode] > MODE_RANK[strongest] ? item.producerInputMode : strongest,
    'source_free',
  );
  const drafts = all.flatMap((item) => (item.producerInputDraft ? [item.producerInputDraft] : []));
  let draft: ResearchProducerInputDraftV1 | null = null;
  if (mode === 'governed_inputs') {
    if (all.some((item) => item.producerInputMode === 'governed_inputs' && !item.producerInputDraft)) {
      bump(unsupported, 'governed_draft_missing');
      mode = 'unsupported_private_inputs';
    } else {
      const packetIds = sortedUnique(drafts.flatMap((item) => (item.packet ? [item.packet.packetId] : [])));
      if (packetIds.length > 1) {
        bump(unsupported, 'context_packet_mismatch');
        mode = 'unsupported_private_inputs';
      }
      const records = new Map<string, ResearchProducerInputDraftV1['records'][number]>();
      for (const ref of drafts.flatMap((item) => item.records)) {
        const existing = records.get(recordKey(ref));
        if (existing && existing.observedUpdatedAt !== ref.observedUpdatedAt) {
          bump(unsupported, `context_record_conflicting_versions:${ref.domain}`);
          mode = 'unsupported_private_inputs';
        }
        records.set(recordKey(ref), ref);
      }
      const attachments = new Map<string, ResearchProducerInputDraftV1['attachments'][number]>();
      for (const attachment of drafts.flatMap((item) => item.attachments)) {
        const existing = attachments.get(attachment.id);
        if (existing && existing.contentSha256 !== attachment.contentSha256) {
          bump(unsupported, 'handoff_attachment_conflicting_versions');
          mode = 'unsupported_private_inputs';
        }
        attachments.set(attachment.id, attachment);
      }
      draft =
        mode === 'governed_inputs'
          ? {
              version: 1,
              packet: packetIds.length
                ? {
                    packetId: packetIds[0]!,
                    memoryItemIds: sortedUnique(
                      drafts.flatMap((item) => item.packet?.memoryItemIds ?? []),
                    ),
                  }
                : null,
              records: [...records.values()].sort((left, right) =>
                recordKey(left).localeCompare(recordKey(right)),
              ),
              attachments: [...attachments.values()].sort((left, right) =>
                left.id.localeCompare(right.id),
              ),
              publicToolResults: sortedUnique(drafts.flatMap((item) => item.publicToolResults)),
              failedToolResults: drafts.reduce((sum, item) => sum + item.failedToolResults, 0),
            }
          : null;
    }
  }
  return {
    producerInputSha256: researchJsonSha256({
      version: 1,
      parent: parent.producerInputSha256,
      children: children.map((child) => child.producerInputSha256),
    }),
    producerInputMode: mode,
    clientContextSha256: parent.clientContextSha256,
    producerInputDraft: draft,
    producerInputCategories: { unsupported, covered },
  };
}

function contextRecordIdValid(domain: GovernedContextRecordDomain, id: string): boolean {
  if (domain !== 'strategies_work') return UUID_RE.test(id);
  const [kind, uuid, ...rest] = id.split(':');
  return (
    rest.length === 0 &&
    (STRATEGY_WORK_KINDS as readonly string[]).includes(kind ?? '') &&
    UUID_RE.test(uuid ?? '')
  );
}

export function readResearchProducerInputManifest(
  metadata: unknown,
): ResearchProducerInputManifestV1 | null {
  const raw = record(researchMetadata(metadata).producerInputManifest);
  if (
    !raw ||
    raw.version !== 1 ||
    !(raw.packet === null || record(raw.packet)) ||
    !Array.isArray(raw.records) ||
    !Array.isArray(raw.attachments) ||
    !Array.isArray(raw.publicToolResults) ||
    !Number.isSafeInteger(raw.failedToolResults)
  )
    return null;
  return raw as unknown as ResearchProducerInputManifestV1;
}

/** Thrown with a category only; the caller logs it, the reader sees a withheld body. */
export class ResearchProducerInputNotCurrent extends ConflictException {
  constructor(readonly category: string) {
    super('A research producer input is no longer current.');
  }
}

interface ProducerInputScope {
  sessionClientId: string | null;
  conversationId: string | null;
}

type ProducerInputIdentity = {
  packet: { packetId: string; memoryItemIds: string[] } | null;
  records: ResearchContextRecordRef[];
  attachments: Array<{ id: string; sourceMessageId: string | null }>;
  publicToolResults: string[];
  failedToolResults: number;
};

function iso(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Wall decisions are read once per check and only for the clients it names. */
function wallReader(tx: Prisma.TransactionClient, ctx: TenantContext) {
  const decisions = new Map<string, Promise<boolean>>();
  return (clientId: string): Promise<boolean> => {
    let decision = decisions.get(clientId);
    if (!decision) {
      decision = clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId);
      decisions.set(clientId, decision);
    }
    return decision;
  };
}

/**
 * Read the current canonical state of every recorded input as the current
 * reader. Missing, walled, revoked or no-longer-admitted inputs throw.
 */
async function currentProducerInputManifest(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  scope: ProducerInputScope,
  identity: ProducerInputIdentity,
): Promise<ResearchProducerInputManifestV1> {
  // memory_items forces owner-aware RLS: without the reader's identity a
  // user-private steering item (user-voice) is invisible, exactly as under
  // PrismaService.withTenantUser. Set it for the rest of this transaction.
  await tx.$executeRaw`SELECT set_config('app.current_user', ${ctx.userId}, true)`;
  const wall = wallReader(tx, ctx);
  const packet = identity.packet
    ? {
        packetId: identity.packet.packetId,
        items: await currentPacketItems(tx, ctx, scope, identity.packet.memoryItemIds, wall),
      }
    : null;
  const records: ResearchProducerInputManifestV1['records'] = [];
  for (const ref of identity.records) {
    records.push({ ...ref, ...(await currentContextRecordVersion(tx, ctx, scope, ref, wall)) });
  }
  const attachments: ResearchProducerInputManifestV1['attachments'] = [];
  for (const attachment of identity.attachments) {
    attachments.push(await currentHandoffAttachment(tx, ctx, scope, attachment));
  }
  return {
    version: 1,
    packet,
    records,
    attachments,
    publicToolResults: [...identity.publicToolResults],
    failedToolResults: identity.failedToolResults,
  };
}

async function currentPacketItems(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  scope: ProducerInputScope,
  memoryItemIds: string[],
  wall: (clientId: string) => Promise<boolean>,
): Promise<NonNullable<ResearchProducerInputManifestV1['packet']>['items']> {
  if (!memoryItemIds.length) return [];
  // Same columns and suppression as the packet compiler's governed loader.
  const rows = await tx.$queryRaw<SteeringRow[]>(Prisma.sql`
    SELECT id, type, slug, title, client_id AS "clientId", status,
           expires_at AS "expiresAt", updated_at AS "updatedAt",
           last_confirmed_at AS "confirmedAt", provenance AS authority,
           sections_jsonb AS sections
           ${Prisma.raw(GOVERNED_STEERING_COLUMNS_SQL)}
    FROM memory_items
    WHERE tenant_id = ${ctx.tenantId}::uuid
      AND id = ANY(${memoryItemIds}::uuid[])
      ${Prisma.raw(governedRecallSuppressionSql(governedRecallSuppressionEnabled()))}
  `);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const clientWallAllowed = scope.sessionClientId ? await wall(scope.sessionClientId) : false;
  const items: NonNullable<ResearchProducerInputManifestV1['packet']>['items'] = [];
  for (const memoryItemId of memoryItemIds) {
    const row = byId.get(memoryItemId);
    if (!row) throw new ResearchProducerInputNotCurrent('context_packet_item_missing');
    const layer = LAYER_BY_TYPE[row.type];
    // The loader's own selection rule for each steering layer.
    const selectable =
      layer === 'firm-identity' || layer === 'firm-playbook'
        ? row.slug === 'firm'
        : layer === 'user-voice'
          ? row.ownerUserId === ctx.userId
          : layer === 'client-steering' || layer === 'client-people'
            ? Boolean(scope.sessionClientId) &&
              row.clientId === scope.sessionClientId &&
              clientWallAllowed
            : false;
    const updatedAt = iso(row.updatedAt);
    if (
      !selectable ||
      !updatedAt ||
      !governedSteeringRowDecision(row, {
        tenantId: ctx.tenantId,
        effectiveTenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId: scope.sessionClientId,
        ethicalWallAllowed: clientWallAllowed,
      }).include
    )
      throw new ResearchProducerInputNotCurrent('context_packet_item_not_admitted');
    items.push({ memoryItemId, updatedAt, sectionsSha256: researchJsonSha256(row.sections ?? []) });
  }
  return items;
}

async function clientInScope(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string | null,
  wall: (clientId: string) => Promise<boolean>,
  options: { excludeArchived?: boolean } = {},
): Promise<boolean> {
  if (!clientId) return true;
  if (!(await wall(clientId))) return false;
  if (!options.excludeArchived) return true;
  const client = await tx.client.findFirst({
    where: { id: clientId, tenantId: ctx.tenantId },
    select: { status: true },
  });
  return Boolean(client && client.status !== 'archived');
}

async function currentContextRecordVersion(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  scope: ProducerInputScope,
  ref: ResearchContextRecordRef,
  wall: (clientId: string) => Promise<boolean>,
): Promise<{ updatedAt: string; versionSha256: string | null }> {
  const notCurrent = () => new ResearchProducerInputNotCurrent(`context_record:${ref.domain}`);
  if (!contextRecordIdValid(ref.domain, ref.id)) throw notCurrent();
  if (ref.domain === 'clients') {
    const row = await tx.client.findFirst({
      where: { id: ref.id, tenantId: ctx.tenantId },
      select: { updatedAt: true },
    });
    if (!row || !(await clientInScope(tx, ctx, ref.id, wall))) throw notCurrent();
    return { updatedAt: row.updatedAt.toISOString(), versionSha256: null };
  }
  if (ref.domain === 'contacts') {
    const row = await tx.engagementContact.findFirst({
      where: { id: ref.id, tenantId: ctx.tenantId },
      select: { clientId: true, updatedAt: true },
    });
    if (!row || !(await clientInScope(tx, ctx, row.clientId, wall))) throw notCurrent();
    return { updatedAt: row.updatedAt.toISOString(), versionSha256: null };
  }
  if (ref.domain === 'institutional_knowledge') {
    const owner = await tx.$queryRaw<Array<{ clientId: string | null }>>(Prisma.sql`
      SELECT client_id::text AS "clientId" FROM memory_items
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${ref.id}::uuid
    `);
    if (owner.length !== 1) throw notCurrent();
    const clientId = owner[0]!.clientId;
    if (clientId && !(await wall(clientId))) throw notCurrent();
    const allowedClientIds = clientId ? [clientId] : [];
    // The canonical governed-recall predicate and post-SQL filter, as the
    // Retrieval V2 memory adapter applies them for this reader.
    const rows = await tx.$queryRaw<
      Array<CanonicalGovernedMemoryRow & { sections: unknown; updatedAt: Date }>
    >(
      Prisma.sql`
        SELECT mi.id::text AS id, mi.tenant_id::text AS "tenantId",
               mi.client_id::text AS "clientId", mi.owner_user_id::text AS "ownerUserId",
               mi.visibility, mi.status AS "legacyStatus", mi.updated_at AS "updatedAt",
               mi.sections_jsonb AS sections,
               mi.memory_class AS "memoryClass", mi.memory_authority AS authority,
               mi.memory_scope AS scope, mi.governed_status AS status,
               mi.conflict_status AS "conflictStatus", mi.controlling_item_id::text AS "controllingItemId",
               mi.sensitivity, mi.source_type AS "sourceType", mi.source_id AS "sourceId",
               mi.source_ref AS "sourceRef", mi.source_content_hash AS "sourceContentHash",
               mi.source_version AS "sourceVersion",
               mi.asserted_by_user_id::text AS "assertedByUserId",
               mi.approved_by_user_id::text AS "approvedByUserId", mi.approved_at AS "approvedAt",
               mi.second_approved_by_user_id::text AS "secondApprovedByUserId",
               mi.second_approved_at AS "secondApprovedAt", mi.as_of AS "asOf",
               mi.effective_from AS "effectiveFrom", mi.valid_until AS "validUntil",
               mi.expires_at AS "expiresAt", mi.last_confirmed_at AS "lastConfirmedAt",
               mi.review_due_at AS "reviewDueAt", mi.instructions_allowed AS "instructionsAllowed"
        FROM memory_items mi
        WHERE ${canonicalMemoryEligibilitySql({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          allowedClientIds,
          memoryItemId: ref.id,
        })}
      `,
    );
    const row = rows[0];
    const updatedAt = iso(row?.updatedAt);
    if (
      rows.length !== 1 ||
      !row ||
      !updatedAt ||
      !includeCanonicalGovernedMemoryRow(row, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        allowedClientIds,
      })
    )
      throw notCurrent();
    return { updatedAt, versionSha256: researchJsonSha256(row.sections ?? []) };
  }
  return currentStrategyWorkVersion(tx, ctx, ref, wall, notCurrent);
}

/** Mirrors the strategy-work adapter's per-kind visibility predicates. */
async function currentStrategyWorkVersion(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  ref: ResearchContextRecordRef,
  wall: (clientId: string) => Promise<boolean>,
  notCurrent: () => ResearchProducerInputNotCurrent,
): Promise<{ updatedAt: string; versionSha256: string | null }> {
  const [kind, id] = ref.id.split(':') as [StrategyWorkKind, string];
  type Row = { clientIds: Array<string | null>; updatedAt: Date; version: unknown };
  let rows: Row[];
  if (kind === 'strategy') {
    rows = await tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT ARRAY[s.client_id::text] AS "clientIds", s.updated_at AS "updatedAt",
             (SELECT jsonb_build_object('count', COUNT(*), 'updatedAt', MAX(n.updated_at))
                FROM sp_node n
               WHERE n.tenant_id = s.tenant_id AND n.strategy_id = s.id AND n.archived_at IS NULL
             ) AS version
      FROM sp_strategy s
      WHERE s.tenant_id = ${ctx.tenantId}::uuid AND s.id = ${id}::uuid AND s.archived_at IS NULL
    `);
  } else if (kind === 'context_document') {
    rows = await tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT ARRAY[d.client_id::text] AS "clientIds", d.updated_at AS "updatedAt", NULL::jsonb AS version
      FROM sp_context_document d
      WHERE d.tenant_id = ${ctx.tenantId}::uuid AND d.id = ${id}::uuid
        AND d.state = 'active'::sp_context_doc_state
        AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
    `);
  } else if (kind === 'context_fact') {
    rows = await tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT ARRAY[f.client_id::text] AS "clientIds", f.updated_at AS "updatedAt", NULL::jsonb AS version
      FROM sp_context_fact f
      JOIN sp_context_document d ON d.tenant_id = f.tenant_id AND d.id = f.document_id
      WHERE f.tenant_id = ${ctx.tenantId}::uuid AND f.id = ${id}::uuid
        AND f.state = 'active'::sp_fact_state
        AND d.state = 'active'::sp_context_doc_state
        AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
    `);
  } else {
    rows = await tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT ARRAY[a.client_id::text, b.client_id::text] AS "clientIds",
             c.updated_at AS "updatedAt", NULL::jsonb AS version
      FROM sp_context_conflict c
      JOIN sp_context_fact a ON a.tenant_id = c.tenant_id AND a.id = c.fact_a_id
      JOIN sp_context_fact b ON b.tenant_id = c.tenant_id AND b.id = c.fact_b_id
      WHERE c.tenant_id = ${ctx.tenantId}::uuid AND c.id = ${id}::uuid
        AND c.state = 'open'::sp_conflict_state AND c.material = TRUE
    `);
  }
  const row = rows[0];
  const updatedAt = iso(row?.updatedAt);
  if (rows.length !== 1 || !row || !updatedAt) throw notCurrent();
  for (const clientId of row.clientIds) {
    // Strategies are current work only for active clients; documents, facts and
    // conflicts may be firm-level (null client).
    if (!(await clientInScope(tx, ctx, clientId, wall, { excludeArchived: kind === 'strategy' })))
      throw notCurrent();
  }
  if (kind === 'strategy' && !row.clientIds[0]) throw notCurrent();
  return {
    updatedAt,
    versionSha256: row.version === null ? null : researchJsonSha256(normalizeVersion(row.version)),
  };
}

function normalizeVersion(value: unknown): unknown {
  const version = record(value);
  if (!version) return null;
  return { count: Number(version.count ?? 0), updatedAt: iso(version.updatedAt) };
}

async function currentHandoffAttachment(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  scope: ProducerInputScope,
  attachment: { id: string; sourceMessageId: string | null },
): Promise<ResearchProducerInputManifestV1['attachments'][number]> {
  const row = await tx.clioAttachment.findFirst({
    where: { id: attachment.id, tenantId: ctx.tenantId, userId: ctx.userId },
    select: { kind: true, textContent: true, data: true, messageId: true },
  });
  // A staged upload (no source message at capture) is claimed by the research
  // topic message right after the snapshot; any other move is a scope change.
  if (
    !row ||
    (attachment.sourceMessageId !== null && row.messageId !== attachment.sourceMessageId)
  )
    throw new ResearchProducerInputNotCurrent('handoff_attachment');
  if (row.messageId) {
    const message = scope.conversationId
      ? await tx.clioMessage.findFirst({
          where: {
            id: row.messageId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            conversationId: scope.conversationId,
          },
          select: { id: true },
        })
      : null;
    if (!message) throw new ResearchProducerInputNotCurrent('handoff_attachment');
  }
  // The handoff snapshot's own digest rule (captureResearchHandoff).
  const contentSha256 = createHash('sha256')
    .update(row.kind === 'image' ? Buffer.from(row.data ?? []) : (row.textContent ?? ''))
    .digest('hex');
  return { id: attachment.id, sourceMessageId: attachment.sourceMessageId, contentSha256 };
}

/**
 * Publication: pin every governed input at its current version, and refuse if
 * any changed after the producer observed it.
 */
export async function pinResearchProducerInputs(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  scope: ProducerInputScope,
  draft: ResearchProducerInputDraftV1,
): Promise<ResearchProducerInputManifestV1> {
  const manifest = await currentProducerInputManifest(tx, ctx, scope, {
    packet: draft.packet,
    records: draft.records.map(({ domain, id }) => ({ domain, id })),
    attachments: draft.attachments.map(({ id, sourceMessageId }) => ({ id, sourceMessageId })),
    publicToolResults: draft.publicToolResults,
    failedToolResults: draft.failedToolResults,
  });
  if (draft.packet) {
    const packet = await tx.contextPacket.findFirst({
      where: { id: draft.packet.packetId, tenantId: ctx.tenantId },
      select: { items: true, createdAt: true, userId: true, clientId: true },
    });
    const compiledIds = new Set(
      (Array.isArray(packet?.items) ? packet.items : []).flatMap((item) => {
        const id = record(item)?.id;
        return typeof id === 'string' ? [id] : [];
      }),
    );
    // A research packet is compiled for this actor and either the session's
    // client or no client (an external subject).
    const packetScopeMatches =
      Boolean(packet) &&
      (packet!.userId === null || packet!.userId === ctx.userId) &&
      (packet!.clientId === null || packet!.clientId === scope.sessionClientId);
    if (
      !packet ||
      !packetScopeMatches ||
      draft.packet.memoryItemIds.some((id) => !compiledIds.has(id))
    )
      throw new ResearchProducerInputNotCurrent('context_packet_unbound');
    // A row edited after the packet was compiled is not what the producer saw.
    if (
      manifest.packet!.items.some(
        (item) => new Date(item.updatedAt).getTime() > packet.createdAt.getTime(),
      )
    )
      throw new ResearchProducerInputNotCurrent('context_packet_item_changed');
  }
  for (const [index, ref] of draft.records.entries()) {
    if (
      ref.observedUpdatedAt !== null &&
      manifest.records[index]!.updatedAt !== iso(ref.observedUpdatedAt)
    )
      throw new ResearchProducerInputNotCurrent(`context_record_changed:${ref.domain}`);
  }
  for (const [index, attachment] of draft.attachments.entries()) {
    if (manifest.attachments[index]!.contentSha256 !== attachment.contentSha256)
      throw new ResearchProducerInputNotCurrent('handoff_attachment_changed');
  }
  return manifest;
}

/** Every read: the pinned inputs must still be current for this reader. */
export async function assertResearchProducerInputsCurrent(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  scope: ProducerInputScope,
  manifest: ResearchProducerInputManifestV1,
): Promise<void> {
  const current = await currentProducerInputManifest(tx, ctx, scope, {
    packet: manifest.packet
      ? {
          packetId: manifest.packet.packetId,
          memoryItemIds: manifest.packet.items.map((item) => item.memoryItemId),
        }
      : null,
    records: manifest.records.map(({ domain, id }) => ({ domain, id })),
    attachments: manifest.attachments.map(({ id, sourceMessageId }) => ({ id, sourceMessageId })),
    publicToolResults: manifest.publicToolResults,
    failedToolResults: manifest.failedToolResults,
  });
  if (researchJsonSha256(current) !== researchJsonSha256(manifest))
    throw new ResearchProducerInputNotCurrent('producer_input_changed');
}

/** One log line for a refused publication: categories and counts, nothing else. */
export function describeResearchProducerInputCategories(
  categories: ResearchProducerInputCategories | undefined,
): string {
  if (!categories) return 'categories=unavailable';
  return `unsupported=${JSON.stringify(categories.unsupported)} covered=${JSON.stringify(categories.covered)}`;
}
