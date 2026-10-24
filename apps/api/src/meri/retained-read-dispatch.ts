import { ForbiddenException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { GovernedMemoryCandidateService } from '../memory/governed-memory-candidate.service.js';
import { assertDelegatedToolSelectors, schemaClientSelectors } from '../auth/read-delegation/read-delegation.contract.js';
import type { MeriToolsService } from './meri-tools.service.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import type { RetainedReadContext } from './retained-read-context.js';
import { assertRetainedSourceV02Admission, RETAINED_SOURCE_V02_OPERATIONS } from './retained-source-v02/admission.js';
import { readRetainedSourceV02 } from './retained-source-v02/receiver.js';
import { readPassiveMemoryPage } from './memory-receiving/meri-memory-page-source.js';
import { checkPassiveMemoryEligibility, parsePassiveMemoryEligibilityRequest } from './memory-receiving/meri-passive-memory-source.js';
import type { ObjectiveJobReadSources } from './objective-job-read-sources.js';
import { isResearchPortfolioProposalTool } from './meri-rp-proposal-binding.js';
import { receiveMemoryProposalPage, MEMORY_PROPOSAL_OPERATION } from './memory-receiving/meri-memory-proposal-receiver.js';
import { ACTION_QUERY_OWNER, ACTION_QUERY_OPERATION, admitActionQueryAlias, assertActionQueryAliasResult } from './meri-action-query-alias.js';
import { parseMeriReadObservation, withMeriReadObservation } from './meri-funding-read-observation.js';

const refused = () => new ForbiddenException('Saved job read refused');

/** Typed dispatch shared by saved-job owners. The caller establishes current
 * principal, consent, exact run/context and deadline, and rechecks on release. */
export class RetainedReadDispatcher {
  constructor(private readonly prisma: PrismaService, private readonly tools: MeriToolsService,
    private readonly memory: GovernedMemoryCandidateService, private readonly sources: ObjectiveJobReadSources) {}

  async execute(ctx: TenantContext, operation: string, input: any,
    context: RetainedReadContext, deadlineMs: number, req: Request): Promise<unknown> {
    const clientId = context.subject.kind === 'client' ? context.subject.entityIds[0]! : null;
    if (this.sources.handles(operation)) return this.sources.read(ctx, clientId, operation, input);
    if (operation === 'search_memory_eligibility') {
      const page = parsePassiveMemoryEligibilityRequest(input, ctx, Date.now());
      if (!isDeepStrictEqual(page.binding, context.binding) || !isDeepStrictEqual(page.subject, context.subject) ||
          page.policyRevision !== context.policyRevision ||
          !isDeepStrictEqual(page.normalizationContext, context.normalizationContext) || page.deadlineMs > deadlineMs) throw refused();
      return checkPassiveMemoryEligibility(this.prisma, ctx, page);
    }
    if (operation === MEMORY_PROPOSAL_OPERATION.id) return receiveMemoryProposalPage({
      ctx, raw: input, correlation: context, verifiedServiceIdentity: true,
      deadlineMs, prisma: this.prisma, owner: this.memory,
    });
    if (operation === 'search_memory') {
      assertMeriToolAllowed(operation);
      return readPassiveMemoryPage(ctx, input, context, true, deadlineMs, this.tools);
    }
    if (RETAINED_SOURCE_V02_OPERATIONS.has(operation)) return readRetainedSourceV02(
      assertRetainedSourceV02Admission(ctx, operation, input, context,
        { verifiedServiceIdentity: true, nowMs: Date.now(), deadlineMs }), ctx, this.tools);
    if (operation === ACTION_QUERY_OPERATION.id) {
      const admitted = admitActionQueryAlias(ctx, input, true, context, deadlineMs, Date.now());
      assertMeriToolAllowed(ACTION_QUERY_OWNER);
      if (this.tools.isSideEffecting(ACTION_QUERY_OWNER)) throw refused();
      const result = await this.tools.executeFromAuthenticatedUser(ctx, ACTION_QUERY_OWNER, admitted.ownerBody);
      assertActionQueryAliasResult(result, admitted.clientId);
      return result;
    }
    assertMeriToolAllowed(operation);
    const schema = this.tools.anthropicToolSchemas({ tenantId: ctx.tenantId, surface: 'chat' }).find(t => t.name === operation);
    // Saved jobs never manufacture interactive attachment or proposal grants.
    if (!schema || this.tools.isSideEffecting(operation) || operation === 'read_chat_attachments' ||
        isResearchPortfolioProposalTool(operation)) throw refused();
    if (clientId !== null) assertDelegatedToolSelectors(input, { clientId,
      conversationId: context.binding.conversationId }, schemaClientSelectors(schema.input_schema));
    const observation = parseMeriReadObservation(operation, input, req.headers['x-meri-read-observation']);
    const execute = () => this.tools.executeFromAuthenticatedUser(ctx, operation, input);
    return observation ? withMeriReadObservation(observation, execute) : execute();
  }
}
