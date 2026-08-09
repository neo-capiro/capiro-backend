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

const TARGET_INTELLIGENCE_TOOLS = new Set([
  'search_targets',
  'get_target_profile',
  'analyze_relationships',
  'analyze_target_coverage',
  'find_similar_targets',
]);
const CONTEXT_INTELLIGENCE_TOOLS = new Set([
  'search_memory',
  'research_government',
  'get_document',
  'recommend_outreach_strategy',
]);
const DISCOVERY_TOOLS = new Set([
  ...TARGET_INTELLIGENCE_TOOLS,
  ...CONTEXT_INTELLIGENCE_TOOLS,
]);
const STRICT_SPONSOR_CLIENT_TOOLS = new Set(['get_client_context', 'get_recent_activity']);
const CLIENT_SCOPED_CONTEXT_TOOLS = new Set(['search_memory', 'get_document']);

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
    const singleClient = singleSponsorClient(spec);
    return {
      actorUserId: ctx.userId,
      clerkUserId: ctx.clerkUserId,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      role: ctx.role,
      clientScope: singleClient ? { clientId: singleClient, reason: 'campaign' } : null,
      impersonation: null,
      requestId: `outreach-reasoning:${sessionId}`,
      surface: 'outreach',
    };
  }

  providerTools(campaign: ReasoningCampaignContext) {
    const registered = new Set(
      this.capabilities.listForSurface('outreach').map((definition) => definition.name),
    );
    const sponsorClients = campaignClientIds(campaign);
    return OUTREACH_REASONING_READ_TOOLS.filter((tool) => {
      if (!registered.has(tool.name)) return false;
      if (sponsorClients.size > 0) return true;
      return DISCOVERY_TOOLS.has(tool.name);
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

    const sponsorClientIds = campaignClientIds(campaign);
    const preparedInput = prepareToolInput(name, input, campaign);
    assertRequestedScopeWithinCampaign(name, preparedInput, campaign, sponsorClientIds);

    try {
      const output = await this.capabilities.execute(name, capabilityCtx, preparedInput);
      assertResultScopeWithinCampaign(name, output, sponsorClientIds);
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
      'Target search results are recommendations, never selected targets. Use ADD_TARGET_REFS only with exact locators returned by search_targets, get_target_profile, or find_similar_targets.',
      'Context search results are candidates, never accepted context. Use ACCEPT_CONTEXT_REFS only with exact selections returned by search_memory, research_government, or get_document.',
      'A target or context candidate is never applied automatically. Proposed commands remain pending until the user explicitly applies the proposal.',
      'Writing guidance controls style and instructions; it is not evidence and must never be cited as proof of a fact.',
      'Target-specific context may be used only for its exact selected target. Never promote target-specific facts to group-safe context.',
      'Client-confidential context is allowed only for the campaign’s sole explicit sponsor client. Multi-client campaigns may use client-neutral shared context only until per-client generation packets exist.',
      'Coverage and strategy analyses are advisory. Their recommendations never become mandatory state changes.',
      'Sponsor scope and target audience are separate. An authorized target discovery result does not make a client campaign context or imply representation.',
      'Do not expose private note bodies, private meeting-note bodies, private email bodies, raw document bytes, storage credentials, sensitive attributes, or hidden provider errors.',
      'You may propose only the implemented command types supplied below. Proposals are suggestions and are not applied automatically.',
      'Never ask for or claim generation, draft, approval, preflight, send, tenant, or hidden-system authority.',
      'Do not invent clients, targets, contacts, government facts, relationships, documents, or memory. If a required later-phase capability is unavailable, say so.',
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

function singleSponsorClient(spec: OutreachCampaignSpecV1): string | null {
  return spec.sponsor.kind === 'client' && spec.sponsor.clientRefs.length === 1
    ? spec.sponsor.clientRefs[0]?.clientId ?? null
    : null;
}

function prepareToolInput(
  name: string,
  input: unknown,
  campaign: ReasoningCampaignContext,
): unknown {
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

  if (name === 'search_targets') {
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

  if (name === 'analyze_target_coverage') {
    return {
      criteria: {
        chambers: criteria.chambers,
        committees: criteria.committees,
        states: criteria.states,
        relationshipPreference: criteria.relationshipPreference,
        includeStaff: criteria.includeStaff,
        includePrincipals: criteria.includePrincipals,
      },
      targetRefs: spec.targeting.selectedTargetRefs.map((target) => target.locator),
    };
  }

  if (name === 'recommend_outreach_strategy') {
    return strategyInput(spec);
  }

  return input;
}

function strategyInput(spec: OutreachCampaignSpecV1) {
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

function assertRequestedScopeWithinCampaign(
  name: string,
  input: unknown,
  campaign: ReasoningCampaignContext,
  sponsorClientIds: Set<string>,
): void {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (STRICT_SPONSOR_CLIENT_TOOLS.has(name)) {
    const clientId = typeof raw.clientId === 'string' ? raw.clientId : null;
    if (!clientId || !sponsorClientIds.has(clientId)) throw toolNotAllowed();
  }
  if (CLIENT_SCOPED_CONTEXT_TOOLS.has(name)) {
    const clientId = typeof raw.clientId === 'string' ? raw.clientId : null;
    if (clientId && (!singleSponsorClient(campaign.spec as OutreachCampaignSpecV1) || !sponsorClientIds.has(clientId))) {
      throw toolNotAllowed();
    }
  }
  if (name === 'get_capiro_record' && raw.recordType === 'client') {
    const recordId = typeof raw.recordId === 'string' ? raw.recordId : null;
    if (!recordId || !sponsorClientIds.has(recordId)) throw toolNotAllowed();
  }
  const scope = raw.scope;
  if (scope && typeof scope === 'object') {
    const scopeValue = scope as Record<string, unknown>;
    if (scopeValue.kind === 'target') {
      const targetKey = typeof scopeValue.targetKey === 'string' ? scopeValue.targetKey : null;
      const spec = campaign.spec as OutreachCampaignSpecV1;
      if (!targetKey || !spec.targeting.selectedTargetRefs.some((target) => target.targetKey === targetKey)) {
        throw toolNotAllowed();
      }
    }
  }
}

function assertResultScopeWithinCampaign(
  name: string,
  output: unknown,
  sponsorClientIds: Set<string>,
): void {
  if (DISCOVERY_TOOLS.has(name)) return;
  const scopedClientId = capabilityResultClientId(output);
  if (STRICT_SPONSOR_CLIENT_TOOLS.has(name) || name === 'get_capiro_record') {
    if (!scopedClientId || !sponsorClientIds.has(scopedClientId)) throw toolNotAllowed();
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
