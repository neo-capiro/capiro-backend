import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { BadRequestException, ConflictException, ForbiddenException, RequestTimeoutException } from '@nestjs/common';

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

export interface ApplicationAuthorityMembershipFacts {
  membershipId: string;
  tenantId: string;
  actorId: string;
  status: string;
  role: string;
  updatedAtMs: number;
  clientIds: string[];
}
export interface ApplicationAuthorityMembershipReceipt {
  tenantId: string;
  actorId: string;
  status: 'active';
  role: string;
  permissions: string[];
  clientIds: string[];
  membershipRevision: string;
  checkedAtMs: number;
  expiresAtMs: number;
}

// Wire syntax, not resource authority: nil and UUID versions 7/8 are allowed.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ROLE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

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

/** Optional caller cutoff; it can only shorten the online session's expiry. */
export function parseApplicationAuthorityMembershipDeadline(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new BadRequestException('Invalid application authority request');
  }
  const deadlineMs = Number(raw);
  if (deadlineMs <= Date.now()) throw new RequestTimeoutException('Application authority deadline exceeded');
  return deadlineMs;
}

function closedBody(body: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || nodeTypes.isProxy(body) || Array.isArray(body) ||
      (Object.getPrototypeOf(body) !== Object.prototype && Object.getPrototypeOf(body) !== null)) {
    throw new BadRequestException('Invalid application authority request');
  }
  const own = Reflect.ownKeys(body);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new BadRequestException('Invalid application authority request');
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(body, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new BadRequestException('Invalid application authority request');
    }
    result[key] = descriptor.value;
  }
  return result;
}

/** Deterministic digest of explicit server-owned facts, never an authority grant. */
export function applicationAuthorityRevision(kind: 'identity' | 'context', facts: unknown): string {
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

function sameIdentity(
  initial: ApplicationAuthorityIdentityEvidence,
  current: ApplicationAuthorityIdentityEvidence,
): boolean {
  return current.principal.tenantId === initial.principal.tenantId &&
    current.principal.actorId === initial.principal.actorId &&
    current.identityRevision === initial.identityRevision;
}

/** The client roster is a current DB fact, not a caller-selected authorization scope. */
function membershipSnapshot(
  evidence: ApplicationAuthorityIdentityEvidence,
  facts: ApplicationAuthorityMembershipFacts,
): { revision: string; role: string; clientIds: string[] } {
  if (facts.tenantId !== evidence.principal.tenantId || facts.actorId !== evidence.principal.actorId ||
      facts.status !== 'active' || typeof facts.membershipId !== 'string' ||
      facts.membershipId.length === 0 || facts.membershipId.length > 256 ||
      typeof facts.role !== 'string' || !ROLE_NAME.test(facts.role) ||
      !Number.isSafeInteger(facts.updatedAtMs) || facts.updatedAtMs < 0 ||
      !Array.isArray(facts.clientIds) || facts.clientIds.length > 4096 ||
      !facts.clientIds.every((id) => typeof id === 'string' && UUID.test(id))) {
    throw new ForbiddenException('Application authority unavailable');
  }
  const clientIds = [...facts.clientIds].sort();
  if (new Set(clientIds).size !== clientIds.length || !HASH.test(evidence.identityRevision)) {
    throw new ForbiddenException('Application authority unavailable');
  }
  // Session evidence is rechecked separately; membership revision changes only
  // when current membership or client rights change.
  const revision = createHash('sha256')
    .update('capiro-application-authority-membership-v1\n')
    .update(JSON.stringify([facts.membershipId, facts.tenantId,
      facts.actorId, facts.status, facts.role, facts.updatedAtMs, clientIds]))
    .digest('hex');
  return { revision, role: facts.role, clientIds };
}

/** A fresh session read and a second roster read close changes during asynchronous DB work. */
export async function readApplicationAuthorityMembership(
  ports: {
    identity(): Promise<ApplicationAuthorityIdentityProof>;
    membership(principal: ApplicationAuthorityPrincipal): Promise<ApplicationAuthorityMembershipFacts>;
  },
  deadlineMs?: number,
): Promise<ApplicationAuthorityMembershipReceipt> {
  const initial = await ports.identity();
  const before = membershipSnapshot(initial, await ports.membership(initial.principal));
  const current = await ports.identity();
  if (!sameIdentity(initial, current)) throw new ForbiddenException('Application authority unavailable');
  const latest = membershipSnapshot(current, await ports.membership(current.principal));
  if (latest.revision !== before.revision) throw new ConflictException('Application membership changed');
  const final = await current.recheckCurrent();
  if (!sameIdentity(current, final)) throw new ForbiddenException('Application authority unavailable');
  const checkedAtMs = Date.now();
  if (deadlineMs !== undefined && deadlineMs <= checkedAtMs) {
    throw new RequestTimeoutException('Application authority deadline exceeded');
  }
  const identity = applicationAuthorityIdentityReceipt({
    ...final,
    expiresAtMs: Math.min(initial.expiresAtMs, current.expiresAtMs, final.expiresAtMs,
      deadlineMs ?? Number.MAX_SAFE_INTEGER),
  }, checkedAtMs);
  return {
    tenantId: identity.principal.tenantId,
    actorId: identity.principal.actorId,
    status: 'active',
    role: latest.role,
    // No native owner currently defines these proposed product permissions.
    permissions: [],
    clientIds: latest.clientIds,
    membershipRevision: latest.revision,
    checkedAtMs: identity.checkedAtMs,
    expiresAtMs: identity.expiresAtMs,
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
  input: ApplicationAuthorityContextRequest,
  principal: ApplicationAuthorityPrincipal,
): void {
  if (conversation.id !== input.conversationId ||
      conversation.tenantId !== principal.tenantId || conversation.userId !== principal.actorId ||
      conversation.clientId !== input.clientId || conversation.archivedAt !== null ||
      conversation.status !== 'active') throw new ForbiddenException('Application authority unavailable');
}
