import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CapabilityRegistry } from '../../capabilities/capability-registry.js';
import type { AuthorizedCapabilityContext } from '../../capabilities/capability-context.js';
import { OUTREACH_COMMAND_REGISTRY } from '../commands/outreach-command-registry.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import type { OutreachCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import {
  OutreachReasoningError,
  type ReasoningCampaignContext,
} from './outreach-reasoning.contract.js';
import {
  isOutreachReasoningReadTool,
  OUTREACH_REASONING_READ_TOOL_NAMES,
  OUTREACH_REASONING_READ_TOOLS,
} from './outreach-reasoning-tools.js';

const IMPLEMENTED_COMMANDS = OUTREACH_COMMAND_REGISTRY.filter(
  (entry) => entry.status === 'implemented',
).map((entry) => ({
  type: entry.type,
  schemaVersion: entry.schemaVersion,
  phaseOwner: entry.phaseOwner,
}));

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
      clientScope: singleClient
        ? { clientId: singleClient, reason: 'campaign' }
        : null,
      impersonation: null,
      requestId: `outreach-reasoning:${sessionId}`,
      surface: 'outreach',
    };
  }

  providerTools() {
    const registered = new Set(
      this.capabilities.listForSurface('outreach').map((definition) => definition.name),
    );
    return OUTREACH_REASONING_READ_TOOLS.filter((tool) => registered.has(tool.name));
  }

  async executeReadTool(
    capabilityCtx: AuthorizedCapabilityContext,
    name: string,
    input: unknown,
  ): Promise<{ resultId: string; output: unknown }> {
    if (!isOutreachReasoningReadTool(name)) {
      throw new OutreachReasoningError(
        'OUTREACH_REASONING_TOOL_NOT_ALLOWED',
        'The reasoning provider requested a capability that is not allowed.',
        502,
      );
    }

    const definition = this.capabilities.get(name);
    if (!definition || !definition.surfaces.includes('outreach')) {
      throw new OutreachReasoningError(
        'OUTREACH_REASONING_TOOL_NOT_ALLOWED',
        'The requested Capiro read capability is not implemented for Outreach.',
        502,
      );
    }

    try {
      const output = await this.capabilities.execute(name, capabilityCtx, input);
      const encoded = JSON.stringify(output);
      const resultId = `cap_${createHash('sha256').update(encoded, 'utf8').digest('hex').slice(0, 32)}`;
      return { resultId, output };
    } catch {
      // Capability errors intentionally collapse here. The model receives no
      // inaccessible record identity or ethical-wall details through exceptions.
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
    return [
      'You are Capiro Outreach reasoning for a government-affairs professional.',
      'Campaign Spec and its current state version are authoritative. The conversation is not campaign state.',
      'You may inspect authorized Capiro read tools. Never claim a tool result you did not receive.',
      'You may propose only the implemented command types supplied below. Proposals are suggestions and are not applied automatically.',
      'Never ask for or claim send authority, generation authority, approval authority, tenant authority, or hidden system access.',
      'Do not invent clients, targets, contacts, government facts, or memory. If a required later-phase capability is unavailable, say so.',
      'Do not reveal or summarize hidden chain-of-thought. Return only the visible answer, structured command proposals, and concise clarifying questions.',
      'When information is ambiguous, prefer a clarifying question over guessing campaign state.',
      `Authenticated role: ${ctx.role}.`,
      `Current Campaign Spec state version: ${campaign.currentStateVersion}.`,
      `Current Campaign Spec hash: ${campaign.specHash}.`,
      `Current Campaign Spec: ${JSON.stringify(campaign.spec)}.`,
      `Current readiness/blockers: ${JSON.stringify(campaign.readiness)}.`,
      `Implemented proposal command catalog: ${JSON.stringify(IMPLEMENTED_COMMANDS)}.`,
      `Executable read capabilities: ${JSON.stringify(OUTREACH_REASONING_READ_TOOL_NAMES)}.`,
      'Final output must match the requested structured response. Command objects must use schemaVersion=1 and exact Phase 2 command names.',
    ].join('\n');
  }
}
