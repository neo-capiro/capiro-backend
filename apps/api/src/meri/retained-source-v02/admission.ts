import { types as nodeTypes } from 'node:util';
import { ForbiddenException } from '@nestjs/common';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { MERI_RETAINED_SOURCE_TOOLS, READ_DELEGATION_LIMITS, canonicalSha256,
  isMeriRetainedSourceOperationVersion, isSha, isUuid, sha256Hex } from '../../auth/read-delegation/read-delegation.contract.js';
import type { MeriReadDelegationGrant } from '../../auth/read-delegation/read-delegation-request.js';
import type { DocumentTextOnlyAllocation } from '../../auth/read-delegation/read-delegation-document-pricing.js';

/** Exact Core retained source names. These are deliberately separate from the legacy
 * `/api/clio/tools/:name` manifest and do not activate those routes. */
export const RETAINED_SOURCE_V02_OPERATIONS: ReadonlySet<string> = MERI_RETAINED_SOURCE_TOOLS;

const CLIENT_ONLY = new Set([
  'read_monday_client_boards', 'get_client_context', 'meeting.query_debriefs',
  'meeting.read_client_meetings', 'read_client_documents',
]);
const CLIENT_SELECTORS = new Set(['clientId', 'client_id', 'clientIds', 'client_ids', 'clientRef', 'client', 'selectedClientId']);
const CONVERSATION_SELECTORS = new Set(['conversationId', 'conversation_id']);
const denied = () => new ForbiddenException('Retained source read refused');

/** The source correlation is sent as exact canonical JSON in a dedicated
 * header. The signed one-use token must commit to these bytes by SHA-256.
 * Operation and hashes are Core-verified values, never header assertions. */
export interface AuthenticatedRetainedSourceCorrelation {
  binding: {
    tenantId: string; actorId: string; conversationId: string; runId: string;
    attemptId: string; workerId: string; writerFence: number;
  };
  subject: {
    kind: string; entityType: string; entityIds: string[]; tenantId: string; actorId: string;
    authorizationDecisionId: string; policyRevision: string; scopes: Array<Record<string, unknown>>;
    rosterVersionId: string | null;
  };
  policyRevision: string;
  normalizationContext: Record<string, unknown> | null;
}

export interface RetainedSourceV02Admission {
  operation: { id: string; version: '0.2.0' | '0.3.0' };
  binding: AuthenticatedRetainedSourceCorrelation['binding'];
  subject: AuthenticatedRetainedSourceCorrelation['subject'];
  input: Record<string, unknown>;
  metadata: unknown;
  normalizationContext: Record<string, unknown> | null;
  argumentsSha256: string;
  requestSha256: string;
  clientId: string;
  hardExpiryMs: number;
  documentTextOnlyAllocation?: DocumentTextOnlyAllocation | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !nodeTypes.isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!record(value)) throw denied();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) ||
      required.some((key) => !keys.includes(key))) throw denied();
  if (keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor || !descriptor.enumerable || !('value' in descriptor);
  })) throw denied();
  return value;
}
/** Copy through RFC 8785 JSON so later caller mutation cannot change the
 * admitted input or the hashes. Reject accessors, proxies and non-JSON data. */
function snapshot<T>(value: T): T {
  try { return JSON.parse(canonicalizeCoreRetainedJson(value)) as T; }
  catch { throw denied(); }
}
function checkSelectors(input: Record<string, unknown>, grant: MeriReadDelegationGrant, personal: boolean): void {
  const seen = new Set<object>();
  let count = 0;
  const equal = (value: unknown, wanted: string) => {
    if (typeof value !== 'string' || value !== wanted) throw denied();
  };
  const walk = (value: unknown, depth: number): void => {
    if (++count > 4096 || depth > 12) throw denied();
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) throw denied();
    seen.add(value);
    if (Array.isArray(value)) { value.forEach((part) => walk(part, depth + 1)); return; }
    if (!record(value)) throw denied();
    for (const [key, part] of Object.entries(value)) {
      if (CLIENT_SELECTORS.has(key)) {
        if (part === null && personal) continue;
        if (Array.isArray(part)) {
          if (part.length === 0) throw denied();
          part.forEach((item) => equal(item, grant.clientId));
        } else equal(part, grant.clientId);
      } else if (CONVERSATION_SELECTORS.has(key)) equal(part, grant.conversationId);
      else walk(part, depth + 1);
    }
  };
  walk(input, 0);
}

/** Pure post-auth admission. `grant` and the parsed correlation must come from
 * `meriReadDelegationOf(req)` and `meriRetainedCorrelationOf(req)` after the
 * middleware checked exact canonical header bytes. Recompute that signed hash
 * here; bare `{input,metadata}` never establishes task lineage. This helper
 * does not issue credentials, prove source currentness, or release a result. */
export function assertRetainedSourceV02Admission(
  grant: MeriReadDelegationGrant | undefined,
  protocol: unknown,
  authenticatedCorrelation: unknown,
  options: { nowMs: number; personalOwnerAuthorized?: boolean },
): RetainedSourceV02Admission {
  if (!grant || grant.kind !== 'tool' || !grant.operation ||
      !Number.isSafeInteger(options.nowMs) || options.nowMs >= grant.hardExpiryMs ||
      !isMeriRetainedSourceOperationVersion(grant.operation)) throw denied();
  const wire = snapshot(exact(protocol, ['input', 'metadata']));
  if (!record(wire.input)) throw denied();
  let correlationJson: string;
  try {
    correlationJson = canonicalizeCoreRetainedJson(authenticatedCorrelation);
  } catch { throw denied(); }
  if (Buffer.byteLength(correlationJson, 'utf8') < 2 || Buffer.byteLength(correlationJson, 'utf8') > 8192 ||
      !isSha(grant.correlationSha256) || sha256Hex(Buffer.from(correlationJson, 'utf8')) !== grant.correlationSha256) throw denied();
  const correlation = snapshot(exact(authenticatedCorrelation,
    ['binding', 'subject', 'policyRevision', 'normalizationContext']));
  const operation = { id: grant.operation.id, version: grant.operation.version };
  const binding = exact(correlation.binding,
    ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence']);
  if (binding.tenantId !== grant.tenantId || binding.actorId !== grant.actorId ||
      binding.conversationId !== grant.conversationId || binding.runId !== grant.runId ||
      !isUuid(binding.attemptId) || binding.attemptId !== grant.binding.attemptId || !isUuid(binding.workerId) ||
      !Number.isSafeInteger(binding.writerFence) || (binding.writerFence as number) < 1 ||
      canonicalSha256(binding) !== canonicalSha256(grant.admittedBinding)) throw denied();
  const subject = exact(correlation.subject,
    ['kind', 'entityType', 'entityIds', 'tenantId', 'actorId', 'authorizationDecisionId',
      'policyRevision', 'scopes', 'rosterVersionId']);
  if (correlation.policyRevision !== grant.policyRevision ||
      subject.tenantId !== grant.tenantId || subject.actorId !== grant.actorId ||
      !isUuid(subject.authorizationDecisionId) || typeof subject.policyRevision !== 'string' ||
      subject.policyRevision !== grant.policyRevision || !Array.isArray(subject.entityIds) || subject.entityIds.length !== 1 ||
      !Array.isArray(subject.scopes) || subject.scopes.length === 0 || subject.scopes.length > 4096) throw denied();
  const personal = subject.kind === 'personal';
  if (personal) {
    if (options.personalOwnerAuthorized !== true || CLIENT_ONLY.has(grant.operation.id) ||
        subject.entityType !== 'user' || subject.entityIds[0] !== grant.actorId) throw denied();
  } else if (subject.kind !== 'client' || subject.entityType !== 'client' || subject.entityIds[0] !== grant.clientId) throw denied();
  for (const scope of subject.scopes) {
    if (!record(scope) || scope.tenantId !== grant.tenantId || scope.policyRevision !== subject.policyRevision ||
        scope.kind === 'client' && scope.resourceId !== grant.clientId) throw denied();
  }
  const input = snapshot(wire.input as Record<string, unknown>);
  const metadata = snapshot(wire.metadata);
  const requestSha256 = canonicalSha256({ input, metadata });
  const argumentsSha256 = canonicalSha256(input);
  if (!isSha(grant.argumentsSha256) || grant.argumentsSha256 !== argumentsSha256 ||
      Buffer.byteLength(canonicalizeCoreRetainedJson({ input, metadata }), 'utf8') > READ_DELEGATION_LIMITS.maxBodyBytes) throw denied();
  checkSelectors(input, grant, personal);
  if (CLIENT_ONLY.has(grant.operation.id) && input.clientId !== grant.clientId) throw denied();
  const inputSubject = input.subject;
  if (personal && inputSubject === undefined) throw denied();
  if (inputSubject !== undefined) {
    const selected = exact(inputSubject, personal ? ['kind'] : ['kind', 'entityId']);
    if (selected.kind !== subject.kind || !personal && selected.entityId !== grant.clientId) throw denied();
  }
  if (correlation.normalizationContext !== null && !record(correlation.normalizationContext)) throw denied();
  const normalizationContext = snapshot(correlation.normalizationContext as Record<string, unknown> | null);
  const documentTextOnlyAllocation = operation.id === 'read_client_documents'
    ? snapshot(grant.documentTextOnlyAllocation ?? null) : undefined;
  if (documentTextOnlyAllocation) {
    Object.freeze(documentTextOnlyAllocation.documentPricing);
    Object.freeze(documentTextOnlyAllocation);
  }
  return Object.freeze({ operation: snapshot(operation) as unknown as RetainedSourceV02Admission['operation'],
    binding: snapshot(binding) as unknown as RetainedSourceV02Admission['binding'],
    subject: snapshot(subject) as unknown as RetainedSourceV02Admission['subject'],
    input, metadata, normalizationContext,
    argumentsSha256, requestSha256, clientId: grant.clientId, hardExpiryMs: grant.hardExpiryMs,
    ...(operation.id === 'read_client_documents'
      ? { documentTextOnlyAllocation } : {}) });
}
