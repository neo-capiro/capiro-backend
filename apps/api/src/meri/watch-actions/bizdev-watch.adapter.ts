/**
 * MO-06 family leaf: the Business Development prospect watch. Canonical owner:
 * apps/api/src/business-development/bizdev-watch.service.ts (unique tenant+prospect
 * watch, POST/GET/PATCH prospects/:id/watch) behind its existing feature flag and
 * prospect access checks.
 *
 * Owner facts this leaf preserves rather than re-implements:
 *  - one watch per (tenant, prospect): `subscribe` activates or REUSES it, so no
 *    second watch is ever minted;
 *  - `status` is the owner's active | paused | ended vocabulary. `unsubscribe` maps
 *    to the owner's terminal `ended` (which also clears the legacy watchRequested
 *    bit) — there is no delete, and none is invented here;
 *  - resuming from paused/ended clears `mutedUntil` and the owner's evaluator has
 *    already advanced its baselines, so suppressed changes never replay as alerts;
 *  - the owner has NO CAS/requestKey on this boundary. The pre-read below exists
 *    only to report `alreadyInState` and the prior state truthfully; it does not
 *    make the write idempotent, and a lost owner acknowledgement is reported as
 *    UNKNOWN instead of being resent.
 */
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  BizDevWatchService,
  type BizDevWatchResponse,
} from '../../business-development/bizdev-watch.service.js';
import {
  WATCH_SUPPORTED_OPERATIONS,
  type WatchAdapterEffect,
  type WatchFamily,
  type WatchOperation,
  type WatchRequest,
  type WatchState,
  type WatchTarget,
} from './watch-action.contract.js';
import { watchEffectOf, type OwnerAcknowledgement } from './watch-owner.support.js';

type WatchedState = OwnerAcknowledgement['state'];

/** Only the owner's own statuses are ever reported. */
function bizdevState(status: string): WatchedState {
  if (status === 'active' || status === 'paused' || status === 'ended') return status;
  throw new ServiceUnavailableException('Watch owner state unavailable');
}

/** The exact owner status each lifecycle verb maps to. No verb invents a state. */
const STATUS_FOR: Readonly<Record<string, 'active' | 'paused' | 'ended'>> = Object.freeze({
  subscribe: 'active',
  resume: 'active',
  pause: 'paused',
  unsubscribe: 'ended',
});

@Injectable()
export class BizdevWatchAdapter {
  readonly family: WatchFamily = 'business_development_prospect';
  readonly operations: readonly WatchOperation[] =
    WATCH_SUPPORTED_OPERATIONS.business_development_prospect;

  constructor(private readonly watch: BizDevWatchService) {}

  async inspect(ctx: TenantContext, target: WatchTarget): Promise<WatchState> {
    return this.state(target, await this.watch.getWatch(ctx, target.targetKey));
  }

  async apply(
    ctx: TenantContext,
    request: WatchRequest,
    _options: { actionProposalId: string },
  ): Promise<WatchAdapterEffect> {
    const status = STATUS_FOR[request.operation];
    if (!status) throw new ServiceUnavailableException('Watch owner operation unsupported');
    const before = await this.watch.getWatch(ctx, request.targetKey);
    const response =
      request.operation === 'subscribe'
        ? await this.watch.activateWatch(ctx, request.targetKey, {})
        : await this.watch.updateWatch(ctx, request.targetKey, { status });
    const watch = response.watch;
    if (!watch) throw new ServiceUnavailableException('Watch owner acknowledgement incomplete');
    const state = bizdevState(watch.status);
    return watchEffectOf(request, {
      // The owner's identity is the prospect itself: the watch is unique per
      // (tenant, prospect), and the owner publishes no separate watch id here.
      identity: request.targetKey,
      state,
      version: null,
      deliveryEnabled: watch.status === 'active' && watch.mutedUntil === null,
      eventId: null,
      alreadyInState: before.watch !== null && before.watch.status === watch.status,
    });
  }

  private state(target: WatchTarget, response: BizDevWatchResponse): WatchState {
    const watch = response.watch;
    return {
      family: this.family,
      clientId: target.clientId,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      identity: watch === null ? null : target.targetKey,
      state: watch === null ? 'absent' : bizdevState(watch.status),
      version: null,
      deliveryEnabled: watch === null ? null : watch.status === 'active' && watch.mutedUntil === null,
      facts: {
        categories: watch?.categories.join(',') ?? null,
        mutedUntil: watch?.mutedUntil ?? null,
        ownerUserId: watch?.ownerUserId ?? null,
        updatedAt: watch?.updatedAt ?? null,
        sourceHealth: response.sources.map((source) => `${source.source}:${source.health}`).join(','),
        lastCompletedCheckAt: response.lastCompletedCheckAt,
      },
    };
  }
}
