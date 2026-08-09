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

  providerTools(campaign: ReasoningCampaignContext) {
    // The only Phase 3 executable capabilities are currently client-scoped.
    // A no-client campaign therefore receives no tenant-wide client tool surface.
    // Multi-client/coalition campaigns may use only their explicit sponsor refs.
    if (campaignClientIds(campaign).size === 0) return [];
    const registered = new Set(
      this.capabilities.listForSurface('outreach').map((definition) => definition.name),
    );
    return OUTREACH_REASONING_READ_TOOLS.filter((tool) => registered.has(tool.name));
  }

  async executeReadTool(
    capabilityCtx: AuthorizedCapabilityContext,
    campaign: ReasoningCampaignContext,
    name: string,
    input: unknown,
  ): Promise<{ resultId: string; output: unknown }> {
    if (!isOutreachReasoningReadTool(name)) {
      throw toolNotAllowed();
    }

    const definition = this.capabilities.get(name);
    if (!definition || !definition.surfaces.includes('outreach')) {
      throw toolNotAllowed();
    }

    const allowedClientIds = campaignClientIds(campaign);
    if (allowedClientIds.size === 0) throw toolNotAllowed();
    assertRequestedClientWithinCampaign(name, input, allowedClientIds);

    try {
      const output = await this.capabilities.execute(name, capabilityCtx, input);
      const scopedClientId = capabilityResultClientId(output);
      if (!scopedClientId || !allowedClientIds.has(scopedClientId)) {
        // Meeting/task records can only reveal their client after the shared
        // capability has safely read + reauthorized the record. Enforce campaign
        // sponsor scope again on the result before any bytes reach the model.
        throw toolNotAllowed();
      }
      const encoded = JSON.stringify(output);
      const resultId = `cap_${createHash('sha256').update(encoded, 'utf8').digest('hex').slice(0, 32)}`;
      return { resultId, output };
    } catch (error) {
      if (error instanceof OutreachReasoningError) throw error;
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
    const executableReadCapabilities = this.providerTools(campaign).map((tool) => tool.name);
    return [
      'You are Capiro Outreach reasoning for a government-affairs professional.',
      'Campaign Spec and its current state version are authoritative. The conversation is not campaign state.',
      'You may inspect only the authorized Capiro read tools supplied with this request. Never claim a tool result you did not receive.',
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
      `Executable read capabilities for this campaign: ${JSON.stringify(executableReadCapabilities)}.`,
      'Final output must match the requested structured response. Command objects must use schemaVersion=1 and exact Phase 2 command names.',
    ].join('\n');
  }
}

function campaignClientIds(campaign: ReasoningCampaignContext): Set<string> {
  const spec = campaign.spec as OutreachCampaignSpecV1;
  return new Set(spec.sponsor.clientRefs.map((ref) => ref.clientId));
}

function assertRequestedClientWithinCampaign(
  name: string,
  input: unknown,
  allowedClientIds: Set<string>,
): void {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (name === 'get_client_context' || name === 'get_recent_activity') {
    const clientId = typeof raw.clientId === 'string' ? raw.clientId : null;
    if (!clientId || !allowedClientIds.has(clientId)) throw toolNotAllowed();
  }
  if (name === 'get_capiro_record' && raw.recordType === 'client') {
    const recordId = typeof raw.recordId === 'string' ? raw.recordId : null;
    if (!recordId || !allowedClientIds.has(recordId)) throw toolNotAllowed();
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
