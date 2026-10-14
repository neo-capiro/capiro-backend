/**
 * Business Development Phase 4 — shared prospect-scope dispatch helpers.
 *
 * Builds the compact server-authored directive + public turn-scope receipt.
 * The existing authorization re-check is owned by Business Development and
 * re-exported here for the legacy loop, MeriV2 full-chat proxy and MeriV3.
 * Business Development never imports Meri.
 * No provider payloads, notes, dossiers or arbitrary metadata ever enter a
 * prompt — only the bounded scope fields below.
 */
import type { MeriProspectScope } from '../business-development/bizdev-meri-scope.service.js';
export { authorizeMeriProspectScope } from '../business-development/bizdev-meri-scope.authorization.js';
import type { MeriTurnScope } from './meri-turn-scope.js';

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
