import { WatchActionNotApplied } from './watch-action.contract.js';
/**
 * MO-06 family leaf: the ClientWatchlist (tracker watchlist) watch, whose canonical
 * owner is apps/intel-api/src/tracker/tracker-watchlist.controller.ts +
 * tracker-watchlist.service.ts (the CURRENT selected owner — the separate hearing
 * watchlist under apps/intel-api/src/watchlist is a different owner and is not
 * equivalent, so it is out of this leaf's scope).
 *
 * The owner's watch has no delete and no active/paused flag of its own: the exact
 * levers it publishes are (a) the watchlist head + topics/terms, versioned by
 * `expectedVersion` (PUT watchlists/:clientId), and (b) the per-user alert
 * preferences that actually produce future events (GET/PUT :clientId/alert-prefs).
 * So this leaf maps the lifecycle onto those real levers and reports the mapping
 * truthfully:
 *  - inspect  → watchlist head/history + the actor's own alert prefs (read-only);
 *  - subscribe/resume → the actor's configured delivery channels re-enabled;
 *  - pause → every delivery channel disabled (future events stop; the watchlist and
 *    its topics/terms are preserved untouched);
 *  - unsubscribe is NOT offered here. There is no owner operation that removes a
 *    watchlist, so advertising an `unsubscribe` verb would be a fabricated delete.
 */
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  type WatchAdapterEffect,
  type WatchFamily,
  type WatchOperation,
  type WatchOwnerContext,
  type WatchRequest,
  type WatchState,
  type WatchTarget,
} from './watch-action.contract.js';
import {
  acknowledgementOf,
  callIntelWatchOwner,
  inspectTargetOf,
  requireClerkActor,
  watchEffectOf,
  watchStateOf,
} from './watch-owner.support.js';

/** The exact owner operations this leaf can reach today (see the contract's matrix note). */
export const CLIENT_WATCHLIST_OPERATIONS: readonly WatchOperation[] = Object.freeze([
  'subscribe',
  'pause',
]);

@Injectable()
export class ClientWatchlistAdapter {
  readonly family: WatchFamily = 'client_watchlist';
  readonly operations: readonly WatchOperation[] = CLIENT_WATCHLIST_OPERATIONS;

  async inspect(ctx: WatchOwnerContext, target: WatchTarget): Promise<WatchState> {
    const answer = await this.call(ctx, 'watch_inspect', target, {});
    return watchStateOf(target, inspectTargetOf(answer));
  }

  async apply(
    ctx: WatchOwnerContext,
    request: WatchRequest,
    options: { actionProposalId: string },
  ): Promise<WatchAdapterEffect> {
    if (!this.operations.includes(request.operation))
      throw new WatchActionNotApplied('Unsupported watch operation for this owner');
    const answer = await this.call(
      ctx,
      'watch_apply',
      request,
      { operation: request.operation, expectedVersion: request.expectedVersion },
      false,
    );
    return watchEffectOf(request, answer === null ? null : acknowledgementOf(answer));
  }

  private async call(
    ctx: WatchOwnerContext,
    tool: 'watch_inspect' | 'watch_apply',
    target: WatchTarget,
    input: Record<string, unknown>,
    strict = true,
  ): Promise<unknown | null> {
    if (target.clientId === null)
      throw new WatchActionNotApplied('Client watchlist requires the exact client');
    const actor = requireClerkActor(ctx);
    const answer = await callIntelWatchOwner({
      tenantId: ctx.tenantId,
      actor,
      tool,
      family: this.family,
      input: { ...input, clientId: target.clientId },
    });
    if (!answer.confirmed) {
      if (strict) throw new ServiceUnavailableException('Watch owner state unavailable');
      return null;
    }
    return answer.body;
  }
}
