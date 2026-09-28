import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { meriTelemetryOperationId } from '@capiro/meriv2-core';
import type { Request } from 'express';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { admitMeriActionProposalTransport } from './meri-rp-action-proposal-transport.js';
import { admitMeriServerReadonlyCaptureTransport } from './meri-server-readonly-capture.js';
import {
  admitMeriInternalTelemetry,
  emitMeriApiTelemetry,
  runWithMeriApiTelemetry,
} from './meri-telemetry.runtime.js';

export class CreateMeriActionProposalDto {
  @ValidateIf((body: CreateMeriActionProposalDto) => body.version === undefined)
  @IsString()
  @Length(1, 120)
  tool?: string;

  @ValidateIf((body: CreateMeriActionProposalDto) => body.version === undefined)
  @IsObject()
  input?: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ValidateIf((body: CreateMeriActionProposalDto) => body.version === undefined)
  @IsIn(['chat'])
  surface?: 'chat';

  @IsOptional()
  @IsIn([1])
  version?: 1;

  @IsOptional()
  @IsObject()
  proposal?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  currentTurn?: Record<string, unknown>;
}

export class ListMeriActionProposalDto {
  @ValidateIf(
    (query: ListMeriActionProposalDto) =>
      query.conversationId !== undefined || query.proposalId !== undefined,
  )
  @IsUUID()
  conversationId?: string;

  @IsOptional()
  @IsUUID()
  proposalId?: string;
}

export class DecideMeriActionProposalDto {
  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string;
}

@Controller('clio/action-proposals')
@UseGuards(RolesGuard)
@Roles('capiro_admin', 'user_admin', 'standard_user')
export class MeriActionProposalController {
  private readonly logger = new Logger(MeriActionProposalController.name);

  constructor(private readonly proposals: MeriActionProposalService) {}

  /** Orchestrator-only: user JWT + internal service identity are both required. */
  @Post()
  @UseGuards(ToolServiceSecretGuard)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: CreateMeriActionProposalDto,
    @Req() req: Request,
  ) {
    admitMeriServerReadonlyCaptureTransport({
      ctx,
      req,
      purpose: 'action_proposal',
      toolName: null,
    });
    const admitted = admitMeriActionProposalTransport(body, ctx, req);
    const telemetry = admitMeriInternalTelemetry(req, ctx, body.conversationId);
    return runWithMeriApiTelemetry(
      telemetry,
      (line) => this.logger.log(line),
      async () => {
        const startedAt = Date.now();
        try {
          const result = await withMeriToolRequestControl(req, () =>
            admitted.trustedTurn
              ? this.proposals.create(ctx, admitted.request, admitted.trustedTurn)
              : this.proposals.create(ctx, admitted.request),
          );
          emitMeriApiTelemetry({
            name: 'meri.api.proposal.finalized',
            boundary: 'api_proposal',
            invokedTools: [result?.proposal?.tool ?? admitted.request.tool],
            proposalId: result?.proposal?.proposalId ?? null,
            operationId: meriTelemetryOperationId(result),
            outcome: result?.disposition ?? 'completed',
            durationMs: Date.now() - startedAt,
          });
          return result;
        } catch (error) {
          emitMeriApiTelemetry({
            name: 'meri.api.proposal.finalized',
            boundary: 'api_proposal',
            outcome: 'error',
            durationMs: Date.now() - startedAt,
          });
          throw error;
        }
      },
    );
  }

  /** Browser-safe recovery surface. Only the current user's tenant-scoped rows return. */
  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Query() query: ListMeriActionProposalDto) {
    return this.proposals.list(ctx, query.conversationId, query.proposalId);
  }

  /** Browser approval carries only the opaque proposal id and an optional note. */
  @Post(':proposalId/approve')
  approve(
    @CurrentTenant() ctx: TenantContext,
    @Param('proposalId', new ParseUUIDPipe({ version: '4' })) proposalId: string,
    @Body() _body: DecideMeriActionProposalDto,
  ) {
    return this.proposals.approveAndExecute(ctx, proposalId);
  }

  /** Dismissal is a durable lifecycle transition, never a delete. */
  @Post(':proposalId/dismiss')
  dismiss(
    @CurrentTenant() ctx: TenantContext,
    @Param('proposalId', new ParseUUIDPipe({ version: '4' })) proposalId: string,
    @Body() _body: DecideMeriActionProposalDto,
  ) {
    return this.proposals.dismiss(ctx, proposalId);
  }
}
