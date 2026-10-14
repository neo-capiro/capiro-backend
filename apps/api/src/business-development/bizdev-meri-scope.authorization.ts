/** Existing prospect authorization owned by Business Development. */
import type { TenantContext } from '@capiro/shared';
import {
  MeriProspectScopeConflictError,
  parsePersistedMeriProspectScope,
  type BizDevMeriScopeService,
  type MeriProspectScope,
} from './bizdev-meri-scope.service.js';

/**
 * Authorization re-check for prospect-scoped conversations. Returns null for
 * ordinary unscoped conversations (caller proceeds unchanged). For a
 * conversation whose metadata carries a prospect scope, re-resolves it through
 * `BizDevMeriScopeService.assertCurrent` and fails closed — typed conflict /
 * safe 404 — on missing/malformed/stale scope or an unavailable scope service,
 * BEFORE the caller persists a user message or dispatches a model/runtime.
 */
export async function authorizeMeriProspectScope(
  bizdevScope: BizDevMeriScopeService | undefined,
  ctx: TenantContext,
  conversationMetadata: unknown,
): Promise<MeriProspectScope | null> {
  const metadata =
    conversationMetadata &&
    typeof conversationMetadata === 'object' &&
    !Array.isArray(conversationMetadata)
      ? (conversationMetadata as Record<string, unknown>)
      : null;
  const hasPersistedScope = Boolean(
    metadata && Object.prototype.hasOwnProperty.call(metadata, 'bizdevProspectScope'),
  );
  const persisted = parsePersistedMeriProspectScope(conversationMetadata);
  if (!hasPersistedScope) return null;
  if (!persisted) throw new MeriProspectScopeConflictError('not_found');
  if (!bizdevScope) throw new MeriProspectScopeConflictError('not_found');
  return bizdevScope.assertCurrent(ctx, conversationMetadata);
}

