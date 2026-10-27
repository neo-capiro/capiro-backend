/**
 * MO-06 family leaf: the Defense Budget / Program Element target watch. Canonical
 * owner: apps/api/src/defense-budget-client-watch/defense-budget-client-watch.service.ts
 * (`subscribe` / `list` / `setSubscribed`), whose own event vocabulary is
 * subscribed | unsubscribed | resubscribed and whose targetType vocabulary is
 * program | pe | project | capability (a PE is this owner's targetType, not a
 * separate watch owner).
 *
 * Truthful limits preserved here:
 *  - the owner has no paused state, so `pause` is not offered (the capability
 *    matrix in the contract refuses it before this leaf is reached);
 *  - `subscribe` creates a NEW watch row and there is no unique key or CAS on
 *    (clientId, targetType, targetKey), so this leaf resolves the existing watch
 *    identity first and re-subscribes THAT watch instead of minting a duplicate.
 *    The pre-read is not atomic and is not claimed to be: no requestKey exists at
 *    this boundary, an unconfirmed acknowledgement is reported as UNKNOWN and is
 *    never blind-resent, and the canonical proposal claim remains the Core ledger's
 *    (id, fingerprint);
 *  - the owner's `assertClient` only checks that a tenant client exists. The client
 *    wall is the conversation/proposal scope bound by the ledger plus that owner
 *    check — not a domain-enforced client/prospect equivalence.
 */
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  DefenseBudgetClientWatchService,
  type BudgetWatchTargetType,
} from '../../defense-budget-client-watch/defense-budget-client-watch.service.js';
import {
  WATCH_SUPPORTED_OPERATIONS,
  WatchActionNotApplied,
  type WatchAdapterEffect,
  type WatchFamily,
  type WatchOperation,
  type WatchRequest,
  type WatchState,
  type WatchTarget,
} from './watch-action.contract.js';
import { watchEffectOf, type OwnerAcknowledgement } from './watch-owner.support.js';

type BudgetWatchRow = Awaited<ReturnType<DefenseBudgetClientWatchService['list']>>[number];
type WatchEventRow = BudgetWatchRow['events'][number];
type WatchedState = OwnerAcknowledgement['state'];

const SUBSCRIPTION_EVENTS = Object.freeze(['subscribed', 'unsubscribed', 'resubscribed']);

@Injectable()
export class DefenseBudgetWatchAdapter {
  readonly family: WatchFamily = 'defense_budget_target';
  readonly operations: readonly WatchOperation[] = WATCH_SUPPORTED_OPERATIONS.defense_budget_target;

  constructor(private readonly watch: DefenseBudgetClientWatchService) {}

  async inspect(ctx: TenantContext, target: WatchTarget): Promise<WatchState> {
    const found = await this.find(ctx, target);
    const latest = found === undefined ? undefined : this.latestSubscription(found);
    return {
      family: this.family,
      clientId: target.clientId,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      identity: found?.id ?? null,
      state: found === undefined ? 'absent' : this.state(found, latest),
      version: null,
      deliveryEnabled: found === undefined ? null : latest?.eventType !== 'unsubscribed',
      facts: {
        targetType: target.targetKind,
        eventCount: found?.events.length ?? 0,
        lastEventType: latest?.eventType ?? null,
        lastEventAt: latest?.createdAt?.toISOString?.() ?? null,
      },
    };
  }

  async apply(
    ctx: TenantContext,
    request: WatchRequest,
    _options: { actionProposalId: string },
  ): Promise<WatchAdapterEffect> {
    if (request.operation === 'subscribe') return this.subscribe(ctx, request);
    const found = await this.find(ctx, request);
    if (found === undefined)
      throw new WatchActionNotApplied('Watch owner target has no subscription to change');
    const event = await this.watch.setSubscribed(ctx, {
      clientId: this.clientId(request),
      watchId: found.id,
      subscribed: request.operation === 'resume',
    });
    if (!event) throw new ServiceUnavailableException('Watch owner acknowledgement incomplete');
    return watchEffectOf(request, {
      identity: found.id,
      state: event.eventType === 'unsubscribed' ? 'unsubscribed' : 'active',
      version: null,
      deliveryEnabled: event.eventType !== 'unsubscribed',
      eventId: event.id,
      // The owner returns its existing latest event when the desired state already
      // holds, and a NEW event (resubscribed/unsubscribed) when it changed.
      alreadyInState:
        event.eventType === (request.operation === 'resume' ? 'subscribed' : 'unsubscribed'),
    });
  }

  private async subscribe(ctx: TenantContext, request: WatchRequest): Promise<WatchAdapterEffect> {
    const clientId = this.clientId(request);
    const reason = request.reason?.trim();
    if (!reason) throw new WatchActionNotApplied('Watch owner client reason required');
    const existing = await this.find(ctx, request);
    if (existing !== undefined) {
      const event = await this.watch.setSubscribed(ctx, {
        clientId,
        watchId: existing.id,
        subscribed: true,
      });
      if (!event) throw new ServiceUnavailableException('Watch owner acknowledgement incomplete');
      return watchEffectOf(request, {
        identity: existing.id,
        state: 'active',
        version: null,
        deliveryEnabled: true,
        eventId: event.id,
        alreadyInState: event.eventType === 'subscribed',
      });
    }
    const created = await this.watch.subscribe(ctx, {
      clientId,
      targetType: request.targetKind as BudgetWatchTargetType,
      targetKey: request.targetKey,
      clientReason: reason,
    });
    if (!created?.id)
      throw new ServiceUnavailableException('Watch owner acknowledgement incomplete');
    return watchEffectOf(request, {
      identity: created.id,
      state: 'active',
      version: null,
      deliveryEnabled: true,
      // `subscribe` creates the initial 'subscribed' event but does not return it.
      eventId: null,
      alreadyInState: false,
    });
  }

  private async find(ctx: TenantContext, target: WatchTarget): Promise<BudgetWatchRow | undefined> {
    const watches = await this.watch.list(ctx, this.clientId(target));
    return watches.find(
      (row) => row.targetType === target.targetKind && row.targetKey === target.targetKey,
    );
  }

  private latestSubscription(row: BudgetWatchRow): WatchEventRow | undefined {
    return [...row.events].reverse().find((event) => SUBSCRIPTION_EVENTS.includes(event.eventType));
  }

  private state(row: BudgetWatchRow, latest: WatchEventRow | undefined): WatchedState {
    if (latest === undefined) return 'needs_review';
    return latest.eventType === 'unsubscribed' ? 'unsubscribed' : 'active';
  }

  private clientId(target: WatchTarget): string {
    if (target.clientId === null)
      throw new WatchActionNotApplied('Defense budget watch requires the exact client');
    return target.clientId;
  }
}
