import { types as nodeTypes } from 'node:util';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { canonicalSha256, isSha, isUuid, sha256Hex } from '../../auth/read-delegation/read-delegation.contract.js';
import type { MeriReadDelegationGrant } from '../../auth/read-delegation/read-delegation-request.js';
import { parsePassiveMemoryWire, type PassiveMemoryWire } from './meri-passive-memory-source.js';

/** The page token and signed correlation must be obtained from the tenant
 * middleware's request-local maps. A callback body or service secret is not a
 * substitute for either value. This source is deliberately not mounted until
 * the shared memory page/helper credential and release protocol is complete. */
const denied = () => new ForbiddenException('Passive memory page refused');

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw denied();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
      own.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor || !descriptor.enumerable || !('value' in descriptor);
      })) throw denied();
  return value as Record<string, unknown>;
}

export interface AdmittedPassiveMemoryPage {
  wire: PassiveMemoryWire;
  requestSha256: string;
  argumentsSha256: string;
  parentTokenJti: string;
  parentBodySha256: string;
  callKey: string;
  clientId: string | null;
  scopeKind?: 'general';
  hardExpiryMs: number;
}

/** Pure last-mile check for the exact client-scoped search_memory@0.2.0 page.
 * The existing CapiroMeriRead middleware has already consumed one token and
 * checked the original ADMITTED run, UNKNOWN reservation, current delegation,
 * unattended consent, member and visible client under its transaction lock.
 * No route currently calls this function; this does not make recall available. */
export function admitPassiveMemoryPage(
  ctx: TenantContext,
  raw: unknown,
  grant: MeriReadDelegationGrant | undefined,
  authenticatedCorrelation: unknown,
  nowMs: number,
): AdmittedPassiveMemoryPage {
  if (!grant || grant.kind !== 'tool' || grant.operation?.id !== 'search_memory' ||
      grant.operation.version !== '0.2.0' || !Number.isSafeInteger(nowMs) || nowMs >= grant.hardExpiryMs ||
      grant.tenantId !== ctx.tenantId || grant.actorId !== ctx.userId ||
      grant.binding.tenantId !== grant.tenantId || grant.binding.actorId !== grant.actorId ||
      grant.binding.conversationId !== grant.conversationId || grant.binding.runId !== grant.runId ||
      !isSha(grant.correlationSha256) || !isSha(grant.bodySha256)) throw denied();
  let wire: PassiveMemoryWire;
  try { wire = parsePassiveMemoryWire(raw); } catch { throw denied(); }
  const general = grant.scopeKind === 'general';
  if ((general ? grant.clientId !== null || grant.targetClientId !== null || grant.mode !== 'attended'
    : !isUuid(grant.clientId)) || wire.input.clientId !== grant.clientId ||
      canonicalSha256(wire.input) !== grant.argumentsSha256) throw denied();

  const correlation = exact(authenticatedCorrelation,
    ['binding', 'subject', 'policyRevision', 'normalizationContext']);
  let encoded: string;
  try { encoded = canonicalizeCoreRetainedJson(correlation); } catch { throw denied(); }
  if (Buffer.byteLength(encoded, 'utf8') > 8192 || sha256Hex(Buffer.from(encoded, 'utf8')) !== grant.correlationSha256)
    throw denied();
  const binding = exact(correlation.binding,
    ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence']);
  const admitted = grant.admittedBinding;
  for (const key of ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence'] as const) {
    if (binding[key] !== admitted[key]) throw denied();
  }
  if (binding.attemptId !== grant.binding.attemptId || binding.writerFence !== grant.binding.writerFence ||
      correlation.policyRevision !== grant.policyRevision) throw denied();
  const normalization = exact(correlation.normalizationContext, ['tenantId', 'userId']);
  if (normalization.tenantId !== ctx.tenantId || normalization.userId !== ctx.userId) throw denied();
  const subject = exact(correlation.subject,
    ['kind', 'entityType', 'entityIds', 'tenantId', 'actorId', 'authorizationDecisionId',
      'policyRevision', 'scopes', 'rosterVersionId']);
  if (subject.kind !== (general ? 'personal' : 'client') || subject.entityType !== (general ? 'user' : 'client') ||
      !Array.isArray(subject.entityIds) || subject.entityIds.length !== 1 || subject.entityIds[0] !== (general ? ctx.userId : grant.clientId) ||
      subject.tenantId !== ctx.tenantId || subject.actorId !== ctx.userId ||
      subject.policyRevision !== grant.policyRevision || subject.rosterVersionId !== null ||
      !isUuid(subject.authorizationDecisionId) ||
      !Array.isArray(subject.scopes) || subject.scopes.length < 1 || subject.scopes.length > 4096 ||
      general && subject.scopes.length !== 1) throw denied();
  let selected = false;
  for (const candidate of subject.scopes) {
    const scope = exact(candidate, ['tenantId', 'kind', 'resourceId', 'policyRevision']);
    if (scope.tenantId !== ctx.tenantId || scope.policyRevision !== grant.policyRevision ||
        typeof scope.kind !== 'string' || typeof scope.resourceId !== 'string' ||
        scope.kind === 'client' && scope.resourceId !== grant.clientId ||
        scope.kind === 'private-user' && scope.resourceId !== ctx.userId ||
        general && scope.kind !== 'private-user') throw denied();
    if (scope.kind === (general ? 'private-user' : 'client') && scope.resourceId === (general ? ctx.userId : grant.clientId)) selected = true;
  }
  if (!selected) throw denied();
  const frozenWire = Object.freeze({
    input: Object.freeze(wire.input), metadata: Object.freeze(wire.metadata),
  });
  return Object.freeze({ wire: frozenWire, requestSha256: canonicalSha256(frozenWire),
    argumentsSha256: grant.argumentsSha256, parentTokenJti: grant.jti, callKey: grant.callKey,
    parentBodySha256: grant.bodySha256,
    clientId: grant.clientId, ...(general ? { scopeKind: 'general' as const } : {}), hardExpiryMs: grant.hardExpiryMs });
}
