import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';
import { ApplicationCurrentService } from '../auth/application-current.service.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { assertMeriToolRequestActive } from './meri-tool-request-control.js';
import { retainedReadSnapshot, readRetainedReadDeadline } from './retained-read-context.js';
import { hasVerifiedToolServiceIdentity } from './tool-service-secret.guard.js';
import {
  LEGIWATCH_ACTION,
  legiwatchInput,
  legiwatchRequestSchema,
  legiwatchScopeSchema,
  legiwatchSelectionSchema,
} from './legiwatch-action.contract.js';

const selection = z
  .object({
    version: z.literal(1),
    context: legiwatchSelectionSchema,
    request: legiwatchRequestSchema,
  })
  .strict();
const observation = z
  .object({ version: z.literal(1), proposalId: z.string().uuid(), context: legiwatchScopeSchema })
  .strict();
const decision = observation.extend({ decision: z.enum(['approved', 'rejected']) }).strict();
const refuse = () => new ForbiddenException('LegiWatch action access unavailable');
@Injectable()
export class LegiwatchActionService {
  constructor(
    private readonly current: ApplicationCurrentService,
    private readonly proposals: MeriActionProposalService,
  ) {}
  private async access(
    ctx: TenantContext,
    req: Request,
    context: z.infer<typeof legiwatchSelectionSchema> &
      Partial<z.infer<typeof legiwatchScopeSchema>>,
    clientId?: string | null,
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
    const selected = { conversationId: context.conversationId, clientId: context.selectedClientId };
    const expected =
      context.identityRevision === undefined
        ? undefined
        : {
            identityRevision: context.identityRevision,
            membershipRevision: context.membershipRevision!,
            contextRevision: context.contextRevision!,
          };
    check();
    const first = await this.current.read(ctx, req, {
      ...selected,
      ...(expected ? { expect: expected } : {}),
    });
    if (
      clientId !== undefined &&
      ((context.selectedClientId !== null && clientId !== context.selectedClientId) ||
        (clientId !== null && !first.clientIds.includes(clientId)))
    )
      throw refuse();
    const scope = {
      ...context,
      identityRevision: first.identityRevision,
      membershipRevision: first.membershipRevision,
      contextRevision: first.contextRevision,
    };
    const thisCurrent = this.current;
    return {
      scope,
      async assertCurrent() {
        check();
        await thisCurrent.read(ctx, req, {
          ...selected,
          expect: {
            identityRevision: scope.identityRevision,
            membershipRevision: scope.membershipRevision,
            contextRevision: scope.contextRevision,
          },
        });
        check();
      },
    };
  }
  async prepare(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = selection.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Invalid LegiWatch proposal');
    const { context, request } = parsed.data,
      access = await this.access(ctx, req, context, request.clientId);
    const result = await this.proposals.create(
      ctx,
      {
        tool: LEGIWATCH_ACTION,
        input: legiwatchInput(request),
        conversationId: context.conversationId,
        surface: 'chat',
        requireApproval: true,
      },
      undefined,
      access,
    );
    await access.assertCurrent();
    if (result.disposition !== 'pending_approval')
      throw new ForbiddenException('LegiWatch proposal is not approvable');
    return this.proposals.readLegiwatch(ctx, result.proposal.proposalId, access);
  }
  async read(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = observation.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Invalid LegiWatch receipt selection');
    const { context, proposalId } = parsed.data,
      access = await this.access(ctx, req, context);
    const result = await this.proposals.readLegiwatch(ctx, proposalId, access);
    await access.assertCurrent();
    return result;
  }
  async decide(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = decision.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Invalid LegiWatch decision');
    const { context, proposalId, decision: choice } = parsed.data,
      access = await this.access(ctx, req, context);
    if (choice === 'approved') await this.proposals.approveAndExecute(ctx, proposalId, access);
    else await this.proposals.dismiss(ctx, proposalId, access);
    const result = await this.proposals.readLegiwatch(ctx, proposalId, access);
    await access.assertCurrent();
    return result;
  }
}
