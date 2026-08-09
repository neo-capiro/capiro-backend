import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CapabilityRegistry } from '../../capabilities/capability-registry.js';
import { CapabilityError } from '../../capabilities/capability-errors.js';
import type { AuthorizedCapabilityContext } from '../../capabilities/capability-context.js';
import type {
  SearchTargetsData,
  SearchTargetsInput,
} from '../../capabilities/targets/search-targets.capability.js';
import type {
  GetTargetProfileInput,
  TargetProfileDataV1,
} from '../../capabilities/targets/get-target-profile.capability.js';
import type {
  AnalyzeRelationshipsDataV1,
  AnalyzeRelationshipsInput,
} from '../../capabilities/targets/analyze-relationships.capability.js';
import { OutreachTargetReferenceService } from '../../capabilities/targets/outreach-target-reference.service.js';
import type {
  OutreachResolvedTargetRefV1,
  OutreachTargetLocatorV1,
} from '../../capabilities/targets/outreach-target.contract.js';
import type { CapabilityResult } from '../../capabilities/capability-result.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import type { TargetCriteriaV1 } from '../state/outreach-campaign-spec.v1.js';
import { OutreachTargetCoverageService } from './outreach-target-coverage.service.js';

export type TargetSnapshotStatus = 'unselected' | 'current' | 'changed' | 'unavailable';

export interface TargetSnapshotRevalidationV1 {
  targetKey: string;
  status: Exclude<TargetSnapshotStatus, 'unselected'>;
  selectedSnapshotHash: string;
  currentSnapshotHash: string | null;
  changedFields: string[];
  currentTarget: OutreachResolvedTargetRefV1 | null;
}

@Injectable()
export class OutreachV3TargetsService {
  constructor(
    private readonly sessions: OutreachSessionService,
    private readonly capabilities: CapabilityRegistry,
    private readonly targetReferences: OutreachTargetReferenceService,
    private readonly coverage: OutreachTargetCoverageService,
  ) {}

  async search(
    ctx: TenantContext,
    sessionId: string,
    input: Omit<SearchTargetsInput, 'criteria' | 'excludeTargetKeys' | 'rejectedRecommendationRefs'>,
  ): Promise<CapabilityResult<SearchTargetsData>> {
    const campaign = await this.sessions.getSession(ctx, sessionId);
    return this.execute<SearchTargetsData>(
      'search_targets',
      this.capabilityContext(ctx, sessionId, input.clientId ?? null),
      {
        ...input,
        criteria: toSearchCriteria(campaign.spec.targeting.criteria),
        excludeTargetKeys: campaign.spec.targeting.selectedTargetRefs.map((target) => target.targetKey),
        rejectedRecommendationRefs: campaign.spec.targeting.rejectedRecommendationRefs.map(
          (entry) => entry.recommendationRef,
        ),
      },
    );
  }

  async getProfile(ctx: TenantContext, sessionId: string, input: GetTargetProfileInput) {
    const campaign = await this.sessions.getSession(ctx, sessionId);
    const selected = campaign.spec.targeting.selectedTargetRefs.find((target) =>
      sameLocator(target.locator, input.targetRef),
    );
    const clientId = selected?.clientId ?? clientIdFromLocator(input.targetRef);
    const result = await this.execute<TargetProfileDataV1>(
      'get_target_profile',
      this.capabilityContext(ctx, sessionId, clientId),
      input,
    );
    return {
      ...result,
      selectionSnapshot: selected
        ? compareSnapshots(selected, result.data.target)
        : {
            status: 'unselected' as const,
            selectedSnapshotHash: null,
            currentSnapshotHash: result.data.target.snapshotHash,
            changedFields: [],
          },
    };
  }

  async analyzeRelationships(
    ctx: TenantContext,
    sessionId: string,
    input: AnalyzeRelationshipsInput,
  ): Promise<CapabilityResult<AnalyzeRelationshipsDataV1>> {
    await this.sessions.getSession(ctx, sessionId);
    return this.execute<AnalyzeRelationshipsDataV1>(
      'analyze_relationships',
      this.capabilityContext(ctx, sessionId, input.clientId),
      input,
    );
  }

  async getCoverage(ctx: TenantContext, sessionId: string) {
    const campaign = await this.sessions.getSession(ctx, sessionId);
    const revalidation: TargetSnapshotRevalidationV1[] = [];
    for (const selected of campaign.spec.targeting.selectedTargetRefs) {
      try {
        const current = await this.targetReferences.resolveOne(ctx, selected.locator);
        revalidation.push({
          targetKey: selected.targetKey,
          ...compareSnapshots(selected, current),
          currentTarget: current,
        });
      } catch {
        revalidation.push({
          targetKey: selected.targetKey,
          status: 'unavailable',
          selectedSnapshotHash: selected.snapshotHash,
          currentSnapshotHash: null,
          changedFields: [],
          currentTarget: null,
        });
      }
    }
    return {
      sessionId,
      stateVersion: campaign.currentStateVersion,
      specHash: campaign.specHash,
      coverage: this.coverage.analyze(campaign.spec),
      snapshotRevalidation: revalidation.sort((a, b) => compare(a.targetKey, b.targetKey)),
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
      requestId: `outreach-v3-targets:${sessionId}`,
      surface: 'outreach',
    };
  }
}

function toSearchCriteria(criteria: TargetCriteriaV1 | null): SearchTargetsInput['criteria'] {
  return criteria
    ? {
        governmentLevels: criteria.governmentLevels,
        chambers: criteria.chambers,
        committees: criteria.committees,
        agencies: criteria.agencies,
        states: criteria.states,
        relationshipPreference: criteria.relationshipPreference,
        includeStaff: criteria.includeStaff,
        includePrincipals: criteria.includePrincipals,
      }
    : {
        governmentLevels: [],
        chambers: [],
        committees: [],
        agencies: [],
        states: [],
        relationshipPreference: 'any',
        includeStaff: true,
        includePrincipals: true,
      };
}

function clientIdFromLocator(locator: GetTargetProfileInput['targetRef']): string | null {
  if (locator.source === 'client_person') return locator.clientId;
  if (locator.source === 'engagement_contact') return locator.clientId;
  return null;
}

function sameLocator(a: OutreachTargetLocatorV1, b: OutreachTargetLocatorV1): boolean {
  return a.source === b.source && a.id === b.id;
}

function compareSnapshots(
  selected: OutreachResolvedTargetRefV1,
  current: OutreachResolvedTargetRefV1,
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
    ['displayName', selected.displayName, current.displayName],
    ['email', selected.email, current.email],
    ['phone', selected.phone, current.phone],
    ['title', selected.title, current.title],
    ['organization', selected.organization, current.organization],
    ['roleStatus', selected.roleStatus, current.roleStatus],
    ['profileStatus', selected.profileStatus, current.profileStatus],
    ['jurisdiction', JSON.stringify(selected.jurisdiction), JSON.stringify(current.jurisdiction)],
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

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function mapCapabilityError(error: CapabilityError): OutreachCommandError {
  if (
    error.code === 'CAPABILITY_NOT_FOUND' ||
    error.code === 'CAPABILITY_UNAUTHORIZED' ||
    error.code === 'CAPABILITY_ETHICAL_WALL' ||
    error.code === 'CAPABILITY_INVALID_SCOPE'
  ) {
    return new OutreachCommandError(
      'OUTREACH_TARGET_NOT_FOUND',
      'The requested target was not found in the authorized campaign scope.',
      404,
    );
  }
  if (error.code === 'CAPABILITY_TIMEOUT' || error.code === 'CAPABILITY_UNAVAILABLE') {
    return new OutreachCommandError(
      'OUTREACH_TARGET_UNAVAILABLE',
      'Target intelligence is temporarily unavailable.',
      503,
    );
  }
  return new OutreachCommandError(
    'OUTREACH_COMMAND_INVALID',
    'The target intelligence request is invalid.',
    400,
  );
}
