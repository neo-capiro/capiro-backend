import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { isMeriEvidenceModeRead } from '../meri-evidence-mode-reads.js';

/**
 * Run-bound read delegation, RC1 option B (D016-A item 4), Core side.
 * Contract: meri-greenfield docs/coordination/proposals/
 * FABLE-RUN-BOUND-READ-DELEGATION-20261018.md revision 3; the wire shapes
 * mirror Meri's `apps/runtime/native-authority/read-delegation/contract.mjs`
 * byte for byte. Read delegation never authorizes a write.
 */
const MINUTE = 60_000;
export const READ_DELEGATION_LIMITS = Object.freeze({
  attendedMaxMs: 30 * MINUTE,
  occurrenceMaxMs: 15 * MINUTE,
  consentMaxMs: 30 * 86_400_000,
  tokenMaxMs: MINUTE,
  maxBodyBytes: 16_384,
  maxReissuesPerKind: 2,
});
export const READ_TOKEN_SCHEME = 'CapiroMeriRead';
export const READ_TOKEN_TYPE = 'capiro-meri-read+jwt';
export const READ_TOKEN_AUDIENCE = 'capiro:meri-native-read:v1';
export const READ_TOKEN_KINDS = Object.freeze(['current', 'tool', 'mode', 'reference'] as const);
export type ReadTokenKind = (typeof READ_TOKEN_KINDS)[number];
/** Per call slot maxima (Meri `readTokenCeilings`; migration CHECKs). */
export const READ_TOKEN_CEILINGS: Readonly<Record<ReadTokenKind, number>> = Object.freeze({ tool: 1, mode: 7, reference: 7, current: 35 });
const BASE = '/api/clio/application-authority';
export const READ_DELEGATION_ROUTES = Object.freeze({
  create: `${BASE}/read-delegations`,
  consents: `${BASE}/read-delegation-consents`,
  mode: `${BASE}/read-mode-observation`,
  reference: '/api/clio/clients/check-ref',
});
export const delegationPath = (delegationId: string, leaf: 'tokens' | 'current' | 'revocations') => `${BASE}/read-delegations/${delegationId}/${leaf}`;
export const consentStatePath = (consentId: string) => `${BASE}/read-delegation-consents/${consentId}/state`;
export const toolPath = (operationId: string) => `/api/clio/tools/${operationId}`;

/**
 * Core's explicit read-name allowlist for delegated `tool` tokens (contract §3):
 * the tools controller also runs writes, so only these names are ever issued
 * or admitted, and the tools owner refuses any side-effecting name again at
 * dispatch. Source: the preview Core tool list (first-chat-core-meri-tools.json)
 * minus every write (create_task, update_task, save_memory, save_chat_attachments).
 */
export const MERI_DELEGATED_READ_TOOLS: ReadonlySet<string> = new Set([
  'get_acquisition_person', 'get_bill_status', 'get_business_development_context', 'get_business_development_recent_changes',
  'get_committee_roster', 'get_district_federal_market', 'get_district_nexus_changes', 'get_district_nexus_context',
  'get_funding_opportunity', 'get_funding_opportunity_requirements', 'get_legal_reference', 'get_opportunity_client_context',
  'get_opportunity_government_landscape', 'get_pe_bills', 'get_pe_budget_timeline', 'get_pe_contractors', 'get_pe_report_language',
  'get_program_element', 'get_representation', 'get_state_bill_status', 'get_state_legislator', 'list_members', 'list_memory_proposals',
  'lookup_client_registry', 'query_action_items', 'query_economic_data', 'query_global_data', 'query_intelligence',
  'query_knowledge_graph', 'query_outreach', 'query_regulatory_dockets', 'query_tasks', 'read_bill_text', 'scrape_web_page',
  'search_acquisition_personnel', 'search_capiro_data', 'search_cbo_cost_estimates', 'search_client_knowledge',
  'search_committee_hearings', 'search_congress_bills', 'search_contract_vehicles', 'search_crs_reports', 'search_fara_registrations',
  'search_federal_awards', 'search_federal_contract_awards', 'search_federal_grants', 'search_federal_subawards', 'search_floor_votes',
  'search_funding_opportunities', 'search_gao_reports', 'search_intel_articles', 'search_lda_filings', 'search_legislative_research',
  'search_legiwatch_news', 'search_procurement_forecasts', 'search_program_elements', 'search_public_web', 'search_sec_filings',
  'search_state_bills', 'search_state_floor_votes', 'search_tracked_bills',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const CALL_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const OPERATION_ID = /^[a-z][a-z0-9_]{1,63}$/;
const OPERATION_VERSION = /^\d+\.\d+\.\d+$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const isSha = (v: unknown): v is string => typeof v === 'string' && SHA.test(v);
export const sha256Hex = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** Meri `canonicalSha256`: SHA-256 of the RFC 8785 form. */
export const canonicalSha256 = (value: unknown) => sha256Hex(Buffer.from(canonicalizeCoreRetainedJson(value), 'utf8'));

const invalid = (field: string) => new BadRequestException(`Invalid read delegation request: ${field}`);
export function closed(value: unknown, keys: readonly string[], field: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw invalid(field);
  const names = Reflect.ownKeys(value);
  if (names.some((k) => typeof k !== 'string' || (!keys.includes(k) && !optional.includes(k))) || keys.some((k) => !names.includes(k))) throw invalid(field);
  return value as Record<string, unknown>;
}

export interface OperationRef { id: string; version: string }
function operationRef(value: unknown, field: string): OperationRef {
  const v = closed(value, ['id', 'version'], field);
  if (typeof v.id !== 'string' || !OPERATION_ID.test(v.id) || typeof v.version !== 'string' || !OPERATION_VERSION.test(v.version)) throw invalid(field);
  return { id: v.id, version: v.version };
}
/** Meri `operationsDigest`: canonical SHA-256 of the sorted `{id, version}` list. */
export function operationsDigest(operations: readonly OperationRef[]): string {
  return canonicalSha256([...operations].map((op) => ({ id: op.id, version: op.version }))
    .sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`)));
}

export interface DelegationRunBinding {
  tenantId: string; actorId: string; conversationId: string; runId: string; attemptId: string; writerFence: number;
}
export interface DelegationCreateRequest {
  mode: 'attended' | 'unattended';
  binding: DelegationRunBinding;
  clientId: string;
  policyRevision: string;
  allocationSha256: string;
  operationsDigest: string;
  supersedes: string | null;
  consentId: string | null;
  scheduleId: string | null;
  occurrenceKey: string | null;
}

export function parseDelegationCreate(raw: unknown): DelegationCreateRequest {
  const base = ['schemaVersion', 'mode', 'binding', 'clientId', 'policyRevision', 'allocationSha256', 'operationsDigest', 'supersedes'];
  const v = closed(raw, base, 'body', ['consentId', 'scheduleId', 'occurrenceKey']);
  if (v.schemaVersion !== 1 || (v.mode !== 'attended' && v.mode !== 'unattended')) throw invalid('mode');
  const attended = v.mode === 'attended';
  const extra = ['consentId', 'scheduleId', 'occurrenceKey'].filter((k) => Object.hasOwn(v, k));
  if (attended ? extra.length !== 0 : extra.length !== 3) throw invalid('mode fields');
  const b = closed(v.binding, ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'writerFence'], 'binding');
  if (![b.tenantId, b.actorId, b.conversationId, b.runId, b.attemptId].every(isUuid) ||
      !Number.isSafeInteger(b.writerFence) || (b.writerFence as number) < 1) throw invalid('binding');
  if (!isUuid(v.clientId) || !isSha(v.policyRevision) || !isSha(v.allocationSha256) || !isSha(v.operationsDigest) ||
      !(v.supersedes === null || isUuid(v.supersedes))) throw invalid('facts');
  if (!attended && (v.supersedes !== null || !isUuid(v.consentId) || !isUuid(v.scheduleId) || !isSha(v.occurrenceKey))) throw invalid('occurrence');
  return {
    mode: v.mode as 'attended' | 'unattended', binding: b as unknown as DelegationRunBinding, clientId: v.clientId as string,
    policyRevision: v.policyRevision as string, allocationSha256: v.allocationSha256 as string, operationsDigest: v.operationsDigest as string,
    supersedes: v.supersedes as string | null, consentId: attended ? null : v.consentId as string,
    scheduleId: attended ? null : v.scheduleId as string, occurrenceKey: attended ? null : v.occurrenceKey as string,
  };
}

/** Contract §7: `sha256` of the canonical idempotency facts. */
export function delegationIdempotencyKey(r: DelegationCreateRequest): string {
  return canonicalSha256({
    mode: r.mode, tenantId: r.binding.tenantId, actorId: r.binding.actorId, clientId: r.clientId, conversationId: r.binding.conversationId,
    runId: r.binding.runId, attemptId: r.binding.attemptId, writerFence: r.binding.writerFence, allocationSha256: r.allocationSha256,
    operationsDigest: r.operationsDigest, policyRevision: r.policyRevision, occurrenceKey: r.occurrenceKey,
  });
}

export interface TokenRequest {
  kind: ReadTokenKind;
  callKey: string;
  method: 'POST';
  path: string;
  bodySha256: string;
  operation: OperationRef | null;
  argumentsSha256: string | null;
  toolRequestSha256: string | null;
  referenceSha256: string | null;
  retryOf: string | null;
  /** Canonical request digest (dot 6248070410): the request with `retryOf` normalized to null. */
  requestDigest: string;
}

/** The two exact `current` bodies Meri sends (`{"schemaVersion":1,"conversation":<bool>}`). */
export const currentBodySha256 = (conversation: boolean) => sha256Hex(Buffer.from(JSON.stringify({ schemaVersion: 1, conversation }), 'utf8'));

export function parseTokenRequest(raw: unknown, delegationId: string): TokenRequest {
  const v = closed(raw, ['schemaVersion', 'kind', 'callKey', 'method', 'path', 'bodySha256', 'operation', 'argumentsSha256',
    'toolRequestSha256', 'referenceSha256', 'retryOf'], 'body');
  if (v.schemaVersion !== 1 || !READ_TOKEN_KINDS.includes(v.kind as ReadTokenKind) || typeof v.callKey !== 'string' || !CALL_KEY.test(v.callKey) ||
      v.method !== 'POST' || typeof v.path !== 'string' || !isSha(v.bodySha256) || !(v.retryOf === null || isSha(v.retryOf))) throw invalid('token');
  const kind = v.kind as ReadTokenKind;
  const operation = v.operation === null ? null : operationRef(v.operation, 'operation');
  const nulls = (...keys: string[]) => keys.every((k) => v[k] === null);
  if (kind === 'tool') {
    if (!operation || v.path !== toolPath(operation.id) || !isSha(v.argumentsSha256) || !nulls('toolRequestSha256', 'referenceSha256')) throw invalid('tool');
  } else if (kind === 'mode') {
    if (!operation || !isMeriEvidenceModeRead(operation.id) || v.path !== READ_DELEGATION_ROUTES.mode || !isSha(v.toolRequestSha256) ||
        !nulls('argumentsSha256', 'referenceSha256')) throw invalid('mode');
  } else if (kind === 'reference') {
    if (operation !== null || v.path !== READ_DELEGATION_ROUTES.reference || !isSha(v.referenceSha256) ||
        !nulls('argumentsSha256', 'toolRequestSha256')) throw invalid('reference');
  } else if (operation !== null || v.path !== delegationPath(delegationId, 'current') ||
      !nulls('argumentsSha256', 'toolRequestSha256', 'referenceSha256') ||
      (v.bodySha256 !== currentBodySha256(false) && v.bodySha256 !== currentBodySha256(true))) {
    throw invalid('current');
  }
  const request = {
    schemaVersion: 1, kind, callKey: v.callKey, method: 'POST', path: v.path, bodySha256: v.bodySha256, operation,
    argumentsSha256: v.argumentsSha256, toolRequestSha256: v.toolRequestSha256, referenceSha256: v.referenceSha256, retryOf: null,
  };
  return {
    kind, callKey: v.callKey, method: 'POST', path: v.path, bodySha256: v.bodySha256 as string, operation,
    argumentsSha256: v.argumentsSha256 as string | null, toolRequestSha256: v.toolRequestSha256 as string | null,
    referenceSha256: v.referenceSha256 as string | null, retryOf: v.retryOf as string | null, requestDigest: canonicalSha256(request),
  };
}

export const REVOKE_REASONS = Object.freeze(['run_terminal', 'cancelled', 'fenced', 'superseded'] as const);
export function parseRevoke(raw: unknown): (typeof REVOKE_REASONS)[number] {
  const v = closed(raw, ['schemaVersion', 'reason'], 'body');
  if (v.schemaVersion !== 1 || !REVOKE_REASONS.includes(v.reason as (typeof REVOKE_REASONS)[number])) throw invalid('reason');
  return v.reason as (typeof REVOKE_REASONS)[number];
}

export interface ConsentCreateRequest {
  scheduleId: string; clientId: string; operationsDigest: string; policyRevision: string; scheduleProjectionSha256: string; requestedExpiresAtMs: number;
}
export function parseConsentCreate(raw: unknown): ConsentCreateRequest {
  const v = closed(raw, ['schemaVersion', 'scheduleId', 'clientId', 'operationsDigest', 'policyRevision', 'scheduleProjectionSha256', 'requestedExpiresAtMs'], 'body');
  if (v.schemaVersion !== 1 || !isUuid(v.scheduleId) || !isUuid(v.clientId) || !isSha(v.operationsDigest) || !isSha(v.policyRevision) ||
      !isSha(v.scheduleProjectionSha256) || !Number.isSafeInteger(v.requestedExpiresAtMs)) throw invalid('consent');
  return v as unknown as ConsentCreateRequest;
}
export function parseConsentState(raw: unknown): 'paused' | 'revoked' | 'active' {
  const v = closed(raw, ['schemaVersion', 'state'], 'body');
  if (v.schemaVersion !== 1 || !['paused', 'revoked', 'active'].includes(v.state as string)) throw invalid('state');
  return v.state as 'paused' | 'revoked' | 'active';
}
export function parseCurrentBody(raw: unknown): { conversation: boolean } {
  const v = closed(raw, ['schemaVersion', 'conversation'], 'body');
  if (v.schemaVersion !== 1 || typeof v.conversation !== 'boolean') throw invalid('current');
  return { conversation: v.conversation };
}

const CLIENT_SELECTORS = new Set(['clientId', 'client_id', 'clientIds', 'client_ids', 'clientRef', 'client', 'selectedClientId']);
const CONVERSATION_SELECTORS = new Set(['conversationId', 'conversation_id']);
/** Top-level properties of a tool's input schema that select a client. */
export function schemaClientSelectors(inputSchema: unknown): string[] {
  const properties = (inputSchema as { properties?: unknown } | null)?.properties;
  return properties && typeof properties === 'object' ? Object.keys(properties).filter((k) => CLIENT_SELECTORS.has(k)) : [];
}

/**
 * Contract §3, `tool` target: every decoded client or conversation selector
 * in the body names exactly the delegated client or conversation (names and
 * other references refuse: only the exact UUID passes), at any depth. A tool
 * whose schema declares a client selector must carry one, so an omitted
 * selector can never widen a read to the actor's whole roster.
 */
export function assertDelegatedToolSelectors(body: unknown, delegated: { clientId: string; conversationId: string }, required: readonly string[]): void {
  const refuse = () => { throw new ForbiddenException('Read delegation refused'); };
  const equal = (value: unknown, want: string) => {
    if (typeof value === 'string') { if (value !== want) refuse(); return; }
    if (Array.isArray(value)) { if (value.some((v) => v !== want)) refuse(); return; }
    if (value !== null && value !== undefined) refuse();
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8) refuse();
    if (Array.isArray(value)) { value.forEach((v) => walk(v, depth + 1)); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (CLIENT_SELECTORS.has(key)) equal(child, delegated.clientId);
      else if (CONVERSATION_SELECTORS.has(key)) equal(child, delegated.conversationId);
      else walk(child, depth + 1);
    }
  };
  if (!body || typeof body !== 'object' || Array.isArray(body)) refuse();
  walk(body, 0);
  if (required.length && !required.some((k) => typeof (body as Record<string, unknown>)[k] === 'string' || Array.isArray((body as Record<string, unknown>)[k]))) refuse();
}
