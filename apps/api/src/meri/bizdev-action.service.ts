import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { authorizeMeriProspectScope } from '../business-development/bizdev-meri-scope.authorization.js';
import {
  BizDevMeriScopeService,
  MeriProspectScopeConflictError,
  type MeriProspectScope,
} from '../business-development/bizdev-meri-scope.service.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { assertMeriToolRequestActive } from './meri-tool-request-control.js';
import { retainedReadSnapshot, readRetainedReadDeadline } from './retained-read-context.js';
import { hasVerifiedToolServiceIdentity } from './tool-service-secret.guard.js';
import {
  BIZDEV_BRIEF_ACTION,
  bizdevInput,
  bizdevRequest,
  bizdevRequestSchema,
  bizdevScopeSchema,
  bizdevSelectionSchema,
  type BizdevScope,
} from './bizdev-action.contract.js';

const selection = z
  .object({
    version: z.literal(1),
    context: bizdevSelectionSchema,
    request: bizdevRequestSchema,
  })
  .strict();
const observation = z
  .object({ version: z.literal(1), proposalId: z.string().uuid(), context: bizdevScopeSchema })
  .strict();
const decision = observation.extend({ decision: z.enum(['approved', 'rejected']) }).strict();
const refuse = () => new ForbiddenException('Business-development brief action access unavailable');
@Injectable()
export class BizdevActionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeService: BizDevMeriScopeService,
    private readonly proposals: MeriActionProposalService,
  ) {}
  /**
   * The current owner of this action: the persisted prospect scope of the
   * conversation the caller currently owns. An unscoped (General) or
   * unprovable conversation is refused — a null-client conversation is never
   * treated as canonical General here, and no caller-supplied scope is trusted.
   * Resolution is repeated before every proposal write, before the effect and
   * before a result is released.
   */
  private async access(
    ctx: TenantContext,
    req: Request,
    conversationId: string,
    expected?: BizdevScope,
  ) {
    if (
      !hasVerifiedToolServiceIdentity(req) ||
      req.headers['x-capiro-impersonate-tenant'] !== undefined
    )
      throw refuse();
    const deadline = readRetainedReadDeadline(req);
    const check = () => {
      assertMeriToolRequestActive();
      if (Date.now() >= deadline) throw refuse();
    };
    const thisPrisma = this.prisma,
      thisScope = this.scopeService;
    const current = async (): Promise<MeriProspectScope> => {
      const conversation = await thisPrisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioConversation.findFirst({
          where: {
            id: conversationId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            archivedAt: null,
          },
          select: { id: true, metadata: true },
        }),
      );
      if (!conversation) throw refuse();
      const scope = await authorizeMeriProspectScope(thisScope, ctx, conversation.metadata);
      if (!scope) throw refuse();
      return scope;
    };
    check();
    const resolved = await current();
    const scope: BizdevScope = {
      conversationId,
      prospectId: resolved.prospectId,
      prospectName: resolved.prospectName,
      canonicalOrganizationId: resolved.canonicalOrganizationId,
      linkedClientId: resolved.linkedClientId,
      scopeVersion: resolved.scopeVersion,
    };
    if (
      expected !== undefined &&
      (expected.conversationId !== scope.conversationId ||
        expected.prospectId !== scope.prospectId ||
        expected.scopeVersion !== scope.scopeVersion ||
        expected.canonicalOrganizationId !== scope.canonicalOrganizationId ||
        expected.linkedClientId !== scope.linkedClientId)
    )
      throw new MeriProspectScopeConflictError('changed');
    return {
      scope,
      async assertCurrent() {
        check();
        const fresh = await current();
        if (
          fresh.prospectId !== scope.prospectId ||
          fresh.scopeVersion !== scope.scopeVersion ||
          fresh.canonicalOrganizationId !== scope.canonicalOrganizationId ||
          fresh.linkedClientId !== scope.linkedClientId
        )
          throw new MeriProspectScopeConflictError('changed');
        check();
      },
    };
  }
  async prepare(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = selection.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Invalid business-development brief proposal');
    const { context, request } = parsed.data,
      admitted = bizdevRequest(request, context.conversationId);
    const access = await this.access(ctx, req, context.conversationId);
    const result = await this.proposals.create(
      ctx,
      {
        tool: BIZDEV_BRIEF_ACTION,
        input: bizdevInput(admitted),
        conversationId: context.conversationId,
        surface: 'chat',
        requireApproval: true,
      },
      undefined,
      undefined,
      access,
    );
    await access.assertCurrent();
    if (result.disposition !== 'pending_approval')
      throw new ForbiddenException('Business-development brief proposal is not approvable');
    return this.proposals.readBizdev(ctx, result.proposal.proposalId, access);
  }
  async read(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = observation.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Invalid business-development brief receipt selection');
    const { context, proposalId } = parsed.data,
      access = await this.access(ctx, req, context.conversationId, context);
    const result = await this.proposals.readBizdev(ctx, proposalId, access);
    await access.assertCurrent();
    return result;
  }
  async decide(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = decision.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Invalid business-development brief decision');
    const { context, proposalId, decision: choice } = parsed.data,
      access = await this.access(ctx, req, context.conversationId, context);
    if (choice === 'approved') await this.proposals.approveAndExecute(ctx, proposalId, undefined, access);
    else await this.proposals.dismiss(ctx, proposalId, undefined, access);
    const result = await this.proposals.readBizdev(ctx, proposalId, access);
    await access.assertCurrent();
    return result;
  }
}
