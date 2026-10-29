/**
 * MO-06 family leaf: the LegiWatch keyword-rule watch, whose canonical owner is
 * apps/intel-api/src/tracker/keywords (KeywordRuleService / KeywordDiscoveryService /
 * KeywordDeliveryService), reached over the existing internal Meri route.
 *
 * The owner keeps two DISTINCT switches and this adapter never conflates them:
 *  - rule activation (`discovery.activation`: needs_review → active, or → paused);
 *  - the notification delivery switch (`delivery.activation`: config.deliveryEnabled).
 * A paused rule is never reported as "delivery disabled", and every mutation passes
 * the owner's own `expectedVersion` (RULE_CHANGED_RELOAD), its complete-current-preview
 * requirement (previewRunId) and its explicit from-now baseline. There is no delete:
 * `unsubscribe` stops the owner's future work (rule paused + delivery switch off) and
 * says exactly that.
 */
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  WATCH_SUPPORTED_OPERATIONS,
  WatchActionNotApplied,
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

@Injectable()
export class KeywordWatchAdapter {
  readonly family: WatchFamily = 'legiwatch_keyword';
  readonly operations: readonly WatchOperation[] = WATCH_SUPPORTED_OPERATIONS.legiwatch_keyword;

  async inspect(ctx: WatchOwnerContext, target: WatchTarget): Promise<WatchState> {
    const answer = await this.call(ctx, 'watch_inspect', target, { ruleId: target.targetKey });
    return watchStateOf(target, inspectTargetOf(answer));
  }

  async apply(
    ctx: WatchOwnerContext,
    request: WatchRequest,
    options: { actionProposalId: string },
  ): Promise<WatchAdapterEffect> {
    const input = this.input(request);
    // `strict: false` — an unconfirmed write answer is UNKNOWN (receipt null), not a
    // thrown failure: the ledger records "no confirmed receipt, do not repeat".
    const answer = await this.call(ctx, 'watch_apply', request, input, false);
    // A partially applied owner transition (rule paused, delivery switch not
    // confirmed) is UNKNOWN too: the ledger must not report an applied watch change.
    return watchEffectOf(request, answer === null ? null : acknowledgementOf(answer));
  }

  private input(request: WatchRequest): Record<string, unknown> {
    const base = { ruleId: request.targetKey, expectedVersion: request.expectedVersion };
    switch (request.operation) {
      case 'subscribe':
      case 'resume':
        // The owner accepts activation only against its own complete current
        // preview run (COMPLETE_CURRENT_PREVIEW_REQUIRED) from a now-baseline.
        if (request.sourceRevision === null)
          throw new WatchActionNotApplied('Watch owner preview run required');
        return {
          ...base,
          operation: request.operation,
          previewRunId: request.sourceRevision,
          baseline: 'from_now',
        };
      case 'pause':
      case 'unsubscribe':
        return { ...base, operation: request.operation };
      case 'set_delivery':
        if (request.enabled === null)
          throw new WatchActionNotApplied('Watch owner delivery switch value required');
        return { ...base, operation: request.operation, enabled: request.enabled };
      default:
        throw new WatchActionNotApplied('Unsupported watch operation for this owner');
    }
  }

  private async call(
    ctx: WatchOwnerContext,
    tool: 'watch_inspect' | 'watch_apply',
    target: WatchTarget,
    input: Record<string, unknown>,
    strict = true,
  ): Promise<unknown | null> {
    const actor = requireClerkActor(ctx);
    const answer = await callIntelWatchOwner({
      tenantId: ctx.tenantId,
      actor,
      tool,
      family: this.family,
      input: { ...input, ...(target.clientId === null ? {} : { clientId: target.clientId }) },
    });
    // A read that did not come back has no state to report and fails closed; a write
    // that did not come back is UNKNOWN and is never resent from here.
    if (!answer.confirmed) {
      if (strict) throw new ServiceUnavailableException('Watch owner state unavailable');
      return null;
    }
    return answer.body;
  }
}
