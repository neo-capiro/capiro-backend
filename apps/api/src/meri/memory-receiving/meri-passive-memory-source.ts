import { types as nodeTypes } from 'node:util';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { canonicalSha256, isSha, isUuid } from '../../auth/read-delegation/read-delegation.contract.js';
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  canonicalMemoryEligibilitySql,
  includeCanonicalGovernedMemoryRow,
  type CanonicalGovernedMemoryRow,
} from '../../retrieval/adapters/governed-memory-eligibility.helpers.js';

/** The passive source is separate from the model-facing raw search_memory tool.
 * Meri must supply its current run-bound read authority at the HTTP boundary;
 * neither this payload nor the internal service secret grants that authority. */
const SOURCE_ID = 'client_knowledge_memory';
const METADATA_KEYS = [
  'sourceConnected', 'authoritative', 'currentPolicyQualified',
  'cursorAuthenticated', 'absenceEvidence',
] as const;
const INPUT_KEYS = [
  'query', 'clientId', 'k', 'cursor', 'memoryItemId', 'contentCursor',
] as const;
const denied = () => new ForbiddenException('Passive memory source refused');
const invalid = () => new BadRequestException('Invalid passive memory source request');

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    !nodeTypes.isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value)) throw invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
      keys.some((key) => !own.includes(key)) || own.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor || !descriptor.enumerable || !('value' in descriptor);
      })) throw invalid();
  return value;
}

function json<T>(value: T, maxBytes = 16_384): T {
  try {
    const encoded = canonicalizeCoreRetainedJson(value);
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw invalid();
    return JSON.parse(encoded) as T;
  } catch { throw invalid(); }
}

function nullableText(value: unknown, max: number): value is string | null {
  return value === null || typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
}

export interface PassiveMemoryInput {
  query: string | null;
  clientId: string | null;
  k: number;
  cursor: string | null;
  memoryItemId: string | null;
  contentCursor: string | null;
}

export type PassiveMemoryMetadata = Record<(typeof METADATA_KEYS)[number], false>;

export interface PassiveMemoryWire {
  input: PassiveMemoryInput;
  metadata: PassiveMemoryMetadata;
}

/** Exact normalized search_memory@0.2.0 body. No field here conveys access. */
export function parsePassiveMemoryWire(raw: unknown): PassiveMemoryWire {
  const wire = closed(json(raw), ['input', 'metadata']);
  const input = closed(wire.input, INPUT_KEYS);
  const metadata = closed(wire.metadata, METADATA_KEYS);
  if (!nullableText(input.query, 400) || !nullableText(input.clientId, 80) ||
      input.clientId !== null && !isUuid(input.clientId) ||
      !Number.isSafeInteger(input.k) || (input.k as number) < 1 || (input.k as number) > 15 ||
      !nullableText(input.cursor, 8192) ||
      !nullableText(input.memoryItemId, 80) || input.memoryItemId !== null && !isUuid(input.memoryItemId) ||
      !nullableText(input.contentCursor, 1024) ||
      input.contentCursor !== null && input.memoryItemId === null ||
      input.memoryItemId !== null && input.cursor !== null ||
      METADATA_KEYS.some((key) => metadata[key] !== false)) throw invalid();
  return json(wire) as unknown as PassiveMemoryWire;
}

type MemoryReader = Pick<import('../meri-tools.service.js').MeriToolsService, 'executeFromAuthenticatedUser'>;

/** Calls the existing canonical Core handler with only Meri's normalized input. */
export async function readPassiveMemorySource(
  ctx: TenantContext,
  raw: unknown,
  tools: MemoryReader,
): Promise<unknown> {
  const { input } = parsePassiveMemoryWire(raw);
  // Client and General requests use the same canonical governed-memory owner.
  // A null selection does not create a client scope or bypass any client wall.
  return tools.executeFromAuthenticatedUser(ctx, 'search_memory', input as unknown as Record<string, unknown>);
}

export interface PassiveMemoryEligibilityRequest extends PassiveMemoryWire {
  operation: { id: 'search_memory'; version: '0.2.0' };
  normalizationContext: { tenantId: string; userId: string };
  argumentsSha256: string;
  requestSha256: string;
  binding: {
    tenantId: string; actorId: string; conversationId: string; runId: string;
    attemptId: string; workerId: string; writerFence: number;
  };
  subject: {
    kind: 'client' | 'personal'; entityType: 'client' | 'user'; entityIds: string[];
    tenantId: string; actorId: string;
    policyRevision: string; scopes: Array<{
      tenantId: string; kind: string; resourceId: string; policyRevision: string;
    }>; rosterVersionId: null;
  };
  policyRevision: string;
  sourceIds: ['client_knowledge_memory'];
  resultSha256: string;
  records: Array<{ memoryItemId: string; recordSha256: string }>;
  deadlineMs: number;
}

/** Parse the Meri callback pins, not an authority decision. The HTTP receiver
 * must first authenticate the native user and verified service identity. */
export function parsePassiveMemoryEligibilityRequest(
  raw: unknown,
  ctx: Pick<TenantContext, 'tenantId' | 'userId'>,
  nowMs: number,
): PassiveMemoryEligibilityRequest {
  const request = closed(json(raw, 16_384), [
    'operation', 'input', 'metadata', 'normalizationContext', 'argumentsSha256',
    'requestSha256', 'binding', 'subject', 'policyRevision', 'sourceIds',
    'resultSha256', 'records', 'deadlineMs',
  ]);
  const wire = parsePassiveMemoryWire({ input: request.input, metadata: request.metadata });
  const operation = closed(request.operation, ['id', 'version']);
  const normalizationContext = closed(request.normalizationContext, ['tenantId', 'userId']);
  const binding = closed(request.binding, [
    'tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence',
  ]);
  const subject = closed(request.subject, [
    'kind', 'entityType', 'entityIds', 'tenantId', 'actorId',
    'policyRevision', 'scopes', 'rosterVersionId',
  ]);
  if (operation.id !== 'search_memory' || operation.version !== '0.2.0' ||
      normalizationContext.tenantId !== ctx.tenantId || normalizationContext.userId !== ctx.userId ||
      binding.tenantId !== ctx.tenantId || binding.actorId !== ctx.userId ||
      ![binding.conversationId, binding.runId, binding.attemptId, binding.workerId].every(isUuid) ||
      !Number.isSafeInteger(binding.writerFence) || (binding.writerFence as number) < 1 ||
      subject.tenantId !== ctx.tenantId || subject.actorId !== ctx.userId ||
      subject.rosterVersionId !== null ||
      !Array.isArray(subject.entityIds) || subject.entityIds.length !== 1 ||
      !Array.isArray(subject.scopes) || subject.scopes.length < 1 || subject.scopes.length > 4096 ||
      typeof request.policyRevision !== 'string' || request.policyRevision.length < 1 || request.policyRevision.length > 128 ||
      subject.policyRevision !== request.policyRevision ||
      !isSha(request.argumentsSha256) || request.argumentsSha256 !== canonicalSha256(wire.input) ||
      !isSha(request.requestSha256) || request.requestSha256 !== canonicalSha256(wire) ||
      !Array.isArray(request.sourceIds) || request.sourceIds.length !== 1 || request.sourceIds[0] !== SOURCE_ID ||
      !isSha(request.resultSha256) ||
      !Number.isSafeInteger(request.deadlineMs) || !Number.isSafeInteger(nowMs) ||
      (request.deadlineMs as number) <= nowMs || (request.deadlineMs as number) > nowMs + 60_000) throw denied();
  if (wire.input.clientId === null) {
    if (subject.kind !== 'personal' || subject.entityType !== 'user' || subject.entityIds[0] !== ctx.userId) throw denied();
  } else if (subject.kind !== 'client' || subject.entityType !== 'client' || subject.entityIds[0] !== wire.input.clientId) {
    throw denied();
  }
  let selectedScopePresent = false;
  for (const candidate of subject.scopes) {
    const scope = closed(candidate, ['tenantId', 'kind', 'resourceId', 'policyRevision']);
    if (scope.tenantId !== ctx.tenantId || scope.policyRevision !== request.policyRevision ||
        typeof scope.resourceId !== 'string' || scope.resourceId.length < 1 || scope.resourceId.length > 256 ||
        typeof scope.kind !== 'string' ||
        scope.kind === 'client' && scope.resourceId !== wire.input.clientId ||
        scope.kind === 'private-user' && scope.resourceId !== ctx.userId) throw denied();
    if (scope.kind === (wire.input.clientId === null ? 'private-user' : 'client') &&
        scope.resourceId === (wire.input.clientId ?? ctx.userId)) selectedScopePresent = true;
  }
  if (!selectedScopePresent) throw denied();
  if (!Array.isArray(request.records) || request.records.length > 3) throw denied();
  const seen = new Set<string>();
  for (const candidate of request.records) {
    const record = closed(candidate, ['memoryItemId', 'recordSha256']);
    if (!isUuid(record.memoryItemId) || !isSha(record.recordSha256) || seen.has(record.memoryItemId)) throw denied();
    seen.add(record.memoryItemId);
  }
  return json(request, 16_384) as unknown as PassiveMemoryEligibilityRequest;
}

export async function checkPassiveMemoryEligibility(
  prisma: PrismaService,
  ctx: TenantContext,
  raw: unknown,
  now: () => number = Date.now,
) {
  const request = parsePassiveMemoryEligibilityRequest(raw, ctx, now());
  const { clientId } = request.input;
  await prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    // Recheck the selected client even for an empty result. The user bearer
    // establishes the actor, while this transaction observes the current wall.
    if (clientId !== null && !await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId)) throw denied();
    const allowedClientIds = clientId === null ? [] : [clientId];
    for (const record of request.records) {
      const rows = await tx.$queryRaw<CanonicalGovernedMemoryRow[]>(Prisma.sql`
        SELECT mi.id::text AS id, mi.tenant_id::text AS "tenantId",
               mi.client_id::text AS "clientId", mi.owner_user_id::text AS "ownerUserId",
               mi.visibility, mi.status AS "legacyStatus", mi.memory_class AS "memoryClass",
               mi.memory_authority AS authority, mi.memory_scope AS scope,
               mi.governed_status AS status, mi.conflict_status AS "conflictStatus",
               mi.controlling_item_id::text AS "controllingItemId", mi.sensitivity,
               mi.source_type AS "sourceType", mi.source_id AS "sourceId",
               mi.source_ref AS "sourceRef", mi.approved_by_user_id::text AS "approvedByUserId",
               mi.approved_at AS "approvedAt", mi.effective_from AS "effectiveFrom",
               mi.valid_until AS "validUntil", mi.expires_at AS "expiresAt"
        FROM memory_items mi
        WHERE ${canonicalMemoryEligibilitySql({
          tenantId: ctx.tenantId, userId: ctx.userId, allowedClientIds, memoryItemId: record.memoryItemId,
        })}
      `);
      if (rows.length !== 1 || rows[0]?.id !== record.memoryItemId ||
          rows[0].clientId !== null && rows[0].clientId !== clientId ||
          !includeCanonicalGovernedMemoryRow(rows[0], {
            tenantId: ctx.tenantId, userId: ctx.userId, allowedClientIds,
          })) throw denied();
    }
  });
  const checkedAtMs = now();
  const expiresAtMs = Math.min(request.deadlineMs, checkedAtMs + 5_000);
  if (!Number.isSafeInteger(checkedAtMs) || expiresAtMs <= checkedAtMs) throw denied();
  return {
    operation: request.operation,
    argumentsSha256: request.argumentsSha256,
    metadata: request.metadata,
    normalizationContext: request.normalizationContext,
    requestSha256: request.requestSha256,
    binding: request.binding,
    subject: request.subject,
    policyRevision: request.policyRevision,
    sourceIds: request.sourceIds,
    resultSha256: request.resultSha256,
    checkedAtMs,
    expiresAtMs,
    records: request.records.map((record) => ({ ...record, eligibleForRecall: true as const })),
  };
}
