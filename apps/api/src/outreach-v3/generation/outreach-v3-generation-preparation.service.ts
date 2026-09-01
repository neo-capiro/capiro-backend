import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  OUTREACH_REFERENCE_TX_TIMEOUT_MS,
  OutreachTargetReferenceService,
} from '../../capabilities/targets/outreach-target-reference.service.js';
import { OutreachContextReferenceService } from '../../capabilities/context/outreach-context-reference.service.js';
import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
import {
  allAcceptedContextRefs,
  type OutreachCampaignSpecV1,
} from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import {
  OutreachV3GenerationContextError,
  prepareOutreachV3ContextForGeneration,
  type PreparedOutreachV3Context,
} from './outreach-v3-generation-context.js';
import type { OutreachV3GenerationSlot } from './outreach-v3-generation-plan.js';

export interface PreparedOutreachV3GenerationSlot extends PreparedOutreachV3Context {
  slot: OutreachV3GenerationSlot;
  currentTargets: OutreachResolvedTargetRefV1[];
}

@Injectable()
export class OutreachV3GenerationPreparationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly targetReferences: OutreachTargetReferenceService,
    private readonly contextReferences: OutreachContextReferenceService,
  ) {}

  /**
   * Reauthorize the exact target and context snapshots for ONE already-partitioned
   * slot. Any changed/unavailable source blocks before a model can be called.
   *
   * Every ref resolves within ONE shared transaction rather than one
   * transaction per ref. The per-ref `resolveOne`/`resolveOne`-style calls
   * this replaced each opened and committed their own transaction against a
   * 10-connection pool, so a slot with 20 accepted context refs cost 20
   * separate transaction acquisitions before generation even began — pure
   * overhead that scales with how much context a campaign carries, not with
   * anything the LLM call needs. Sharing one transaction (the same pattern
   * `OutreachCommandEngineService` already uses for target/context
   * reauthorization) keeps identical per-ref error messages — each ref still
   * gets its own try/catch — while cutting that to one acquisition per slot.
   */
  async prepareSlot(
    ctx: TenantContext,
    spec: OutreachCampaignSpecV1,
    slot: OutreachV3GenerationSlot,
  ): Promise<PreparedOutreachV3GenerationSlot> {
    const selectedTargets = slot.recipients.map((recipient) => {
      const selected = spec.targeting.selectedTargetRefs.find(
        (candidate) => candidate.targetKey === recipient.targetKey,
      );
      if (!selected) {
        throw new OutreachCommandError(
          'OUTREACH_STATE_CORRUPT',
          'A generation slot references a target that is not in the canonical campaign.',
          500,
        );
      }
      return selected;
    });

    const wantedContextKeys = new Set(contextKeysFor(slot));
    const allSelectedContext = allAcceptedContextRefs(spec);
    const selectedContext = allSelectedContext.filter((entry) =>
      wantedContextKeys.has(entry.contextKey),
    );
    if (selectedContext.length !== wantedContextKeys.size) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'A generation slot references context that is not in the canonical campaign.',
        500,
      );
    }

    const { currentTargets, currentContext } = await this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        const resolvedTargets: OutreachResolvedTargetRefV1[] = [];
        for (const selected of selectedTargets) {
          let current: OutreachResolvedTargetRefV1;
          try {
            current = await this.targetReferences.resolveOneWithinTx(tx, ctx, selected.locator);
          } catch {
            throw generationBlocked(
              'A selected target is no longer available. Review Targets before generating.',
              { targetKey: selected.targetKey, reason: 'target_unavailable' },
            );
          }
          if (
            current.targetKey !== selected.targetKey ||
            current.snapshotHash !== selected.snapshotHash
          ) {
            throw generationBlocked(
              'A selected target changed after review. Review the updated target before generating.',
              { targetKey: selected.targetKey, reason: 'target_snapshot_changed' },
            );
          }
          resolvedTargets.push(current);
        }

        const resolvedContext = [];
        for (const selected of selectedContext) {
          try {
            resolvedContext.push(
              await this.contextReferences.resolveOneWithinTx(tx, ctx, {
                locator: selected.locator,
                contextClass: selected.contextClass,
                scope: selected.scope,
              }),
            );
          } catch {
            throw generationBlocked(
              'Selected campaign context is no longer available. Review Context before generating.',
              { contextKey: selected.contextKey, reason: 'context_unavailable' },
            );
          }
        }

        return { currentTargets: resolvedTargets, currentContext: resolvedContext };
      },
      { timeoutMs: OUTREACH_REFERENCE_TX_TIMEOUT_MS },
    );

    let prepared: PreparedOutreachV3Context;
    try {
      prepared = prepareOutreachV3ContextForGeneration(selectedContext, currentContext);
    } catch (error) {
      if (error instanceof OutreachV3GenerationContextError) {
        throw generationBlocked(error.message, {
          contextKey: error.contextKey,
          reason: error.code.toLowerCase(),
        });
      }
      throw error;
    }

    return {
      slot,
      currentTargets,
      ...prepared,
    };
  }
}

function contextKeysFor(slot: OutreachV3GenerationSlot): string[] {
  return [
    ...slot.context.requiredPolicy,
    ...slot.context.writingGuidance,
    ...slot.context.campaignFacts,
    ...slot.context.targetSpecific,
    ...slot.context.groupSafe,
  ]
    .map((entry) => entry.contextKey)
    .sort(compareStrings);
}

function generationBlocked(
  message: string,
  metadata: Record<string, string>,
): OutreachCommandError {
  return new OutreachCommandError('OUTREACH_COMMAND_BLOCKED', message, 409, metadata);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
