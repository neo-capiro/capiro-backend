import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { MERI_CAPABILITY_REGISTRY } from '@capiro/shared';
import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';

/**
 * Immutable identity/scope established by the V3 controller only after the
 * API-issued governed context has been authenticated. This is transport
 * context, not an authorization grant; apps/api re-authorizes every read.
 */
export interface TrustedCurrentTurnScope {
  tenantId: string;
  userId: string;
  conversationId: string | null;
  selectedClientId: string | null;
  capturePolicy?: MeriServerReadonlyCapturePolicy;
}

const storage = new AsyncLocalStorage<TrustedCurrentTurnScope>();

export function currentTrustedCurrentTurnScope(): TrustedCurrentTurnScope | undefined {
  return storage.getStore();
}

export function withTrustedCurrentTurnScope<T>(scope: TrustedCurrentTurnScope, run: () => T): T {
  return storage.run(Object.freeze({ ...scope }), run);
}

export function currentServerReadonlyCapturePolicy(): MeriServerReadonlyCapturePolicy | null {
  return currentTrustedCurrentTurnScope()?.capturePolicy ?? null;
}

export function validateServerReadonlyCapturePolicy(
  policy: MeriServerReadonlyCapturePolicy,
  binding: {
    tenantId: string;
    actorUserId: string;
    conversationId: string | null;
    clientId: string | null;
  },
  now = Date.now(),
): void {
  const catalogSha256 = createHash('sha256')
    .update(
      MERI_CAPABILITY_REGISTRY.filter((tool) => tool.readOnly === true)
        .map((tool) => tool.name)
        .sort()
        .join('\n'),
    )
    .digest('hex');
  if (
    policy.expiresAt <= now ||
    policy.issuedAt > now + 30_000 ||
    policy.toolCatalogSha256 !== catalogSha256 ||
    policy.tenantId !== binding.tenantId ||
    policy.actorUserId !== binding.actorUserId ||
    policy.conversationId !== binding.conversationId ||
    policy.clientId !== binding.clientId ||
    policy.dynamicMcpAllowed !== false ||
    policy.incidentalWriters !== 'suppressed'
  ) {
    throw new Error('Server-owned read-only capture policy is stale or scope-mismatched.');
  }
}

export function assertServerReadonlyCaptureToolAllowed(name: string, now = Date.now()): void {
  const current = currentTrustedCurrentTurnScope();
  const policy = current?.capturePolicy;
  if (!policy || !current) return;
  validateServerReadonlyCapturePolicy(
    policy,
    {
      tenantId: current.tenantId,
      actorUserId: current.userId,
      conversationId: current.conversationId,
      clientId: current.selectedClientId,
    },
    now,
  );
  const capability = MERI_CAPABILITY_REGISTRY.find((tool) => tool.name === name);
  if (!capability || capability.readOnly !== true || name === 'run_analysis') {
    throw new Error('Server-owned read-only capture denied tool dispatch.');
  }
}
