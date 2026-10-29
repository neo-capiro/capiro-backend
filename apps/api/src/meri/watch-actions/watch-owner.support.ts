/**
 * Owner-agnostic helpers shared by the MO-06 watch family leaves. Adapters stay
 * thin: authorization, version/CAS, scheduling and notification stay with the
 * canonical domain owner, and nothing here invents a Meri-owned watch identity, a
 * grant, a scheduler, a mutation framework or a second effect ledger.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  WATCH_WATCHED_STATES,
  watchBinding,
  watchReceiptPayload,
  type WatchAdapterEffect,
  type WatchFamily,
  type WatchReceiptPayload,
  type WatchRequest,
  type WatchState,
  type WatchTarget,
} from './watch-action.contract.js';

/** The existing internal Meri route on the owner app (same transport MeriToolsService already uses). */
const INTERNAL_WATCH_PATH = '/intel-api/internal/legiwatch/meri/watch';

const boundToken = z.string().min(1).max(180);
const ownerUuid = z
  .string()
  .uuid()
  .regex(/^[a-f0-9-]+$/);

/** Exact owner acknowledgement of one applied watch transition. */
export interface OwnerAcknowledgement {
  identity: string;
  state: (typeof WATCH_WATCHED_STATES)[number];
  version: number | null;
  deliveryEnabled: boolean | null;
  eventId: string | null;
  alreadyInState: boolean;
}

const acknowledgementSchema = z
  .object({
    identity: boundToken,
    state: z.enum(WATCH_WATCHED_STATES),
    version: z.number().int().min(1).nullable(),
    deliveryEnabled: z.boolean().nullable(),
    eventId: boundToken.nullable(),
    alreadyInState: z.boolean(),
  })
  .strict();

const targetSchema = z
  .object({
    identity: boundToken.nullable(),
    state: z.union([z.enum(WATCH_WATCHED_STATES), z.literal('absent')]),
    version: z.number().int().min(1).nullable(),
    deliveryEnabled: z.boolean().nullable(),
    clientId: ownerUuid.nullable(),
    facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();

export function watchStateOf(target: WatchTarget, observed: z.infer<typeof targetSchema>): WatchState {
  // The exact client wall the owner reported must match the target's binding.
  if ((target.clientId ?? null) !== observed.clientId)
    throw new ForbiddenException('Watch owner client scope mismatch');
  return {
    family: target.family,
    clientId: observed.clientId,
    targetKind: target.targetKind,
    targetKey: target.targetKey,
    identity: observed.identity,
    state: observed.state,
    version: observed.version,
    deliveryEnabled: observed.deliveryEnabled,
    facts: observed.facts,
  };
}

export function watchEffectOf(
  request: WatchRequest,
  acknowledgement: OwnerAcknowledgement | null,
): WatchAdapterEffect {
  if (acknowledgement === null) return { request, receipt: null };
  const receipt: WatchReceiptPayload = watchReceiptPayload({
    owner: request.family,
    binding: watchBinding(request),
    operation: request.operation,
    targetKey: request.targetKey,
    identity: acknowledgement.identity,
    state: acknowledgement.state,
    version: acknowledgement.version,
    deliveryEnabled: acknowledgement.deliveryEnabled,
    eventId: acknowledgement.eventId,
    alreadyInState: acknowledgement.alreadyInState,
  });
  return { request, receipt };
}

/** Fail-closed read of one owner acknowledgement; an unconfirmed shape is UNKNOWN, never an applied change. */
export function acknowledgementOf(body: unknown): OwnerAcknowledgement | null {
  const applied = (body as { applied?: unknown } | null)?.applied,
    partial = (body as { partial?: unknown } | null)?.partial;
  // A partially applied owner transition is not a complete acknowledgement.
  if (applied !== true || partial === true) return null;
  const parsed = acknowledgementSchema.safeParse(
    (body as { acknowledgement?: unknown } | null)?.acknowledgement,
  );
  return parsed.success ? parsed.data : null;
}

export function inspectTargetOf(body: unknown): z.infer<typeof targetSchema> {
  const parsed = targetSchema.safeParse((body as { target?: unknown } | null)?.target);
  if (!parsed.success) throw new ServiceUnavailableException('Watch owner state unavailable');
  return parsed.data;
}

export interface IntelWatchAnswer {
  confirmed: boolean;
  body: unknown;
}

/**
 * Call the existing internal Meri route on the owner app. A response that never
 * arrived is `confirmed: false` — never blind-resent, never reconstructed.
 */
export async function callIntelWatchOwner(payload: {
  tenantId: string;
  actor: string;
  tool: 'watch_inspect' | 'watch_apply';
  family: WatchFamily;
  input: Record<string, unknown>;
}): Promise<IntelWatchAnswer> {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (typeof secret !== 'string' || secret.length === 0)
    throw new ServiceUnavailableException('Watch owner transport unavailable');
  const origin = (process.env.TRACKER_APP_BASE_URL || 'https://app.capiro.ai').replace(/\/+$/u, '');
  let response: Response;
  try {
    response = await fetch(`${origin}${INTERNAL_WATCH_PATH}`, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', 'x-internal-service-secret': secret },
      body: JSON.stringify(payload),
    });
  } catch {
    return { confirmed: false, body: null };
  }
  if (response.status === 401 || response.status === 403)
    throw new ForbiddenException('Watch owner refused this authority');
  if (response.status === 409) throw new ConflictException('Watch owner version conflict');
  if ([400, 404, 422].includes(response.status))
    throw new BadRequestException('Watch owner refused this request');
  if (!response.ok) return { confirmed: false, body: null };
  try {
    return { confirmed: true, body: await response.json() };
  } catch {
    return { confirmed: false, body: null };
  }
}

/** Clerk-scoped owners must fail closed rather than address another owner scope. */
export function requireClerkActor(ctx: { clerkUserId: string | null }): string {
  const actor = ctx.clerkUserId?.trim();
  if (!actor) throw new BadRequestException('Watch owner actor identity unavailable');
  return actor;
}
