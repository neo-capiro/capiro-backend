import type { MeriContext } from '../registry/types';

export class ScopingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopingError';
  }
}

/**
 * Throws `ScopingError` unless every identity field required to scope a query
 * is present. This is the runtime half of the scoping guarantee; the type
 * system is the other half (`ToolDefinition.handler` requires a `MeriContext`).
 *
 * Row-level filtering itself happens in the data adapters, which MUST scope on
 * `ctx.tenantId` (and per-user visibility on `ctx.userId`); the scoping-parity
 * test (SC0.7) verifies that the rows MeriV2 returns equal what current Meri
 * returns for the same `(user, tenant)`.
 */
export function assertMeriContext(ctx: MeriContext | null | undefined): asserts ctx is MeriContext {
  if (!ctx) {
    throw new ScopingError('Missing MeriContext: no caller identity resolved');
  }
  const missing: string[] = [];
  if (!ctx.tenantId || !ctx.tenantId.trim()) missing.push('tenantId');
  if (!ctx.userId || !ctx.userId.trim()) missing.push('userId');
  if (!ctx.clerkUserId || !ctx.clerkUserId.trim()) missing.push('clerkUserId');
  if (!ctx.role || !String(ctx.role).trim()) missing.push('role');
  if (missing.length > 0) {
    throw new ScopingError(`Incomplete MeriContext: missing ${missing.join(', ')}`);
  }
}

/** Wraps a unit of work so it can only run inside a validated tenant scope. */
export interface ScopingWrapper {
  enforce<T>(ctx: MeriContext, fn: () => Promise<T>): Promise<T>;
}

export class DefaultScopingWrapper implements ScopingWrapper {
  async enforce<T>(ctx: MeriContext, fn: () => Promise<T>): Promise<T> {
    assertMeriContext(ctx);
    return fn();
  }
}
