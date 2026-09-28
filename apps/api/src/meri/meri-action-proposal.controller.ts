import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { admitMeriActionProposalTransport } from './meri-rp-action-proposal-transport.js';
import { admitMeriServerReadonlyCaptureTransport } from './meri-server-readonly-capture.js';

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
  @ValidateIf((query: ListMeriActionProposalDto) =>
    query.conversationId !== undefined || query.proposalId !== undefined)
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
  constructor(private readonly proposals: MeriActionProposalService) {}

  /** Orchestrator-only: user JWT + internal service identity are both required. */
  @Post()
  @UseGuards(ToolServiceSecretGuard)
  create(
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
    return withMeriToolRequestControl(req, () =>
      admitted.trustedTurn
        ? this.proposals.create(ctx, admitted.request, admitted.trustedTurn)
        : this.proposals.create(ctx, admitted.request),
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
