import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CapabilityRegistry } from '../../capabilities/capability-registry.js';
import type { AuthorizedCapabilityContext } from '../../capabilities/capability-context.js';
import { OUTREACH_COMMAND_REGISTRY } from '../commands/outreach-command-registry.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import type { OutreachCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { deriveOutreachTargetCoverage } from '../targets/outreach-target-coverage.service.js';
import {
  OutreachReasoningError,
  type ReasoningCampaignContext,
} from './outreach-reasoning.contract.js';
import {
  isOutreachReasoningReadTool,
  OUTREACH_REASONING_READ_TOOLS,
} from './outreach-reasoning-tools.js';

const IMPLEMENTED_COMMANDS = OUTREACH_COMMAND_REGISTRY.filter(
  (entry) => entry.status === 'implemented',
).map((entry) => ({
  type: entry.type,
  schemaVersion: entry.schemaVersion,
  phaseOwner: entry.phaseOwner,
}));

const PUBLIC_TARGET_TOOLS = new Set(['search_targets', 'get_target_profile']);
const STRICT_CLIENT_TOOLS = new Set([
  'get_client_context',
  'get_recent_activity',
  'analyze_relationships',
]);

@Injectable()
export class OutreachReasoningContextService {
  constructor(
    private readonly sessions: OutreachSessionService,
    private readonly capabilities: CapabilityRegistry,
  ) {}

  async loadCampaignContext(
    ctx: TenantContext,
    sessionId: string,
  ): Promise<ReasoningCampaignContext> {
    const current = await this.sessions.getSession(ctx, sessionId);
    return {
      sessionId,
      currentStateVersion: current.currentStateVersion,
      specHash: current.specHash,
      spec: current.spec,
      readiness: current.readiness,
      targetCoverage: deriveOutreachTargetCoverage(
        current.spec.targeting.criteria,
        current.spec.targeting.selectedTargetRefs,
      ),
      pendingProposalCount: current.pendingProposalCount,
    };
  }

  capabilityContext(
    ctx: TenantContext,
    sessionId: string,
    campaign: ReasoningCampaignContext,
  ): AuthorizedCapabilityContext {
    const spec = campaign.spec as OutreachCampaignSpecV1;
    const singleClient =
      spec.sponsor.kind === 'client' && spec.sponsor.clientRefs.length === 1
        ? spec.sponsor.clientRefs[0]?.clientId ?? null
        : null;

    return {
      actorUserId: ctx.userId,
      clerkUserId: ctx.clerkUserId,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      role: ctx.role,
      clientScope: singleClient ? { clientId: singleClient, reason: 'campaign' } : null,
      impersonation: ctx.impersonationSessionId
        ? {
            sessionId: ctx.impersonationSessionId,
            actorUserId: ctx.impersonatedByUserId ?? ctx.userId,
            effectiveTenantId: ctx.tenantId,
          }
        : null,
      requestId: `outreach-reasoning:${sessionId}`,
      surface: 'outreach',
    };
  }

  providerTools(campaign: ReasoningCampaignContext) {
    const allowedClientIds = campaignClientIds(campaign);
    const registered = new Set(
      this.capabilities.listForSurface('outreach').map((definition) => definition.name),
    );
    return OUTREACH_REASONING_READ_TOOLS.filter((tool) => {
      if (!registered.has(tool.name)) return false;
      if (allowedClientIds.size > 0) return true;
      return PUBLIC_TARGET_TOOLS.has(tool.name);
    });
  }

  async executeReadTool(
    capabilityCtx: AuthorizedCapabilityContext,
    campaign: ReasoningCampaignContext,
    name: string,
    input: unknown,
  ): Promise<{ resultId: string; output: unknown }> {
    if (!isOutreachReasoningReadTool(name)) throw toolNotAllowed();
    if (!this.providerTools(campaign).some((tool) => tool.name === name)) throw toolNotAllowed();

    const definition = this.capabilities.get(name);
    if (!definition || !definition.surfaces.includes('outreach')) throw toolNotAllowed();

    const allowedClientIds = campaignClientIds(campaign);
    const preparedInput = prepareToolInput(name, input, campaign);
    assertRequestedScopeWithinCampaign(name, preparedInput, allowedClientIds);

    try {
      const output = await this.capabilities.execute(name, capabilityCtx, preparedInput);
      assertResultScopeWithinCampaign(name, output, allowedClientIds);
      const encoded = JSON.stringify(output);
      const resultId = `cap_${createHash('sha256').update(encoded, 'utf8').digest('hex').slice(0, 32)}`;
      return { resultId, output };
    } catch (error) {
      if (error instanceof OutreachReasoningError) throw error;
      throw new OutreachReasoningError(
        'OUTREACH_REASONING_TOOL_FAILED',
        'The requested Capiro read capability could not complete safely.',
        502,
        false,
        { capability: name },
      );
    }
  }

  buildInstructions(ctx: TenantContext, campaign: ReasoningCampaignContext): string {
    const executableReadCapabilities = this.providerTools(campaign).map((tool) => tool.name);
    return [
      'You are Capiro Outreach reasoning for a government-affairs professional.',
      'Campaign Spec and its current state version are authoritative. The conversation is not campaign state.',
      'You may inspect only the authorized Capiro read tools supplied with this request. Never claim a tool result you did not receive.',
      'Target search results are recommendations, never selected targets. Use ADD_TARGET_REFS only with exact locators returned by search_targets or get_target_profile.',
      'A target recommendation is never added automatically. Proposed target commands remain pending until the user explicitly applies the proposal.',
      'Target profiles identify safe facts and restrictions. Do not treat user notes, relationship note bodies, private meeting notes, or private email bodies as approved personalization context.',
      'You may propose only the implemented command types supplied below. Proposals are suggestions and are not applied automatically.',
      'Never ask for or claim send authority, generation authority, approval authority, tenant authority, or hidden system access.',
      'Do not invent clients, targets, contacts, government facts, relationships, or memory. If a required later-phase capability is unavailable, say so.',
      'Do not reveal or summarize hidden chain-of-thought. Return only the visible answer, structured command proposals, and concise clarifying questions.',
      'When information is ambiguous, prefer a clarifying question over guessing campaign state.',
      `Authenticated role: ${ctx.role}.`,
      `Current Campaign Spec state version: ${campaign.currentStateVersion}.`,
      `Current Campaign Spec hash: ${campaign.specHash}.`,
      `Current Campaign Spec: ${JSON.stringify(campaign.spec)}.`,
      `Current readiness/blockers: ${JSON.stringify(campaign.readiness)}.`,
      `Current deterministic target coverage: ${JSON.stringify(campaign.targetCoverage)}.`,
      `Implemented proposal command catalog: ${JSON.stringify(IMPLEMENTED_COMMANDS)}.`,
      `Executable read capabilities for this campaign: ${JSON.stringify(executableReadCapabilities)}.`,
      'Final output must match the requested structured response. Command objects must use schemaVersion=1 and exact command names.',
    ].join('\n');
  }
}

function campaignClientIds(campaign: ReasoningCampaignContext): Set<string> {
  const spec = campaign.spec as OutreachCampaignSpecV1;
  return new Set(spec.sponsor.clientRefs.map((ref) => ref.clientId));
}

function prepareToolInput(
  name: string,
  input: unknown,
  campaign: ReasoningCampaignContext,
): unknown {
  if (name !== 'search_targets') return input;
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const spec = campaign.spec as OutreachCampaignSpecV1;
  const criteria = spec.targeting.criteria ?? {
    notes: null,
    governmentLevels: [],
    chambers: [],
    committees: [],
    agencies: [],
    states: [],
    relationshipPreference: 'any' as const,
    includeStaff: true,
    includePrincipals: true,
  };
  return {
    query: typeof raw.query === 'string' ? raw.query : null,
    clientId: typeof raw.clientId === 'string' ? raw.clientId : null,
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    limit: typeof raw.limit === 'number' ? raw.limit : 20,
    criteria: {
      governmentLevels: criteria.governmentLevels,
      chambers: criteria.chambers,
      committees: criteria.committees,
      agencies: criteria.agencies,
      states: criteria.states,
      relationshipPreference: criteria.relationshipPreference,
      includeStaff: criteria.includeStaff,
      includePrincipals: criteria.includePrincipals,
    },
    excludeTargetKeys: spec.targeting.selectedTargetRefs.map((target) => target.targetKey),
    rejectedRecommendationRefs: spec.targeting.rejectedRecommendationRefs.map(
      (entry) => entry.recommendationRef,
    ),
  };
}

function assertRequestedScopeWithinCampaign(
  name: string,
  input: unknown,
  allowedClientIds: Set<string>,
): void {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (name === 'get_client_context' || name === 'get_recent_activity' || name === 'analyze_relationships') {
    const clientId = typeof raw.clientId === 'string' ? raw.clientId : null;
    if (!clientId || !allowedClientIds.has(clientId)) throw toolNotAllowed();
  }
  if (name === 'search_targets') {
    const clientId = typeof raw.clientId === 'string' ? raw.clientId : null;
    if (clientId && !allowedClientIds.has(clientId)) throw toolNotAllowed();
  }
  if (name === 'get_capiro_record' && raw.recordType === 'client') {
    const recordId = typeof raw.recordId === 'string' ? raw.recordId : null;
    if (!recordId || !allowedClientIds.has(recordId)) throw toolNotAllowed();
  }
  if (name === 'get_target_profile' || name === 'analyze_relationships') {
    const targetRef = raw.targetRef;
    if (targetRef && typeof targetRef === 'object') {
      const locator = targetRef as Record<string, unknown>;
      const clientId = typeof locator.clientId === 'string' ? locator.clientId : null;
      if (clientId && !allowedClientIds.has(clientId)) throw toolNotAllowed();
      if (!allowedClientIds.size && ['client_person', 'engagement_contact'].includes(String(locator.source))) {
        throw toolNotAllowed();
      }
    }
  }
}

function assertResultScopeWithinCampaign(
  name: string,
  output: unknown,
  allowedClientIds: Set<string>,
): void {
  const scopedClientId = capabilityResultClientId(output);
  if (PUBLIC_TARGET_TOOLS.has(name)) {
    if (scopedClientId && !allowedClientIds.has(scopedClientId)) throw toolNotAllowed();
    return;
  }
  if (STRICT_CLIENT_TOOLS.has(name) || name === 'get_capiro_record') {
    if (!scopedClientId || !allowedClientIds.has(scopedClientId)) throw toolNotAllowed();
  }
}

function capabilityResultClientId(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const scope = (output as { scope?: unknown }).scope;
  if (!scope || typeof scope !== 'object') return null;
  const clientId = (scope as { clientId?: unknown }).clientId;
  return typeof clientId === 'string' ? clientId : null;
}

function toolNotAllowed(): OutreachReasoningError {
  return new OutreachReasoningError(
    'OUTREACH_REASONING_TOOL_NOT_ALLOWED',
    'The reasoning provider requested a capability outside the current campaign scope.',
    502,
  );
}
