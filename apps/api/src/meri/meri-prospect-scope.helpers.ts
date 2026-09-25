/**
 * Business Development Phase 4 — shared prospect-scope dispatch helpers.
 *
 * One place builds (a) the authorization re-check every prospect-scoped
 * dispatch must pass BEFORE any user-message write or model/runtime call, and
 * (b) the compact server-authored directive + public turn-scope receipt, so
 * the legacy loop, the MeriV2 full-chat proxy, MeriV3 and the Hermes runtime
 * adapter cannot drift apart.
 *
 * Import direction is the existing one-way MeriModule → BusinessDevelopmentModule
 * edge: this file (in meri/) imports the BD scope service; BD never imports meri.
 * No provider payloads, notes, dossiers or arbitrary metadata ever enter a
 * prompt — only the bounded scope fields below.
 */
import type { TenantContext } from '@capiro/shared';
import {
  MeriProspectScopeConflictError,
  parsePersistedMeriProspectScope,
  type BizDevMeriScopeService,
  type MeriProspectScope,
} from '../business-development/bizdev-meri-scope.service.js';
import type { MeriTurnScope } from './meri-turn-scope.js';

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

/**
 * The compact server-authored directive binding the selected prospect into
 * model/runtime context. Bounded fields only: display name + prospect id.
 * States explicitly that a free-form prompt naming another company does NOT
 * retarget the conversation, and that an explicit switch or a new
 * prospect-scoped conversation is required.
 */
export function prospectScopeDirective(scope: MeriProspectScope): string {
  const label = `"${scope.prospectName}"`;
  return [
    `Active prospect scope (HARD CONSTRAINT): this conversation is scoped to the business-development prospect ${label} (id: ${scope.prospectId}).`,
    `Every prospect-specific answer, draft and recommendation in this session must be about ${label}, the active prospect.`,
    `The active prospect does NOT change mid-conversation: a prompt that names, asks about, or compares another company does not retarget this chat. Treat other companies as out of scope for prospect-specific work.`,
    `If the user wants to work on a different prospect, say plainly that this chat is scoped to ${label} and ask them to switch prospects explicitly or start a new prospect chat. Do not silently switch.`,
  ].join(' ');
}

/**
 * Public turn-scope receipt for a prospect-scoped turn. Captured ONLY from the
 * immutable server conversation snapshot / current re-resolution — never from
 * retrieval-plan guesses or model output.
 */
export function prospectTurnScopeReceipt(scope: MeriProspectScope): MeriTurnScope {
  return {
    kind: 'prospect',
    clientId: null,
    clientName: null,
    targetHint: null,
    prospectId: scope.prospectId,
    prospectName: scope.prospectName,
    canonicalOrganizationId: scope.canonicalOrganizationId,
    linkedClientId: scope.linkedClientId,
    scopeVersion: scope.scopeVersion,
  };
}
