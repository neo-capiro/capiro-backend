import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';
import { LegiwatchActionService } from './legiwatch-action.service.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { legiwatchScopeSchema, legiwatchSelectionSchema } from './legiwatch-action.contract.js';
import {
  parseRelevanceSave,
  relevanceSaveSchema,
  RELEVANCE_SAVE,
} from './legiwatch-relevance.contract.js';
import { retainedReadSnapshot } from './retained-read-context.js';

const prepare = z
  .object({
    version: z.literal(1),
    context: legiwatchSelectionSchema,
    request: relevanceSaveSchema,
  })
  .strict();
const observe = z
  .object({ version: z.literal(1), proposalId: z.string().uuid(), context: legiwatchScopeSchema })
  .strict();
const decide = observe.extend({ decision: z.enum(['approved', 'rejected']) }).strict();
@Injectable()
export class LegiwatchRelevanceActionService {
  constructor(
    private readonly current: LegiwatchActionService,
    private readonly proposals: MeriActionProposalService,
  ) {}
  async prepare(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = prepare.safeParse(retainedReadSnapshot(raw, 16384));
    if (!parsed.success) throw new BadRequestException('Invalid LegiWatch relevance proposal');
    const { context } = parsed.data,
      request = parseRelevanceSave(parsed.data.request);
    const access = await this.current.access(ctx, req, context, request.clientId);
    const { clientId, ...rest } = request;
    const result = await this.proposals.create(
      ctx,
      {
        tool: RELEVANCE_SAVE,
        input: { ...rest, ...(clientId === null ? {} : { clientId }) },
        conversationId: context.conversationId,
        surface: 'chat',
        requireApproval: true,
      },
      undefined,
      access,
    );
    await access.assertCurrent();
    if (result.disposition !== 'pending_approval')
      throw new ForbiddenException('LegiWatch relevance proposal is not approvable');
    return this.proposals.readLegiwatch(ctx, result.proposal.proposalId, access);
  }
  async read(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = observe.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success)
      throw new BadRequestException('Invalid LegiWatch relevance receipt selection');
    const { context, proposalId } = parsed.data,
      access = await this.current.access(ctx, req, context);
    const result = await this.proposals.readLegiwatch(ctx, proposalId, access);
    parseRelevanceSave(result.request);
    await access.assertCurrent();
    return result;
  }
  async decide(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = decide.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Invalid LegiWatch relevance decision');
    const { context, proposalId, decision } = parsed.data,
      access = await this.current.access(ctx, req, context);
    const before = await this.proposals.readLegiwatch(ctx, proposalId, access);
    parseRelevanceSave(before.request);
    if (decision === 'approved') await this.proposals.approveAndExecute(ctx, proposalId, access);
    else await this.proposals.dismiss(ctx, proposalId, access);
    const result = await this.proposals.readLegiwatch(ctx, proposalId, access);
    await access.assertCurrent();
    return result;
  }
}
