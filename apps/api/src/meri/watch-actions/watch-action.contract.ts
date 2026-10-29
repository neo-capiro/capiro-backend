import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantContext } from '@capiro/shared';
import { nativeCanonicalSha256 } from '../native-approvals/native-approval.contract.js';

/**
 * MO-06 canonical watch lifecycle. One governed Meri tool (`watch_action`) covers
 * subscribe / pause / resume / unsubscribe against the *existing* canonical watch
 * owner of each business family. Core domain owners remain the effects and the
 * durable receipts; this contract only fixes the wire shape, the preserved
 * current-authority scope and the truthful no-replay receipt.
 *
 * A watch has no Meri-owned identity: the stable identity is the canonical
 * owner's own target/watch identity (`targetKey` + the owner receipt `identity`).
 */
export const WATCH_ACTION = 'watch_action';
export const WATCH_SCOPE_KEY = '__meriWatchScope';

/** The four canonical watch owners. `inspect` is served read-only by the same leaves. */
export const WATCH_FAMILIES = [
  'legiwatch_keyword',
  'business_development_prospect',
  'defense_budget_target',
  'client_watchlist',
] as const;
export type WatchFamily = (typeof WATCH_FAMILIES)[number];

/**
 * Supported lifecycle verbs. A verb is only ever valid for a family that
 * actually owns it; `supportedOperations` below is the exact capability matrix and
 * adapters refuse anything else. `set_delivery` exists because LegiWatch keyword
 * *rule activation* (which drives future scans) and *delivery switch* (notification
 * channels) are two distinct owners; pausing a rule is never silently reported as
 * disabling delivery.
 */
export const WATCH_OPERATIONS = [
  'subscribe',
  'pause',
  'resume',
  'unsubscribe',
  'set_delivery',
] as const;
export type WatchOperation = (typeof WATCH_OPERATIONS)[number];

/**
 * Exact operations each canonical owner supports today (family leaves may narrow,
 * never widen). Two gaps are deliberate and must not be papered over:
 *  - `defense_budget_target` has no paused state (its own event vocabulary is
 *    subscribed | unsubscribed | resubscribed), so `pause` is not offered;
 *  - `client_watchlist` has no delete and no unsubscribed state, so `unsubscribe`
 *    is not offered — `pause` is that owner's only "stop future events" lever.
 */
export const WATCH_SUPPORTED_OPERATIONS: Readonly<Record<WatchFamily, readonly WatchOperation[]>> =
  Object.freeze({
    legiwatch_keyword: Object.freeze([
      'subscribe',
      'pause',
      'resume',
      'unsubscribe',
      'set_delivery',
    ] as const),
    business_development_prospect: Object.freeze([
      'subscribe',
      'pause',
      'resume',
      'unsubscribe',
    ] as const),
    defense_budget_target: Object.freeze(['subscribe', 'resume', 'unsubscribe'] as const),
    // The tracker watchlist has one delivery lever (the actor's email/sms alert
    // preferences), so `subscribe` and `resume` are the same owner effect and only
    // `subscribe` is advertised; there is no delete, so no `unsubscribe`.
    client_watchlist: Object.freeze(['subscribe', 'pause'] as const),
  });

/** Canonical target kinds per family. Exact owner vocabulary; no invented kinds. */
export const WATCH_TARGET_KINDS: Readonly<Record<WatchFamily, readonly string[]>> = Object.freeze({
  legiwatch_keyword: Object.freeze(['keyword_rule']),
  business_development_prospect: Object.freeze(['prospect']),
  defense_budget_target: Object.freeze(['program', 'pe', 'project', 'capability'] as const),
  client_watchlist: Object.freeze(['client_tracker_watchlist']),
});

/** Exact owner state vocabulary: LegiWatch keyword rules also report `needs_review`. */
export const WATCH_WATCHED_STATES = [
  'active',
  'paused',
  'needs_review',
  'ended',
  'unsubscribed',
] as const;

const uuid = z
  .string()
  .uuid()
  .regex(/^[a-f0-9-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const targetKey = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[A-Za-z0-9._:-]+$/);
/** Opaque canonical owner token (rule id, watch id, preview run id, …). Never Meri-minted. */
const token = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const watchRequestSchema = z
  .object({
    family: z.enum(WATCH_FAMILIES),
    clientId: uuid.nullable(),
    targetKind: z.string().min(1).max(40),
    targetKey,
    operation: z.enum(WATCH_OPERATIONS),
    /** Exact canonical version / CAS token the owner requires. Never a Meri-invented counter. */
    expectedVersion: z.number().int().min(1).max(2147483646),
    /**
     * The exact owner-required source/preview token, when the owner demands one:
     * LegiWatch keyword rule activation needs its own completed preview run id
     * (`COMPLETE_CURRENT_PREVIEW_REQUIRED`, keyword-discovery.service.ts), and the
     * client-watchlist owner is versioned by the watchlist head. Never a Meri value.
     */
    sourceRevision: token.nullable(),
    /**
     * Owner-required free-text justification (defense-budget subscribe demands a
     * `clientReason`). Supplied by the caller; never invented by the adapter.
     */
    reason: z.string().min(1).max(2000).nullable(),
    /**
     * `set_delivery` target switch, for the owners whose notification channel is a
     * distinct switch from rule activation (LegiWatch keyword delivery). Required
     * by — and only by — the `set_delivery` verb.
     */
    enabled: z.boolean().nullable(),
    /** Canonical proposal claim. Server-derived by Core; never accepted from a model. */
    requestKey: z.string().min(8).max(180),
  })
  .strict();
export type WatchRequest = z.infer<typeof watchRequestSchema>;

/** Only local checks made before any owner mutation may use this refusal. */
export class WatchActionNotApplied extends BadRequestException {}

export const watchSelectionSchema = z
  .object({ conversationId: uuid, selectedClientId: uuid.nullable() })
  .strict();
export const watchScopeSchema = watchSelectionSchema
  .extend({
    identityRevision: digest,
    membershipRevision: digest,
    contextRevision: digest,
  })
  .strict();
export type WatchScope = z.infer<typeof watchScopeSchema>;

/** In-process callback from ApplicationCurrentService. No caller-supplied grant or durable second authority. */
export interface WatchProposalAccess {
  scope: WatchScope;
  assertCurrent(): Promise<void>;
}

export function watchRequestOf(input: unknown): WatchRequest {
  const raw = input as Record<string, unknown> | null;
  const parsed = watchRequestSchema.safeParse(
    raw && {
      ...raw,
      clientId: raw.clientId ?? null,
      sourceRevision: raw.sourceRevision ?? null,
      reason: raw.reason ?? null,
      enabled: raw.enabled ?? null,
    },
  );
  if (!parsed.success) throw new BadRequestException('Invalid watch selection');
  if (!WATCH_SUPPORTED_OPERATIONS[parsed.data.family].includes(parsed.data.operation))
    throw new BadRequestException('Unsupported watch operation for this owner');
  if (!WATCH_TARGET_KINDS[parsed.data.family].includes(parsed.data.targetKind))
    throw new BadRequestException('Unsupported watch target kind for this owner');
  const request = parsed.data;
  if (
    ['client_watchlist', 'defense_budget_target'].includes(request.family) &&
    request.clientId === null
  )
    throw new BadRequestException('Watch owner requires the exact client');
  if (
    request.family === 'defense_budget_target' &&
    request.operation === 'subscribe' &&
    !request.reason?.trim()
  )
    throw new BadRequestException('Watch owner client reason required');
  if (request.family === 'legiwatch_keyword') {
    if (['subscribe', 'resume'].includes(request.operation) && request.sourceRevision === null)
      throw new BadRequestException('Watch owner preview run required');
    if (request.operation === 'set_delivery' && request.enabled === null)
      throw new BadRequestException('Watch owner delivery switch value required');
  }
  return parsed.data;
}

export function watchInput(request: WatchRequest): Record<string, unknown> {
  const { clientId, sourceRevision, reason, enabled, ...rest } = request;
  return {
    ...rest,
    ...(clientId === null ? {} : { clientId }),
    ...(sourceRevision === null ? {} : { sourceRevision }),
    ...(reason === null ? {} : { reason }),
    ...(enabled === null ? {} : { enabled }),
  };
}

export async function assertWatchAccess(
  access: WatchProposalAccess | undefined,
  conversationId: string | null | undefined,
  input: unknown,
  preview?: unknown,
) {
  const scope = watchScopeSchema.safeParse(access?.scope),
    request = watchRequestOf(input);
  if (
    !scope.success ||
    !access ||
    typeof access.assertCurrent !== 'function' ||
    scope.data.conversationId !== conversationId ||
    (scope.data.selectedClientId !== null && request.clientId !== scope.data.selectedClientId)
  )
    throw new ForbiddenException('Current watch proposal access required');
  if (preview !== undefined) {
    const stored = readWatchScope(preview);
    if (nativeCanonicalSha256(stored) !== nativeCanonicalSha256(scope.data))
      throw new ForbiddenException('Watch proposal authority changed');
  }
  await access.assertCurrent();
  return scope.data;
}

export function readWatchScope(preview: unknown): WatchScope {
  const parsed = watchScopeSchema.safeParse(
    (preview as Record<string, unknown> | null)?.[WATCH_SCOPE_KEY],
  );
  if (!parsed.success) throw new ForbiddenException('Watch proposal scope unavailable');
  return parsed.data;
}

export function watchFingerprint(tool: string, input: Record<string, unknown>, scope?: WatchScope) {
  return tool === WATCH_ACTION ? { ...input, [WATCH_SCOPE_KEY]: scope } : input;
}

export function publicWatchPreview(preview: Record<string, unknown>): Record<string, unknown> {
  const { [WATCH_SCOPE_KEY]: _scope, ...publicPreview } = preview;
  return publicPreview;
}

/** Binding of one proposal to one exact canonical target/verb/version. */
export function watchBinding(request: WatchRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        family: request.family,
        clientId: request.clientId,
        targetKind: request.targetKind,
        targetKey: request.targetKey,
        operation: request.operation,
        expectedVersion: request.expectedVersion,
      }),
    )
    .digest('hex');
}

const watchReceiptSchema = z
  .object({
    /** The canonical owner that produced this receipt. */
    owner: z.enum(WATCH_FAMILIES),
    binding: digest,
    operation: z.enum(WATCH_OPERATIONS),
    targetKey,
    /** Stable canonical identity of the watch/rule the owner holds (never Meri-minted). */
    identity: z.string().min(1).max(180),
    state: z.enum(WATCH_WATCHED_STATES),
    /** Exact canonical version after the effect, when the owner publishes one. */
    version: z.number().int().min(1).nullable(),
    /** LegiWatch keyword delivery switch: reported separately, never conflated with rule activation. */
    deliveryEnabled: z.boolean().nullable(),
    /** Owner-published event/revision identity for this exact transition, when it has one. */
    eventId: z.string().min(1).max(180).nullable(),
    /** True only when the owner confirmed the desired state already held (no-op replay). */
    alreadyInState: z.boolean(),
  })
  .strict();
export type WatchReceiptPayload = z.infer<typeof watchReceiptSchema>;

/**
 * Fail-closed validation of a receipt an adapter built from its owner's response.
 * An incomplete or unconfirmed owner acknowledgement must reach the ledger as
 * `receipt: null` (UNKNOWN) instead, so a partial owner outcome can never be
 * stored as an applied watch change.
 */
export function watchReceiptPayload(value: unknown): WatchReceiptPayload {
  const parsed = watchReceiptSchema.safeParse(value);
  if (!parsed.success)
    throw new ServiceUnavailableException('Watch owner acknowledgement incomplete');
  return parsed.data;
}

/**
 * Exact canonical owner receipt. A stale/conflicted/unsupported owner outcome is
 * never relabelled as an applied watch change, and an unconfirmed response is
 * UNKNOWN: the proposal ledger must not blind-resend it.
 */
export function watchReceipt(result: unknown, input: unknown) {
  const request = watchRequestOf(input),
    r = result as { tool?: unknown; result?: unknown } | null;
  const parsed = watchReceiptSchema.safeParse(r?.result);
  const binding = watchBinding(request);
  if (
    r?.tool !== WATCH_ACTION ||
    !parsed.success ||
    parsed.data.binding !== binding ||
    parsed.data.owner !== request.family ||
    parsed.data.operation !== request.operation ||
    parsed.data.targetKey !== request.targetKey
  )
    throw new ServiceUnavailableException('Watch durable outcome unavailable');
  return { request, ...parsed.data };
}

/** Current canonical state of one watched target. Read-only: it never mutates. */
export interface WatchState {
  family: WatchFamily;
  clientId: string | null;
  targetKind: string;
  targetKey: string;
  /** Stable canonical identity (watchId/ruleId/prospect watch id), null when none exists yet. */
  identity: string | null;
  state: (typeof WATCH_WATCHED_STATES)[number] | 'absent';
  version: number | null;
  deliveryEnabled: boolean | null;
  /** Owner facts a reader needs to act next (next run, alerts, mutedUntil, revision, …). */
  facts: Record<string, string | number | boolean | null>;
}

export interface WatchAdapterEffect {
  request: WatchRequest;
  /** Canonical owner receipt payload, or null when the owner gave no confirmed state. */
  receipt: WatchReceiptPayload | null;
}

/**
 * One canonical watch owner. Adapters are thin: authorization, versioning, CAS,
 * scheduling and notification stay with the domain owner. An adapter never
 * deletes a watch identity that the owner does not delete, never invents a
 * requestKey the owner does not honour, and reports `receipt: null` (UNKNOWN)
 * when the owner's acknowledgement is unconfirmed.
 */
/**
 * The acting authority every canonical owner already requires — the owner's own
 * `TenantContext`, passed through unchanged. Adapters never widen it, never
 * synthesize a field the owner did not receive, and fail closed when the
 * Clerk-scoped identity an owner keys on is missing.
 */
export type WatchOwnerContext = TenantContext;

/** One exact canonical target of one watch owner. A read needs nothing else. */
export const watchTargetSchema = z
  .object({
    family: z.enum(WATCH_FAMILIES),
    clientId: uuid.nullable(),
    targetKind: z.string().min(1).max(40),
    targetKey,
  })
  .strict();
export type WatchTarget = z.infer<typeof watchTargetSchema>;

export interface WatchFamilyAdapter {
  readonly family: WatchFamily;
  /** Exact operations this adapter can perform against the current owner/feature state. */
  readonly operations: readonly WatchOperation[];
  inspect(ctx: WatchOwnerContext, target: WatchTarget): Promise<WatchState>;
  apply(
    ctx: WatchOwnerContext,
    request: WatchRequest,
    options: { actionProposalId: string },
  ): Promise<WatchAdapterEffect>;
}
