import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';
import { ApplicationCurrentService } from '../auth/application-current.service.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { retainedReadSnapshot, readRetainedReadDeadline } from './retained-read-context.js';
import { assertMeriToolRequestActive } from './meri-tool-request-control.js';
import { hasVerifiedToolServiceIdentity } from './tool-service-secret.guard.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import {
  CLIENT_RECORD_MAX_BYTES,
  clientRecordRequestSchema,
  clientRecordScopeSchema,
  clientRecordSelectionSchema,
  clientRecordRequest,
  type ClientRecordAccess,
} from './client-record-action.contract.js';

const prepare = z
  .object({
    version: z.literal(1),
    context: clientRecordSelectionSchema,
    request: clientRecordRequestSchema,
  })
  .strict();
const observe = z
  .object({
    version: z.literal(1),
    proposalId: z.string().uuid(),
    context: clientRecordScopeSchema,
  })
  .strict();
const decide = observe.extend({ decision: z.enum(['approved', 'rejected']) }).strict();
const denied = () => new ForbiddenException('Client record action access unavailable');
@Injectable()
export class ClientRecordActionService {
  constructor(
    private readonly current: ApplicationCurrentService,
    private readonly proposals: MeriActionProposalService,
  ) {}
  private async access(
    ctx: TenantContext,
    req: Request,
    context: z.infer<typeof clientRecordSelectionSchema> &
      Partial<z.infer<typeof clientRecordScopeSchema>>,
    mode: ClientRecordAccess['mode'],
  ): Promise<ClientRecordAccess> {
    if (
      !hasVerifiedToolServiceIdentity(req) ||
      req.headers['x-capiro-impersonate-tenant'] !== undefined
    )
      throw denied();
    const deadline = readRetainedReadDeadline(req),
      check = () => {
        assertMeriToolRequestActive();
        if (Date.now() >= deadline) throw denied();
      };
    const selection = {
      conversationId: context.conversationId,
      clientId: context.selectedClientId,
    };
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
      ...selection,
      ...(expected && mode === 'execute' ? { expect: expected } : {}),
    });
    if (
      expected &&
      (first.identityRevision !== expected.identityRevision ||
        first.contextRevision !== expected.contextRevision ||
        (mode === 'execute' && first.membershipRevision !== expected.membershipRevision))
    )
      throw denied();
    check();
    const scope = {
      ...context,
      identityRevision: first.identityRevision,
      membershipRevision: first.membershipRevision,
      contextRevision: first.contextRevision,
    };
    const current = this.current;
    return {
      scope,
      mode,
      clientIds: first.clientIds,
      async assertCurrent() {
        check();
        await current.read(ctx, req, {
          ...selection,
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
    const parsed = prepare.safeParse(retainedReadSnapshot(raw, CLIENT_RECORD_MAX_BYTES));
    if (!parsed.success) throw new BadRequestException('Invalid client record proposal');
    const { context } = parsed.data,
      request = clientRecordRequest(parsed.data.request.operation, parsed.data.request.input);
    assertMeriToolAllowed(request.operation);
    const access = await this.access(ctx, req, context, 'execute');
    const result = await this.proposals.create(
      ctx,
      {
        tool: request.operation,
        input: request.input,
        conversationId: context.conversationId,
        surface: 'chat',
        requireApproval: true,
      },
      undefined,
      undefined,
      access,
    );
    await access.assertCurrent();
    if (result.disposition !== 'pending_approval') throw denied();
    return this.proposals.readClientRecord(ctx, result.proposal.proposalId, access);
  }
  async read(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = observe.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Invalid client record observation');
    const { context, proposalId } = parsed.data,
      access = await this.access(ctx, req, context, 'observe');
    const result = await this.proposals.readClientRecord(ctx, proposalId, access);
    await access.assertCurrent();
    return result;
  }
  async decide(ctx: TenantContext, req: Request, raw: unknown) {
    const parsed = decide.safeParse(retainedReadSnapshot(raw, 8192));
    if (!parsed.success) throw new BadRequestException('Invalid client record decision');
    const { context, proposalId, decision } = parsed.data,
      access = await this.access(ctx, req, context, 'execute');
    const before = await this.proposals.readClientRecord(ctx, proposalId, access);
    assertMeriToolAllowed(before.request.operation);
    if (decision === 'approved')
      await this.proposals.approveAndExecute(ctx, proposalId, undefined, access);
    else await this.proposals.dismiss(ctx, proposalId, undefined, access);
    // The effect may update the membership revision itself. This is a separate read;
    // its fresh authority can never be passed back into the execution claim above.
    return this.read(ctx, req, { version: 1, proposalId, context });
  }
}
