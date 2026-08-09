import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CapabilityRegistry } from '../../capabilities/capability-registry.js';
import type { AuthorizedCapabilityContext } from '../../capabilities/capability-context.js';
import { CapabilityError } from '../../capabilities/capability-errors.js';
import type { CapabilityResult } from '../../capabilities/capability-result.js';
import type {
  SearchMemoryDataV1,
  SearchMemoryInput,
} from '../../capabilities/context/search-memory.capability.js';
import type {
  ResearchGovernmentDataV1,
  ResearchGovernmentInput,
} from '../../capabilities/context/research-government.capability.js';
import type {
  GetDocumentDataV1,
  GetDocumentInput,
} from '../../capabilities/context/get-document.capability.js';
import type {
  RecommendOutreachStrategyDataV1,
  RecommendOutreachStrategyInput,
} from '../../capabilities/context/recommend-outreach-strategy.capability.js';
import { OutreachContextReferenceService } from '../../capabilities/context/outreach-context-reference.service.js';
import type {
  OutreachContextScopeV1,
  OutreachResolvedContextRefV1,
} from '../../capabilities/context/outreach-context.contract.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import {
  allAcceptedContextRefs,
  type OutreachCampaignSpecV1,
} from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { deriveOutreachTargetCoverage } from '../targets/outreach-target-coverage.service.js';

export interface ContextSnapshotRevalidationV1 {
  contextKey: string;
  status: 'current' | 'changed' | 'unavailable';
  selectedSnapshotHash: string;
  currentSnapshotHash: string | null;
  changedFields: string[];
  currentContext: OutreachResolvedContextRefV1 | null;
}

@Injectable()
export class OutreachV3ContextService {
  constructor(
    private readonly sessions: OutreachSessionService,
    private readonly capabilities: CapabilityRegistry,
    private readonly contexts: OutreachContextReferenceService,
  ) {}

  async searchMemory(
    ctx: TenantContext,
    sessionId: string,
    input: SearchMemoryInput,
  ): Promise<CapabilityResult<SearchMemoryDataV1>> {
    const campaign = await this.sessions.getSession(ctx, sessionId);
    assertScopeAllowed(campaign.spec, input.scope);
    assertClientContextAllowed(campaign.spec, input.clientId);
    return this.execute<SearchMemoryDataV1>(
      'search_memory',
      this.capabilityContext(ctx, sessionId, input.clientId),
      input,
    );
  }

  async researchGovernment(
    ctx: TenantContext,
    sessionId: string,
    input: ResearchGovernmentInput,
  ): Promise<CapabilityResult<ResearchGovernmentDataV1>> {
    const campaign = await this.sessions.getSession(ctx, sessionId);
    assertScopeAllowed(campaign.spec, input.scope);
    return this.execute<ResearchGovernmentDataV1>(
      'research_government',
      this.capabilityContext(ctx, sessionId, null),
      input,
    );
  }

  async getDocument(
    ctx: TenantContext,
    sessionId: string,
    input: GetDocumentInput,
  ): Promise<CapabilityResult<GetDocumentDataV1>> {
    const campaign = await this.sessions.getSession(ctx, sessionId);
    assertScopeAllowed(campaign.spec, input.scope);
    assertClientContextAllowed(campaign.spec, input.clientId);
    return this.execute<GetDocumentDataV1>(
      'get_document',
      this.capabilityContext(ctx, sessionId, input.clientId),
      input,
    );
  }

  async recommendStrategy(
    ctx: TenantContext,
    sessionId: string,
  ): Promise<CapabilityResult<RecommendOutreachStrategyDataV1>> {
    const campaign = await this.sessions.getSession(ctx, sessionId);
    const input = strategyInput(campaign.spec);
    return this.execute<RecommendOutreachStrategyDataV1>(
      'recommend_outreach_strategy',
      this.capabilityContext(ctx, sessionId, singleSponsorClient(campaign.spec)),
      input,
    );
  }

  async review(ctx: TenantContext, sessionId: string) {
    const campaign = await this.sessions.getSession(ctx, sessionId);
    const accepted = allAcceptedContextRefs(campaign.spec);
    const snapshotRevalidation: ContextSnapshotRevalidationV1[] = [];
    for (const selected of accepted) {
      try {
        const current = await this.contexts.resolveOne(ctx, {
          locator: selected.locator,
          contextClass: selected.contextClass,
          scope: selected.scope,
        });
        snapshotRevalidation.push({
          contextKey: selected.contextKey,
          ...compareSnapshots(selected, current),
          currentContext: current,
        });
      } catch {
        snapshotRevalidation.push({
          contextKey: selected.contextKey,
          status: 'unavailable',
          selectedSnapshotHash: selected.snapshotHash,
          currentSnapshotHash: null,
          changedFields: [],
          currentContext: null,
        });
      }
    }
    return {
      sessionId,
      stateVersion: campaign.currentStateVersion,
      specHash: campaign.specHash,
      summary: {
        requiredPolicyCount: campaign.spec.context.requiredPolicyRefs.length,
        writingGuidanceCount: campaign.spec.context.writingGuidanceRefs.length,
        campaignFactCount: campaign.spec.context.campaignFactRefs.length,
        targetSpecificCount: campaign.spec.context.targetSpecificRefs.length,
        groupSafeCount: campaign.spec.context.groupSafeRefs.length,
        excludedCount: campaign.spec.context.excludedRefs.length,
        unverifiedEvidenceCount: accepted.filter(
          (entry) => entry.contextClass !== 'writing_guidance' && !entry.usableAsEvidence,
        ).length,
      },
      accepted: campaign.spec.context,
      snapshotRevalidation: snapshotRevalidation.sort((a, b) => compare(a.contextKey, b.contextKey)),
      readiness: campaign.readiness,
    };
  }

  private async execute<T>(
    name: string,
    context: AuthorizedCapabilityContext,
    input: unknown,
  ): Promise<CapabilityResult<T>> {
    try {
      return await this.capabilities.execute<T>(name, context, input);
    } catch (error) {
      if (error instanceof CapabilityError) throw mapCapabilityError(error);
      throw error;
    }
  }

  private capabilityContext(
    ctx: TenantContext,
    sessionId: string,
    clientId: string | null,
  ): AuthorizedCapabilityContext {
    return {
      actorUserId: ctx.userId,
      clerkUserId: ctx.clerkUserId,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      role: ctx.role,
      clientScope: clientId ? { clientId, reason: 'campaign' } : null,
      impersonation: null,
      requestId: `outreach-v3-context:${sessionId}`,
      surface: 'outreach',
    };
  }
}

function assertScopeAllowed(spec: OutreachCampaignSpecV1, scope: OutreachContextScopeV1): void {
  if (scope.kind !== 'target') return;
  if (!spec.targeting.selectedTargetRefs.some((target) => target.targetKey === scope.targetKey)) {
    throw new OutreachCommandError(
      'OUTREACH_CONTEXT_INVALID_SCOPE',
      'Target-scoped context must reference a selected campaign target.',
      422,
    );
  }
}

function assertClientContextAllowed(spec: OutreachCampaignSpecV1, clientId: string | null): void {
  if (!clientId) return;
  if (singleSponsorClient(spec) !== clientId) {
    // Same non-leaking result for wrong sponsor, wrong client, or unavailable client.
    throw new OutreachCommandError(
      'OUTREACH_CONTEXT_NOT_FOUND',
      'The requested context was not found in the authorized campaign scope.',
      404,
    );
  }
}

function strategyInput(spec: OutreachCampaignSpecV1): RecommendOutreachStrategyInput {
  const coverage = deriveOutreachTargetCoverage(
    spec.targeting.criteria,
    spec.targeting.selectedTargetRefs,
  );
  return {
    goal: {
      goalPresent: Boolean(spec.goal.goal),
      objectivePresent: Boolean(spec.goal.objective),
      askMode: spec.goal.ask.mode,
      whyNowPresent: Boolean(spec.goal.whyNow),
    },
    targeting: {
      selectedCount: coverage.selectedCount,
      sendReadyCount: coverage.sendReadyCount,
      staffCount: coverage.staffCount,
      principalCount: coverage.principalCount,
      relationshipPreference: spec.targeting.criteria?.relationshipPreference ?? 'any',
    },
    context: {
      requiredPolicyCount: spec.context.requiredPolicyRefs.length,
      writingGuidanceCount: spec.context.writingGuidanceRefs.length,
      campaignFactCount: spec.context.campaignFactRefs.length,
      targetSpecificCount: spec.context.targetSpecificRefs.length,
      groupSafeCount: spec.context.groupSafeRefs.length,
    },
    currentDelivery: spec.delivery,
  };
}

function singleSponsorClient(spec: OutreachCampaignSpecV1): string | null {
  return spec.sponsor.kind === 'client' && spec.sponsor.clientRefs.length === 1
    ? spec.sponsor.clientRefs[0]?.clientId ?? null
    : null;
}

function compareSnapshots(
  selected: OutreachResolvedContextRefV1,
  current: OutreachResolvedContextRefV1,
): {
  status: 'current' | 'changed';
  selectedSnapshotHash: string;
  currentSnapshotHash: string;
  changedFields: string[];
} {
  if (selected.snapshotHash === current.snapshotHash) {
    return {
      status: 'current',
      selectedSnapshotHash: selected.snapshotHash,
      currentSnapshotHash: current.snapshotHash,
      changedFields: [],
    };
  }
  const changedFields = [
    ['title', selected.title, current.title],
    ['summary', selected.summary, current.summary],
    ['verificationClass', selected.verificationClass, current.verificationClass],
    ['sensitivity', selected.sensitivity, current.sensitivity],
    ['instructionsAllowed', selected.instructionsAllowed, current.instructionsAllowed],
    ['usableAsEvidence', selected.usableAsEvidence, current.usableAsEvidence],
    ['usableAsWritingGuidance', selected.usableAsWritingGuidance, current.usableAsWritingGuidance],
    ['sourceVersion', selected.sourceSnapshot.version, current.sourceSnapshot.version],
  ]
    .filter(([, before, after]) => before !== after)
    .map(([field]) => field as string)
    .sort(compare);
  return {
    status: 'changed',
    selectedSnapshotHash: selected.snapshotHash,
    currentSnapshotHash: current.snapshotHash,
    changedFields,
  };
}

function mapCapabilityError(error: CapabilityError): OutreachCommandError {
  if (
    error.code === 'CAPABILITY_NOT_FOUND' ||
    error.code === 'CAPABILITY_UNAUTHORIZED' ||
    error.code === 'CAPABILITY_ETHICAL_WALL' ||
    error.code === 'CAPABILITY_INVALID_SCOPE'
  ) {
    return new OutreachCommandError(
      'OUTREACH_CONTEXT_NOT_FOUND',
      'The requested context was not found in the authorized campaign scope.',
      404,
    );
  }
  if (error.code === 'CAPABILITY_TIMEOUT' || error.code === 'CAPABILITY_UNAVAILABLE') {
    return new OutreachCommandError(
      'OUTREACH_CONTEXT_UNAVAILABLE',
      'Context intelligence is temporarily unavailable.',
      503,
    );
  }
  return new OutreachCommandError(
    'OUTREACH_COMMAND_INVALID',
    'The context request is invalid.',
    400,
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
