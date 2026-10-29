import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { ApplicationMembershipReceipt } from './application-membership.js';

export interface ApplicationAuthorityPrincipal {
  tenantId: string;
  actorId: string;
}
export interface ApplicationAuthorityIdentityEvidence {
  principal: ApplicationAuthorityPrincipal;
  identityRevision: string;
  expiresAtMs: number;
}
export interface ApplicationAuthorityIdentityReceipt extends ApplicationAuthorityIdentityEvidence {
  checkedAtMs: number;
}
/** Internal, request-local proof. Its callback is never included in a receipt. */
export interface ApplicationAuthorityIdentityProof extends ApplicationAuthorityIdentityEvidence {
  recheckCurrent(): Promise<ApplicationAuthorityIdentityEvidence>;
}
export interface ApplicationAuthorityContextRequest {
  identitySha256: string;
  conversationId: string;
  clientId: string;
}
export interface ApplicationAuthorityContextReceipt extends ApplicationAuthorityIdentityReceipt {
  identitySha256: string;
  conversationId: string;
  selectedClientId: string;
  contextRevision: string;
}
export interface ApplicationAuthorityCurrentRequest {
  conversationId: string;
  clientId: string | null;
  expect?: Partial<Record<'identityRevision' | 'membershipRevision' | 'contextRevision', string>>;
}
export type ApplicationAuthorityCurrentMembership = Pick<ApplicationMembershipReceipt,
  'role' | 'permissions' | 'clientIds' | 'membershipRevision'>;
export interface ApplicationAuthorityCurrentReceipt extends ApplicationAuthorityIdentityReceipt, ApplicationAuthorityCurrentMembership {
  conversationId: string;
  selectedClientId: string | null;
  contextRevision: string;
}
/** Only the explicit revision precondition yields the wire-level 409. */
export class ApplicationAuthorityChangedException extends ConflictException {
  constructor() { super({ error: 'CHANGED' }); }
}

// Wire syntax, not resource authority: nil and UUID versions 7/8 are allowed.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

export function assertApplicationAuthorityIdentityBody(body: unknown): void {
  closedBody(body, []);
}
export function parseApplicationAuthorityContextBody(body: unknown): ApplicationAuthorityContextRequest {
  const record = closedBody(body, ['identitySha256', 'conversationId', 'clientId']);
  const { identitySha256, conversationId, clientId } = record;
  if (typeof identitySha256 !== 'string' || !HASH.test(identitySha256) ||
      typeof conversationId !== 'string' || !UUID.test(conversationId) ||
      typeof clientId !== 'string' || !UUID.test(clientId)) {
    throw new BadRequestException('Invalid application authority request');
  }
  return { identitySha256, conversationId, clientId };
}

export function parseApplicationAuthorityCurrentBody(body: unknown): ApplicationAuthorityCurrentRequest {
  const record = closedBody(body, ['conversationId', 'clientId'], ['expect']);
  const { conversationId, clientId } = record;
  if (typeof conversationId !== 'string' || !UUID.test(conversationId) ||
      (clientId !== null && (typeof clientId !== 'string' || !UUID.test(clientId)))) {
    throw new BadRequestException('Invalid application authority request');
  }
  const result: ApplicationAuthorityCurrentRequest = { conversationId, clientId };
  if (Object.hasOwn(record, 'expect')) {
    const expected = closedBody(record.expect, [], ['identityRevision', 'membershipRevision', 'contextRevision']);
    for (const value of Object.values(expected)) {
      if (typeof value !== 'string' || !HASH.test(value)) throw new BadRequestException('Invalid application authority request');
    }
    result.expect = expected as ApplicationAuthorityCurrentRequest['expect'];
  }
  // Validate descriptors before serialization, so no caller getter/toJSON runs.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 4096) {
    throw new BadRequestException('Invalid application authority request');
  }
  return result;
}

function closedBody(body: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!body || typeof body !== 'object' || nodeTypes.isProxy(body) || Array.isArray(body) ||
      (Object.getPrototypeOf(body) !== Object.prototype && Object.getPrototypeOf(body) !== null)) {
    throw new BadRequestException('Invalid application authority request');
  }
  const own = Reflect.ownKeys(body);
  if (own.length < keys.length || own.some((key) => typeof key !== 'string' || ![...keys, ...optional].includes(key))) {
    throw new BadRequestException('Invalid application authority request');
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of [...keys, ...optional.filter((key) => own.includes(key))]) {
    const descriptor = Object.getOwnPropertyDescriptor(body, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new BadRequestException('Invalid application authority request');
    }
    result[key] = descriptor.value;
  }
  return result;
}

/** Deterministic digest of explicit server-owned facts, never an authority grant. */
export function applicationAuthorityRevision(kind: 'identity' | 'context' | 'artifact', facts: unknown): string {
  return createHash('sha256').update(`capiro-application-authority-${kind}-v1\n${stableFacts(facts)}`).digest('hex');
}

function stableFacts(value: unknown, depth = 0): string {
  if (depth > 12) throw new ForbiddenException('Application authority unavailable');
  if (value && typeof value === 'object' && nodeTypes.isProxy(value)) {
    throw new ForbiddenException('Application authority unavailable');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > 4096) throw new ForbiddenException('Application authority unavailable');
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 128) throw new ForbiddenException('Application authority unavailable');
    return `[${value.map((child) => stableFacts(child, depth + 1)).join(',')}]`;
  }
  if (value && typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const keys = Reflect.ownKeys(value);
    if (keys.length > 128 || keys.some((key) => typeof key !== 'string')) {
      throw new ForbiddenException('Application authority unavailable');
    }
    return `{${(keys as string[]).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new ForbiddenException('Application authority unavailable');
      return `${JSON.stringify(key)}:${stableFacts(descriptor.value, depth + 1)}`;
    }).join(',')}}`;
  }
  throw new ForbiddenException('Application authority unavailable');
}

export function applicationAuthorityIdentityReceipt(
  evidence: ApplicationAuthorityIdentityEvidence,
  checkedAtMs = Date.now(),
): ApplicationAuthorityIdentityReceipt {
  if (!Number.isSafeInteger(checkedAtMs) || checkedAtMs < 0 ||
      !Number.isSafeInteger(evidence.expiresAtMs) || evidence.expiresAtMs <= checkedAtMs ||
      !HASH.test(evidence.identityRevision) ||
      ![evidence.principal.tenantId, evidence.principal.actorId].every(
        (id) => typeof id === 'string' && id.length > 0 && id.length <= 256,
      )) throw new ForbiddenException('Application authority unavailable');
  return {
    principal: { tenantId: evidence.principal.tenantId, actorId: evidence.principal.actorId },
    identityRevision: evidence.identityRevision,
    checkedAtMs,
    expiresAtMs: evidence.expiresAtMs,
  };
}

export interface ApplicationAuthorityConversation {
  id: string;
  tenantId: string;
  userId: string;
  clientId: string | null;
  status: string;
  archivedAt: Date | null;
}

/** Every port is read on the caller's single consistent database snapshot. */
export async function readApplicationAuthorityCurrent(
  input: ApplicationAuthorityCurrentRequest,
  ports: {
    identity(): Promise<ApplicationAuthorityIdentityEvidence>;
    membership(): Promise<ApplicationAuthorityCurrentMembership>;
    conversation(id: string): Promise<ApplicationAuthorityConversation>;
    conversationScope(conversation: ApplicationAuthorityConversation): Promise<unknown>;
    clientVisible(id: string): Promise<unknown>;
    clientAuthority(id: string): Promise<unknown>;
  },
): Promise<ApplicationAuthorityCurrentReceipt> {
  const evidence = await ports.identity();
  const membership = await ports.membership();
  const conversation = await ports.conversation(input.conversationId);
  assertCurrentConversation(conversation, input, evidence.principal);
  const scope = await ports.conversationScope(conversation);
  // General still requires this exact owned, active conversation and current membership.
  // Only an actual null client has no client resource or wall to authorize.
  let client: unknown = null;
  if (input.clientId !== null) {
    await ports.clientVisible(input.clientId);
    client = await ports.clientAuthority(input.clientId);
  }
  const checkedAtMs = Date.now();
  const identity = applicationAuthorityIdentityReceipt({
    ...evidence, expiresAtMs: Math.min(evidence.expiresAtMs, checkedAtMs + 120_000),
  }, checkedAtMs);
  const receipt: ApplicationAuthorityCurrentReceipt = {
    ...identity, ...membership,
    conversationId: conversation.id,
    selectedClientId: input.clientId,
    contextRevision: applicationAuthorityRevision('context', [
      identity.identityRevision,
      [conversation.id, conversation.tenantId, conversation.userId, conversation.clientId, conversation.status, conversation.archivedAt],
      scope, client,
    ]),
  };
  if (Object.entries(input.expect ?? {}).some(([key, value]) =>
    receipt[key as keyof NonNullable<ApplicationAuthorityCurrentRequest['expect']>] !== value)) {
    throw new ApplicationAuthorityChangedException();
  }
  return receipt;
}

/** Ports are existing application owners; selectors and the echoed hash grant nothing. */
export async function readApplicationAuthorityContext(
  input: ApplicationAuthorityContextRequest,
  ports: {
    identity(): Promise<ApplicationAuthorityIdentityProof>;
    conversation(id: string): Promise<ApplicationAuthorityConversation>;
    conversationScope(conversation: ApplicationAuthorityConversation): Promise<unknown>;
    clientVisible(id: string): Promise<unknown>;
    clientAuthority(id: string): Promise<unknown>;
  },
): Promise<ApplicationAuthorityContextReceipt> {
  const initial = await ports.identity();
  const conversation = await ports.conversation(input.conversationId);
  assertCurrentConversation(conversation, input, initial.principal);
  await ports.conversationScope(conversation);
  await ports.clientVisible(input.clientId);
  await ports.clientAuthority(input.clientId);
  // Re-read session and local identity after the asynchronous context owner reads.
  const current = await ports.identity();
  if (current.principal.tenantId !== initial.principal.tenantId ||
      current.principal.actorId !== initial.principal.actorId ||
      current.identityRevision !== initial.identityRevision) {
    throw new ForbiddenException('Application authority unavailable');
  }
  // The online session await must not preserve an older conversation binding
  // or wall receipt. Re-read existing context owners on its other side.
  const latestConversation = await ports.conversation(input.conversationId);
  assertCurrentConversation(latestConversation, input, current.principal);
  const scope = await ports.conversationScope(latestConversation);
  await ports.clientVisible(input.clientId);
  const client = await ports.clientAuthority(input.clientId);
  // Close local membership/impersonation changes during the context reads.
  // This uses the just-read session's original bounds, never a cached receipt.
  const finalIdentity = await current.recheckCurrent();
  if (finalIdentity.identityRevision !== current.identityRevision ||
      finalIdentity.principal.tenantId !== current.principal.tenantId ||
      finalIdentity.principal.actorId !== current.principal.actorId) {
    throw new ForbiddenException('Application authority unavailable');
  }
  const identity = applicationAuthorityIdentityReceipt({
    ...finalIdentity, expiresAtMs: Math.min(initial.expiresAtMs, current.expiresAtMs, finalIdentity.expiresAtMs),
  });
  return {
    ...identity,
    identitySha256: input.identitySha256,
    conversationId: latestConversation.id,
    selectedClientId: input.clientId,
    contextRevision: applicationAuthorityRevision('context', [
      current.identityRevision,
      [latestConversation.id, latestConversation.tenantId, latestConversation.userId, latestConversation.clientId,
        latestConversation.status, latestConversation.archivedAt],
      scope, client,
    ]),
  };
}

function assertCurrentConversation(
  conversation: ApplicationAuthorityConversation,
  input: Pick<ApplicationAuthorityCurrentRequest, 'conversationId' | 'clientId'>,
  principal: ApplicationAuthorityPrincipal,
): void {
  if (conversation.id !== input.conversationId ||
      conversation.tenantId !== principal.tenantId || conversation.userId !== principal.actorId ||
      conversation.clientId !== input.clientId || conversation.archivedAt !== null ||
      conversation.status !== 'active') throw new ForbiddenException('Application authority unavailable');
}

/**
 * `capiro.meri-artifact-authority.v1` (meri-greenfield
 * docs/integration/ARTIFACT-CURRENT-AUTHORITY-CONTRACT.md, D31; dot #121
 * 6247459562 / 6247472757): a pure current-authority observation for
 * `/api/documents/*`. It reuses the identity + context revision chain (no
 * second authority model); `operations` is a fact, never a grant. Nothing is
 * persisted: no ledger, cache or idempotency key.
 */
export const ARTIFACT_AUTHORITY_CONTRACT = 'capiro.meri-artifact-authority.v1';
export const ARTIFACT_AUTHORITY_V2_CONTRACT = 'capiro.meri-artifact-authority.v2';
export const ARTIFACT_AUTHORITY_TTL_MS = 60_000;
/** Closed and sorted (contract §4.2). */
export const ARTIFACT_OPERATIONS = Object.freeze([
  'artifact.download', 'artifact.generate', 'artifact.inspect', 'artifact.preview-publish', 'artifact.revise',
] as const);
export type ArtifactOperation = (typeof ARTIFACT_OPERATIONS)[number];
/** Contract §4.3 `INTENT_OPERATIONS`. */
export const ARTIFACT_INTENT_OPERATIONS: Readonly<Record<string, readonly ArtifactOperation[]>> = Object.freeze({
  create: ['artifact.generate'],
  revise: ['artifact.revise'],
  inspect: ['artifact.inspect'],
  results: ['artifact.inspect'],
  history: ['artifact.inspect'],
  list: ['artifact.inspect'],
  download: ['artifact.download'],
  preview: ['artifact.download', 'artifact.inspect'],
  'preview-publish': ['artifact.download', 'artifact.inspect', 'artifact.preview-publish'],
  'federal-prepare': ['artifact.download', 'artifact.inspect'],
  'federal-load': ['artifact.download', 'artifact.inspect'],
  'federal-publish': ['artifact.download', 'artifact.generate', 'artifact.inspect', 'artifact.revise'],
});
/** Contract §4.2 v1 rule: existing semantics, no new policy. */
const ARTIFACT_ADMITTED_ROLES = Object.freeze(['standard_user', 'user_admin', 'capiro_admin']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ApplicationAuthorityArtifactRequest {
  contract: typeof ARTIFACT_AUTHORITY_CONTRACT | typeof ARTIFACT_AUTHORITY_V2_CONTRACT;
  observationId: string;
  conversationId: string;
  clientId: string | null;
  scopeKind?: 'client' | 'general';
  intent: string;
  requestSha256: string;
}
export interface ApplicationAuthorityArtifactReceipt {
  contract: typeof ARTIFACT_AUTHORITY_CONTRACT | typeof ARTIFACT_AUTHORITY_V2_CONTRACT;
  observationId: string;
  principal: ApplicationAuthorityPrincipal;
  identityRevision: string;
  conversationId: string;
  selectedClientId: string | null;
  scopeKind?: 'client' | 'general';
  contextRevision: string;
  intent: string;
  requestSha256: string;
  operations: ArtifactOperation[];
  limits: null;
  authorityRevision: string;
  checkedAtMs: number;
  expiresAtMs: number;
}

/** V1 retains its exact six keys; V2 requires an explicit matching scope kind. */
export function parseApplicationAuthorityArtifactBody(body: unknown): ApplicationAuthorityArtifactRequest {
  const record = closedBody(body, ['contract', 'observationId', 'conversationId', 'clientId', 'intent', 'requestSha256'], ['scopeKind']);
  const { contract, observationId, conversationId, clientId, intent, requestSha256 } = record;
  const v2 = contract === ARTIFACT_AUTHORITY_V2_CONTRACT;
  const client = typeof clientId === 'string' && UUID.test(clientId);
  if ((!v2 && contract !== ARTIFACT_AUTHORITY_CONTRACT) ||
      (v2 ? !((record.scopeKind === 'general' && clientId === null) || (record.scopeKind === 'client' && client))
        : Object.hasOwn(record, 'scopeKind') || !client) ||
      typeof observationId !== 'string' || !UUID_V4.test(observationId) ||
      typeof conversationId !== 'string' || !UUID.test(conversationId) ||
      typeof intent !== 'string' || !Object.hasOwn(ARTIFACT_INTENT_OPERATIONS, intent) ||
      typeof requestSha256 !== 'string' || !HASH.test(requestSha256)) {
    throw new BadRequestException('Invalid application authority request');
  }
  return { contract: contract as ApplicationAuthorityArtifactRequest['contract'], observationId, conversationId,
    clientId: clientId as string | null, intent, requestSha256,
    ...(v2 ? { scopeKind: record.scopeKind as 'client' | 'general' } : {}) };
}

/**
 * Contract §4.1. The identity, conversation, prospect scope, client visibility
 * and client authority reads and re-reads are exactly `/context`'s
 * (`readApplicationAuthorityContext`); membership and role are already bound
 * in `identityRevision` with the active member/tenant rechecks (dot
 * 6247459562), so no extra membership call is made. `role` is the request's
 * resolved role and joins `authorityRevision`. `requestSha256` is echoed only.
 */
export async function readApplicationAuthorityArtifact(
  input: ApplicationAuthorityArtifactRequest,
  role: string,
  ports: Parameters<typeof readApplicationAuthorityContext>[1],
  now: () => number = Date.now,
): Promise<ApplicationAuthorityArtifactReceipt> {
  if (input.contract !== ARTIFACT_AUTHORITY_CONTRACT || input.clientId === null) {
    throw new BadRequestException('V2 requires current conversation authority');
  }
  // `/context` echoes `identitySha256` without interpreting it; this route has
  // none, so a constant placeholder is passed and never returned.
  const context = await readApplicationAuthorityContext(
    { identitySha256: '0'.repeat(64), conversationId: input.conversationId, clientId: input.clientId }, ports);
  return applicationAuthorityArtifactReceipt(input, role, context, now);
}

/** Project the existing artifact policy from an actual current Core observation.
 * V2 callers supply /current, whose snapshot checks the persisted General receipt. */
export function applicationAuthorityArtifactReceipt(
  input: ApplicationAuthorityArtifactRequest, role: string,
  context: ApplicationAuthorityContextReceipt | ApplicationAuthorityCurrentReceipt,
  now: () => number = Date.now,
): ApplicationAuthorityArtifactReceipt {
  if (context.conversationId !== input.conversationId || context.selectedClientId !== input.clientId ||
      (input.contract === ARTIFACT_AUTHORITY_V2_CONTRACT &&
        input.scopeKind !== (context.selectedClientId === null ? 'general' : 'client'))) {
    throw new ForbiddenException('Application authority unavailable');
  }
  const operations: ArtifactOperation[] = ARTIFACT_ADMITTED_ROLES.includes(role) ? [...ARTIFACT_OPERATIONS] : [];
  const needed = ARTIFACT_INTENT_OPERATIONS[input.intent];
  if (!needed || needed.some((operation) => !operations.includes(operation))) {
    throw new ForbiddenException('Application authority unavailable');
  }
  const limits = null;
  const authorityRevision = applicationAuthorityRevision('artifact', [
    context.identityRevision, context.contextRevision, role, operations, limits,
  ]);
  const checkedAtMs = now();
  const expiresAtMs = Math.min(checkedAtMs + ARTIFACT_AUTHORITY_TTL_MS, context.expiresAtMs);
  if (!Number.isSafeInteger(checkedAtMs) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= checkedAtMs) {
    throw new ForbiddenException('Application authority unavailable');
  }
  return {
    contract: input.contract,
    observationId: input.observationId,
    principal: { tenantId: context.principal.tenantId, actorId: context.principal.actorId },
    identityRevision: context.identityRevision,
    conversationId: context.conversationId,
    selectedClientId: context.selectedClientId,
    contextRevision: context.contextRevision,
    intent: input.intent,
    requestSha256: input.requestSha256,
    operations,
    limits,
    authorityRevision,
    checkedAtMs,
    expiresAtMs,
    ...(input.contract === ARTIFACT_AUTHORITY_V2_CONTRACT ? { scopeKind: input.scopeKind } : {}),
  };
}
