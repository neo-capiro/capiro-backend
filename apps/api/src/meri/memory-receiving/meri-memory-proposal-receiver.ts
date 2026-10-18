import { types as nodeTypes } from 'node:util';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import type { TenantContext } from '@capiro/shared';
import type { MeriPendingMemoryProposalRead } from '@capiro/shared/meri-read-outcome';
import { canonicalSha256, isSha, isUuid, sha256Hex } from '../../auth/read-delegation/read-delegation.contract.js';
import type { MeriReadDelegationGrant } from '../../auth/read-delegation/read-delegation-request.js';
import type { GovernedMemoryCandidateService } from '../../memory/governed-memory-candidate.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { parseTaskBoundMemoryProposalSelection, readTaskBoundMemoryProposalPage,
  type MemoryProposalSelection } from './meri-memory-proposal-source.js';

/** PR172 sends the original reserved operation, not Core's old raw tool alias. */
export const SIGNED_MEMORY_PROPOSAL_OPERATION = Object.freeze({ id: 'memory.list_own_proposals', version: '0.2.0' });
export const SIGNED_MEMORY_PROPOSAL_PATH = '/api/clio/tools/memory.list_own_proposals';
const RETRIEVAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALL_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_OUTPUT_BYTES = 262_144; // Meri's private proposal DTO bound.
const denied = () => new ForbiddenException('Reserved memory proposal read refused');

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !nodeTypes.isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value)) throw denied();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some((name) => typeof name !== 'string' || !keys.includes(name))) throw denied();
  for (const name of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw denied();
  }
  return value;
}

function boundText(value: unknown, max: number, min = 0): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function dateTime(value: unknown): number {
  // The canonical owner produces Date.toISOString(); requiring that exact form
  // also rejects Date.parse calendar rollovers that Meri's format check rejects.
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) throw denied();
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) throw denied();
  return instant;
}

/** Snapshot the trusted owner's page without invoking accessors or accepting
 * extra/sparse/recursive data. The returned JSON is the exact released DTO. */
function snapshotPage(value: unknown): MeriPendingMemoryProposalRead {
  const seen = new Set<object>();
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++nodes > 512 || next.depth > 12) throw denied();
    const item = next.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean' ||
        typeof item === 'number' && Number.isFinite(item)) continue;
    if (!item || typeof item !== 'object' || nodeTypes.isProxy(item) || seen.has(item)) throw denied();
    seen.add(item);
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype) && Object.getPrototypeOf(item) !== null)
      throw denied();
    const keys = Reflect.ownKeys(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (keys.length > 512 || keys.some((key) => typeof key !== 'string' ||
        !Object.hasOwn(descriptors[key]!, 'value') || !descriptors[key]!.enumerable && !(array && key === 'length')))
      throw denied();
    if (array && (keys.length !== item.length + 1 ||
        keys.some((key, index) => key !== (index === item.length ? 'length' : String(index))))) throw denied();
    for (const key of keys) if (!(array && key === 'length')) pending.push({ value: descriptors[key as string]!.value, depth: next.depth + 1 });
  }
  let encoded: string;
  try { encoded = canonicalizeCoreRetainedJson(value); } catch { throw denied(); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_OUTPUT_BYTES) throw denied();
  return JSON.parse(encoded) as MeriPendingMemoryProposalRead;
}

function assertProposalResult(page: MeriPendingMemoryProposalRead, selection: MemoryProposalSelection,
  ctx: Pick<TenantContext, 'tenantId' | 'userId'>): void {
  const p = exact(page, ['tool', 'enabled', 'authority', 'claimsAreApprovedFacts', 'scope',
    'candidates', 'nextCursor', 'coverage']);
  if (p.tool !== 'list_memory_proposals' || typeof p.enabled !== 'boolean' ||
      p.authority !== 'own_pending_proposals' || p.claimsAreApprovedFacts !== false) throw denied();
  const scope = exact(p.scope, ['tenantId', 'userId', 'clientId']);
  if (scope.tenantId !== ctx.tenantId || scope.userId !== ctx.userId || scope.clientId !== selection.clientId ||
      !RETRIEVAL_UUID.test(String(scope.tenantId)) || !RETRIEVAL_UUID.test(String(scope.userId))) throw denied();
  if (!Array.isArray(p.candidates) || p.candidates.length > selection.limit || p.candidates.length > 10 ||
      !(p.nextCursor === null || boundText(p.nextCursor, 2048, 1))) throw denied();
  if (p.nextCursor !== null && (p.nextCursor === selection.cursor || p.candidates.length === 0)) throw denied();
  const ids = new Set<string>();
  let previous: { created: number; id: string } | undefined;
  for (const item of p.candidates) {
    const row = exact(item, ['id', 'status', 'approvedFact', 'scope', 'clientId', 'sourceKind',
      'createdAt', 'restricted', 'title', 'proposedText', 'contentTruncated']);
    if (!RETRIEVAL_UUID.test(String(row.id)) || ids.has((row.id as string).toLowerCase()) ||
        row.status !== 'pending' || row.approvedFact !== false ||
        !['firm', 'client', 'personal'].includes(String(row.scope)) ||
        !(row.clientId === null || typeof row.clientId === 'string' && RETRIEVAL_UUID.test(row.clientId)) ||
        (row.scope === 'client') !== (row.clientId !== null) ||
        row.clientId !== null && row.clientId !== selection.clientId ||
        !boundText(row.sourceKind, 256, 1) || typeof row.restricted !== 'boolean' ||
        !(row.title === null || boundText(row.title, 200)) ||
        !(row.proposedText === null || boundText(row.proposedText, 2000)) ||
        typeof row.contentTruncated !== 'boolean' ||
        row.restricted && (row.title !== null || row.proposedText !== null || row.contentTruncated !== false)) throw denied();
    const created = dateTime(row.createdAt);
    const id = (row.id as string).toLowerCase();
    if (previous && (created > previous.created || created === previous.created && id >= previous.id)) throw denied();
    previous = { created, id };
    ids.add(id);
  }
  const coverage = exact(p.coverage, ['firstPage', 'complete', 'reason']);
  if (coverage.firstPage !== (selection.cursor === null) || typeof coverage.complete !== 'boolean') throw denied();
  if (p.enabled === false) {
    if (p.candidates.length || p.nextCursor !== null || coverage.complete !== false || coverage.reason !== 'review_disabled') throw denied();
  } else {
    const complete = selection.cursor === null && p.nextCursor === null && p.candidates.every((row) => {
      const candidate = row as Record<string, unknown>;
      return candidate.restricted === false && candidate.contentTruncated === false && candidate.proposedText !== null;
    });
    if (coverage.complete !== complete || coverage.reason !== (complete
      ? 'own_pending_proposals_complete' : 'unread_pages_restricted_or_truncated_content')) throw denied();
  }
}

export interface SignedMemoryProposalAdmission {
  selection: MemoryProposalSelection;
  requestSha256: string;
  hardExpiryMs: number;
}

/** Post-middleware admission. The middleware has already verified the exact
 * Ed25519 target/body/correlation, consumed one JTI and checked the original
 * ADMITTED grant plus UNKNOWN reservation under the budget lock. Recheck its
 * request-local grant against PR172's emitted bytes and selected subject. */
export function admitSignedMemoryProposalPage(
  ctx: Pick<TenantContext, 'tenantId' | 'userId'>, raw: unknown,
  grant: MeriReadDelegationGrant | undefined, authenticatedCorrelation: unknown,
  verifiedServiceIdentity: boolean, nowMs: number,
): SignedMemoryProposalAdmission {
  if (!grant || !verifiedServiceIdentity || grant.kind !== 'tool' ||
      grant.operation?.id !== SIGNED_MEMORY_PROPOSAL_OPERATION.id ||
      grant.operation.version !== SIGNED_MEMORY_PROPOSAL_OPERATION.version ||
      grant.tenantId !== ctx.tenantId || grant.actorId !== ctx.userId ||
      !isUuid(grant.clientId) || !isUuid(grant.delegationId) || !isUuid(grant.jti) ||
      !CALL_KEY.test(grant.callKey) || !Number.isSafeInteger(nowMs) ||
      !Number.isSafeInteger(grant.hardExpiryMs) || nowMs >= grant.hardExpiryMs ||
      !isSha(grant.argumentsSha256) || !isSha(grant.bodySha256) ||
      !isSha(grant.correlationSha256) || grant.toolRequestSha256 !== null || grant.referenceSha256 !== null) throw denied();
  const wire = exact(raw, ['input', 'metadata']);
  if (wire.metadata !== null) throw denied();
  const selection = parseTaskBoundMemoryProposalSelection(wire.input);
  if (selection.clientId !== grant.clientId || canonicalSha256(selection) !== grant.argumentsSha256 ||
      sha256Hex(JSON.stringify({ input: { clientId: selection.clientId, cursor: selection.cursor,
        limit: selection.limit }, metadata: null })) !== grant.bodySha256) throw denied();

  const correlation = exact(authenticatedCorrelation,
    ['binding', 'subject', 'policyRevision', 'normalizationContext']);
  let correlationJson: string;
  try { correlationJson = canonicalizeCoreRetainedJson(correlation); } catch { throw denied(); }
  if (Buffer.byteLength(correlationJson, 'utf8') > 8192 ||
      sha256Hex(Buffer.from(correlationJson, 'utf8')) !== grant.correlationSha256 ||
      correlation.policyRevision !== grant.policyRevision || correlation.normalizationContext !== null) throw denied();
  const binding = exact(correlation.binding,
    ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence']);
  if (canonicalSha256(binding) !== canonicalSha256(grant.admittedBinding) ||
      binding.tenantId !== grant.tenantId || binding.actorId !== grant.actorId ||
      binding.conversationId !== grant.conversationId || binding.runId !== grant.runId ||
      binding.attemptId !== grant.binding.attemptId || binding.writerFence !== grant.binding.writerFence) throw denied();
  const subject = exact(correlation.subject,
    ['kind', 'entityType', 'entityIds', 'tenantId', 'actorId', 'authorizationDecisionId',
      'policyRevision', 'scopes', 'rosterVersionId']);
  if (subject.kind !== 'client' || subject.entityType !== 'client' ||
      !Array.isArray(subject.entityIds) || subject.entityIds.length !== 1 || subject.entityIds[0] !== grant.clientId ||
      subject.tenantId !== grant.tenantId || subject.actorId !== grant.actorId ||
      !isUuid(subject.authorizationDecisionId) || subject.policyRevision !== grant.policyRevision ||
      subject.rosterVersionId !== null || !Array.isArray(subject.scopes) || subject.scopes.length !== 1) throw denied();
  const scope = exact(subject.scopes[0], ['tenantId', 'kind', 'resourceId', 'policyRevision']);
  if (scope.tenantId !== grant.tenantId || scope.kind !== 'client' || scope.resourceId !== grant.clientId ||
      scope.policyRevision !== grant.policyRevision) throw denied();
  return Object.freeze({ selection: Object.freeze(selection),
    requestSha256: canonicalSha256({ input: selection, metadata: null }), hardExpiryMs: grant.hardExpiryMs });
}

/** This handler is deliberately unregistered. The shared tools controller must
 * branch on the exact dotted name before the model-facing allowlist, and only
 * after the issuer/consumer hard-off gate has been deliberately qualified. */
export async function receiveSignedMemoryProposalPage(options: {
  ctx: TenantContext;
  raw: unknown;
  grant: MeriReadDelegationGrant | undefined;
  authenticatedCorrelation: unknown;
  verifiedServiceIdentity: boolean;
  prisma: Pick<PrismaService, 'withTenantUser'>;
  owner: Pick<GovernedMemoryCandidateService, 'listOwnProposals'>;
  releaseDelegatedRead: () => Promise<void>;
  now?: () => number;
}): Promise<MeriPendingMemoryProposalRead> {
  const { ctx, raw, grant, authenticatedCorrelation, verifiedServiceIdentity,
    prisma, owner, releaseDelegatedRead, now = Date.now } = options;
  if (typeof releaseDelegatedRead !== 'function') throw new ServiceUnavailableException('Reserved memory proposal read unavailable');
  const admitted = admitSignedMemoryProposalPage(ctx, raw, grant, authenticatedCorrelation,
    verifiedServiceIdentity, now());
  const result = await readTaskBoundMemoryProposalPage(ctx, admitted.selection, grant, prisma, owner, now);
  const page = snapshotPage(result);
  assertProposalResult(page, admitted.selection, ctx);
  if (now() >= admitted.hardExpiryMs) throw denied();
  await releaseDelegatedRead();
  if (now() >= admitted.hardExpiryMs) throw denied();
  return page;
}
