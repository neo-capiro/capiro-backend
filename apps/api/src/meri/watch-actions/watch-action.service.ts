/**
 * MO-06 governed watch lifecycle, Core side. It mirrors the accepted LegiWatch
 * action vertical exactly: the same application-current authority, the same
 * existing proposal ledger as the only effect boundary, the same conversation
 * result link. This leaf adds no second ledger, no scheduler, no grant and no
 * delivery loop:
 *
 *  - `prepare` stores a proposal bound to the exact canonical target/verb/version;
 *  - `read`/`decide` reuse the ledger and are the only mutation path;
 *  - `inspect` is read-only and touches no ledger row;
 *  - approved execution uses the same registry directly through MeriToolsService,
 *    without a proposal/tools/service dependency cycle. Unconfirmed acknowledgements
 *    remain UNKNOWN and are never resent automatically.
 */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';
import { ApplicationCurrentService } from '../../auth/application-current.service.js';
import { MeriActionProposalService } from '../meri-action-proposal.service.js';
import { assertMeriToolRequestActive } from '../meri-tool-request-control.js';
import { retainedReadSnapshot, readRetainedReadDeadline } from '../retained-read-context.js';
import { hasVerifiedToolServiceIdentity } from '../tool-service-secret.guard.js';
import {
  WATCH_ACTION,
  watchInput,
  watchRequestSchema,
  watchScopeSchema,
  watchSelectionSchema,
  watchTargetSchema,
  type WatchState,
} from './watch-action.contract.js';
import { WatchActionRegistry } from './watch-action.registry.js';

const selection = z
  .object({
    version: z.literal(1),
    context: watchSelectionSchema,
    request: watchRequestSchema,
  })
  .strict();
const observation = z
  .object({ version: z.literal(1), proposalId: z.string().uuid(), context: watchScopeSchema })
  .strict();
const decision = observation.extend({ decision: z.enum(['approved', 'rejected']) }).strict();
const inspection = z
  .object({ version: z.literal(1), context: watchSelectionSchema, target: watchTargetSchema })
  .strict();
const refuse = () => new ForbiddenException('Watch action access unavailable');

@Injectable()
export class WatchActionService {
  constructor(
    private readonly current: ApplicationCurrentService,
    private readonly proposals: MeriActionProposalService,
    private readonly registry: WatchActionRegistry,
  ) {}

  private async access(
    ctx: TenantContext,
    req: Request,
    context: z.infer<typeof watchSelectionSchema> & Partial<z.infer<typeof watchScopeSchema>>,
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
    if (!parsed.success) throw new BadRequestException('Invalid watch proposal');
    const { context, request } = parsed.data,
      access = await this.access(ctx, req, context, request.clientId);
    const result = await this.proposals.create(
      ctx,
      {
        tool: WATCH_ACTION,
        input: watchInput(request),
        conversationId: context.conversationId,
        surface: 'chat',
        requireApproval: true,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      access,
    );
    await access.assertCurrent();
    if (result.disposition !== 'pending_approval')
      throw new ForbiddenException('Watch proposal is not approvable');
    return this.proposals.readWatch(ctx, result.proposal.proposalId, access);
  }

  async read(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = observation.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Invalid watch receipt selection');
    const { context, proposalId } = parsed.data,
      access = await this.access(ctx, req, context);
    const result = await this.proposals.readWatch(ctx, proposalId, access);
    await access.assertCurrent();
    return result;
  }

  async decide(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = decision.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Invalid watch decision');
    const { context, proposalId, decision: choice } = parsed.data,
      access = await this.access(ctx, req, context);
    // Preserve every existing owner slot; watch authority is appended last.
    if (choice === 'approved')
      await this.proposals.approveAndExecute(ctx, proposalId, undefined, undefined, undefined, undefined, access);
    else await this.proposals.dismiss(ctx, proposalId, undefined, undefined, undefined, undefined, access);
    const result = await this.proposals.readWatch(ctx, proposalId, access);
    await access.assertCurrent();
    return result;
  }

  /** Read-only owner state. Creates no proposal and mutates nothing. */
  async inspect(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = inspection.safeParse(retainedReadSnapshot(raw, 4096));
    if (!parsed.success) throw new BadRequestException('Invalid watch target');
    const { context, target } = parsed.data,
      access = await this.access(ctx, req, context, target.clientId);
    const state: WatchState = await this.registry.adapter(target.family).inspect(ctx, target);
    await access.assertCurrent();
    return { version: '0.1.0' as const, state };
  }

}
