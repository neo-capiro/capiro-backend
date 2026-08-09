import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import type { CapabilityDefinition, CapabilityRuntimeSchema } from '../capability-definition.js';
import { assertCapabilityResult, type CapabilityResult } from '../capability-result.js';

const inputSchemaZod = z
  .object({
    goal: z
      .object({
        goalPresent: z.boolean(),
        objectivePresent: z.boolean(),
        askMode: z.enum(['undecided', 'explicit', 'none']),
        whyNowPresent: z.boolean(),
      })
      .strict(),
    targeting: z
      .object({
        selectedCount: z.number().int().min(0).max(500),
        sendReadyCount: z.number().int().min(0).max(500),
        staffCount: z.number().int().min(0).max(500),
        principalCount: z.number().int().min(0).max(500),
        relationshipPreference: z.enum(['any', 'existing', 'new', 'mixed']),
      })
      .strict(),
    context: z
      .object({
        requiredPolicyCount: z.number().int().min(0).max(500),
        writingGuidanceCount: z.number().int().min(0).max(500),
        campaignFactCount: z.number().int().min(0).max(500),
        targetSpecificCount: z.number().int().min(0).max(500),
        groupSafeCount: z.number().int().min(0).max(500),
      })
      .strict(),
    currentDelivery: z
      .object({
        pattern: z.enum([
          'undecided',
          'personalized_separate',
          'uniform_separate',
          'shared_thread',
        ]),
        personalization: z.enum(['undecided', 'high', 'light', 'none']),
      })
      .strict(),
  })
  .strict();
export type RecommendOutreachStrategyInput = z.infer<typeof inputSchemaZod>;

export interface RecommendOutreachStrategyDataV1 {
  recommendedPattern:
    | 'personalized_separate'
    | 'uniform_separate'
    | 'shared_thread';
  recommendedPersonalization: 'high' | 'light' | 'none';
  recommendedTone: 'professional' | 'collaborative' | 'direct';
  recommendedLength: 'short' | 'medium';
  rationale: string[];
  unresolvedDecisions: string[];
  safetyNotes: string[];
}

const inputSchema: CapabilityRuntimeSchema<RecommendOutreachStrategyInput> = {
  name: 'recommend_outreach_strategy.input.v1',
  parse(value) {
    return inputSchemaZod.parse(value);
  },
};

const outputSchema: CapabilityRuntimeSchema<CapabilityResult<RecommendOutreachStrategyDataV1>> = {
  name: 'recommend_outreach_strategy.output.v1',
  parse(value) {
    return assertCapabilityResult<RecommendOutreachStrategyDataV1>(
      value,
      'recommend_outreach_strategy',
    );
  },
};

@Injectable()
export class RecommendOutreachStrategyCapability {
  definition(): CapabilityDefinition<
    RecommendOutreachStrategyInput,
    RecommendOutreachStrategyDataV1
  > {
    return {
      name: 'recommend_outreach_strategy',
      description:
        'Deterministically recommend an Outreach delivery pattern, personalization level, tone and length from canonical campaign counts and readiness facts.',
      version: 1,
      readOnly: true,
      riskClass: 'read',
      surfaces: ['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'],
      supportsClientScope: true,
      requiresClientScope: false,
      timeoutMs: 2_000,
      maxResultCount: 1,
      maxResultBytes: 32_000,
      provenanceRequired: true,
      inputSchema,
      outputSchema,
      execute: (ctx, input) => this.execute(ctx, input),
    };
  }

  async execute(
    ctx: AuthorizedCapabilityContext,
    rawInput: RecommendOutreachStrategyInput,
  ): Promise<CapabilityResult<RecommendOutreachStrategyDataV1>> {
    const input = inputSchemaZod.parse(rawInput);
    const rationale: string[] = [];
    const unresolvedDecisions: string[] = [];
    const safetyNotes: string[] = [];

    const hasPerTargetContext =
      input.targeting.selectedCount > 0 &&
      input.context.targetSpecificCount >= input.targeting.selectedCount;
    const hasSharedContext =
      input.context.campaignFactCount > 0 || input.context.groupSafeCount > 0;

    let recommendedPersonalization: RecommendOutreachStrategyDataV1['recommendedPersonalization'];
    if (hasPerTargetContext && input.targeting.selectedCount <= 25) {
      recommendedPersonalization = 'high';
      rationale.push('Every selected target has target-specific context and the audience is small enough for separate review.');
    } else if (hasSharedContext || input.context.writingGuidanceCount > 0) {
      recommendedPersonalization = 'light';
      rationale.push('Shared campaign facts or approved writing guidance support light personalization.');
    } else {
      recommendedPersonalization = 'none';
      rationale.push('The accepted context does not yet support factual per-target personalization.');
    }

    let recommendedPattern: RecommendOutreachStrategyDataV1['recommendedPattern'];
    if (input.targeting.selectedCount <= 1 || recommendedPersonalization === 'high') {
      recommendedPattern = 'personalized_separate';
      rationale.push('Separate messages preserve target scope and reviewability.');
    } else if (input.currentDelivery.pattern === 'shared_thread' && recommendedPersonalization === 'none') {
      recommendedPattern = 'shared_thread';
      rationale.push('The user-selected shared thread is compatible with a uniform non-personalized message.');
    } else {
      recommendedPattern = 'uniform_separate';
      rationale.push('Uniform separate delivery avoids exposing recipient lists while keeping one shared campaign message.');
    }

    const recommendedTone: RecommendOutreachStrategyDataV1['recommendedTone'] =
      input.targeting.relationshipPreference === 'existing'
        ? 'collaborative'
        : input.goal.askMode === 'explicit'
          ? 'direct'
          : 'professional';
    const recommendedLength: RecommendOutreachStrategyDataV1['recommendedLength'] =
      input.goal.askMode === 'explicit' && input.goal.whyNowPresent ? 'short' : 'medium';

    if (!input.goal.goalPresent || !input.goal.objectivePresent) {
      unresolvedDecisions.push('Campaign goal and objective must be explicit before strategy is complete.');
    }
    if (input.goal.askMode === 'undecided') {
      unresolvedDecisions.push('Decide whether the outreach includes an explicit ask.');
    }
    if (input.targeting.selectedCount === 0) {
      unresolvedDecisions.push('Select at least one target before finalizing delivery strategy.');
    }
    if (input.targeting.sendReadyCount < input.targeting.selectedCount) {
      unresolvedDecisions.push('Resolve target contactability or role-health issues before any future send review.');
    }
    if (input.context.requiredPolicyCount === 0) {
      safetyNotes.push('No required policy is accepted; policy may be genuinely unnecessary, but that should be an explicit decision.');
    }
    if (recommendedPersonalization === 'high' && !hasPerTargetContext) {
      safetyNotes.push('High personalization cannot rely on inferred or unreviewed target facts.');
    }
    safetyNotes.push('This recommendation changes no campaign state and grants no generation or send authority.');

    const retrievedAt = new Date().toISOString();
    return {
      capability: 'recommend_outreach_strategy',
      schemaVersion: 1,
      data: {
        recommendedPattern,
        recommendedPersonalization,
        recommendedTone,
        recommendedLength,
        rationale,
        unresolvedDecisions,
        safetyNotes,
      },
      provenance: [
        {
          recordType: 'outreach_campaign_state',
          recordId: 'current',
          sourceSystem: 'capiro',
          sourceDate: retrievedAt,
          lastVerifiedAt: retrievedAt,
          retrievedAt,
          verificationClass: 'derived',
          classification: 'recommendation',
        },
      ],
      exclusions: [],
      scope: { tenantId: ctx.tenantId, clientId: ctx.clientScope?.clientId ?? null },
      freshness: { asOf: retrievedAt, degraded: false, reasons: [] },
      authorization: { filtered: false, restrictedCount: 0 },
    };
  }
}
