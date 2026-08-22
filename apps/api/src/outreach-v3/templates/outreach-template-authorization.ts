import { createHash } from 'node:crypto';
import { isTenantAdmin, type TenantContext } from '@capiro/shared';
import type { OutreachSponsorScopeV1 } from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import type { OutreachTemplateRow } from './outreach-template.repository.js';
import type { OutreachTemplateScope, OutreachTemplateSpecV1 } from './outreach-template.contract.js';

/**
 * What a source campaign's sponsor scope authorizes for a NEW or UPDATED
 * template. This is deliberately computed from the source session's own
 * authoritative `spec.sponsor`, never from a browser-supplied clientId/scope —
 * see closeout runbook 3.3 ("the global browser client selector is not
 * authoritative; resolve source session scope on the server").
 */
export type OutreachTemplateSourceScopeClass =
  | { kind: 'unscoped' } // firm / internal_team / undecided / none — no client is bound
  | { kind: 'client'; clientId: string }
  | { kind: 'unsupported'; reason: 'multi_client' | 'coalition' };

export function classifySourceScope(sponsor: OutreachSponsorScopeV1): OutreachTemplateSourceScopeClass {
  if (sponsor.kind === 'multi_client') return { kind: 'unsupported', reason: 'multi_client' };
  // Coalition membership/isolation is not modeled yet (closeout runbook 3.3 and
  // 6.3): "implement coalition only with real coalition membership... otherwise
  // explicitly defer". Block rather than silently downgrade to undecided.
  if (sponsor.kind === 'coalition') return { kind: 'unsupported', reason: 'coalition' };
  if (sponsor.kind === 'client') {
    const clientId = sponsor.clientRefs[0]?.clientId;
    if (!clientId) return { kind: 'unsupported', reason: 'multi_client' };
    return { kind: 'client', clientId };
  }
  return { kind: 'unscoped' };
}

function scopeUnsupported(reason: 'multi_client' | 'coalition'): OutreachCommandError {
  return new OutreachCommandError(
    'OUTREACH_TEMPLATE_SCOPE_UNSUPPORTED',
    reason === 'multi_client'
      ? 'Multi-client campaigns cannot become a template yet. Save a single-client or firm campaign instead.'
      : 'Coalition campaigns cannot become a template yet. Save a single-client or firm campaign instead.',
    409,
  );
}

function scopeMismatch(message: string): OutreachCommandError {
  return new OutreachCommandError('OUTREACH_TEMPLATE_SCOPE_MISMATCH', message, 409);
}

/**
 * Enforce the safe-default source-to-destination scope table from closeout
 * runbook 3.3:
 *   client source campaign      -> same-client template only
 *   firm/internal source        -> private or firm template
 *   multi-client/coalition      -> blocked (see classifySourceScope)
 * Returns the clientId the template row must be created/kept with.
 */
export function assertDestinationScopeAllowed(
  source: OutreachTemplateSourceScopeClass,
  requestedScope: OutreachTemplateScope,
  requestedClientId: string | null,
): { clientId: string | null } {
  if (source.kind === 'unsupported') throw scopeUnsupported(source.reason);

  if (source.kind === 'client') {
    if (requestedScope !== 'client' || requestedClientId !== source.clientId) {
      throw scopeMismatch(
        'This campaign belongs to a specific client. It can only be saved as a template scoped to that same client.',
      );
    }
    return { clientId: source.clientId };
  }

  // source.kind === 'unscoped'
  if (requestedScope === 'client') {
    throw scopeMismatch(
      'This campaign has no client sponsor, so it cannot be saved as a client-scoped template.',
    );
  }
  return { clientId: null };
}

/**
 * Re-validates that a NEW version's source campaign still matches the
 * EXISTING template's governed scope. Prevents laundering a client A
 * campaign into a firm template's next version, or a firm campaign into a
 * different client's template.
 */
export function assertVersionSourceMatchesTemplateScope(
  source: OutreachTemplateSourceScopeClass,
  template: Pick<OutreachTemplateRow, 'scope' | 'clientId'>,
): void {
  if (source.kind === 'unsupported') throw scopeUnsupported(source.reason);
  if (template.scope === 'client') {
    if (source.kind !== 'client' || source.clientId !== template.clientId) {
      throw scopeMismatch(
        'The new version’s source campaign does not belong to this template’s client. Create a separate template instead.',
      );
    }
    return;
  }
  if (source.kind === 'client') {
    throw scopeMismatch(
      'A client-specific campaign cannot become a version of a non-client template.',
    );
  }
}

/** Firm/client publication (and any scope widening) requires a tenant admin. */
export function assertSharedPublicationAuthority(ctx: TenantContext, scope: OutreachTemplateScope): void {
  if (scope === 'private') return;
  if (!isTenantAdmin(ctx.role)) {
    throw new OutreachCommandError(
      'OUTREACH_TEMPLATE_PUBLISH_UNAUTHORIZED',
      'Publishing a firm or client template requires an authorized administrator.',
      403,
    );
  }
}

export interface OutreachTemplateCapabilities {
  canUse: boolean;
  canInspect: boolean;
  canEdit: boolean;
  canCreateVersion: boolean;
  canPublish: boolean;
  canArchive: boolean;
  canRestore: boolean;
}

/**
 * Server-computed UI capability flags (closeout runbook 3.4: "Do not infer
 * these fields in React"). `isOwner` must already have been established by
 * the caller (owner_user_id === ctx.userId); this function does not re-derive
 * it so it stays a pure function of already-authorized facts.
 */
export function computeTemplateCapabilities(
  ctx: TenantContext,
  template: Pick<OutreachTemplateRow, 'scope' | 'ownerUserId' | 'status' | 'publishedVersionId'>,
): OutreachTemplateCapabilities {
  const isOwner = template.ownerUserId === ctx.userId;
  const isAdmin = isTenantAdmin(ctx.role);
  const isManager = isOwner || (isAdmin && template.scope !== 'private');
  const isActive = template.status === 'active';
  return {
    canUse: isActive && Boolean(template.publishedVersionId),
    canInspect: isManager,
    canEdit: isManager && isActive,
    canCreateVersion: isManager && isActive,
    canPublish:
      isActive &&
      (template.scope === 'private' ? isOwner : isAdmin),
    canArchive: isManager && isActive,
    // Restore/duplicate policy is not implemented this phase (closeout runbook
    // 6.16); always false so the UI never offers a control with no backend.
    canRestore: false,
  };
}

/**
 * Safe card-list projection of a reusable spec (closeout runbook 3.2 / 5.4):
 * never return style-sample bodies, ask text, or long-form strategy prose in
 * a list response — only enough to identify the playbook on a card.
 */
export interface OutreachTemplateCardSummary {
  topic: string | null;
  sponsorKind: OutreachTemplateSpecV1['sponsor']['kind'];
  deliveryPattern: OutreachTemplateSpecV1['delivery']['pattern'];
  personalization: OutreachTemplateSpecV1['delivery']['personalization'];
  tone: string | null;
  length: OutreachTemplateSpecV1['strategy']['length'];
  hasExplicitAsk: boolean;
  styleSampleCount: number;
}

export function toTemplateCardSummary(spec: OutreachTemplateSpecV1): OutreachTemplateCardSummary {
  return {
    topic: spec.goal.topic,
    sponsorKind: spec.sponsor.kind,
    deliveryPattern: spec.delivery.pattern,
    personalization: spec.delivery.personalization,
    tone: spec.strategy.tone,
    length: spec.strategy.length,
    hasExplicitAsk: spec.goal.ask.mode === 'explicit',
    styleSampleCount: spec.styleSamples.length,
  };
}

/**
 * Canonical request fingerprint for idempotent template application
 * (closeout runbook 3.8). Same key + same fingerprint replays; same key +
 * different fingerprint is a 409, not a silent second campaign.
 */
export function computeTemplateApplicationFingerprint(input: {
  actorUserId: string;
  templateId: string;
  templateVersionId: string;
  clientId: string | null;
  title: string | null;
}): string {
  const normalized = JSON.stringify({
    actorUserId: input.actorUserId,
    templateId: input.templateId,
    templateVersionId: input.templateVersionId,
    clientId: input.clientId ?? null,
    title: input.title?.trim() || null,
  });
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
