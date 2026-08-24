import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';

/** Product lifecycle statuses (spec section 7). Legacy values from the
 *  original PR #1253 enum ('open'/'resolved'/'stalled') are still valid at
 *  the DB layer for pre-existing rows but are no longer offered here — new
 *  writes go through the lifecycle set below. */
const MATTER_STATUSES = [
  'planning', 'active', 'monitoring', 'outcome_observed',
  'successful', 'partially_successful', 'unsuccessful', 'withdrawn', 'archived',
] as const;

class UpdateAdvocacyMatterDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsIn(MATTER_STATUSES)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;

  /** Required (true) to move status into successful/partially_successful/
   *  unsuccessful when the Matter has no linked outcome_event yet — see
   *  ClientAdvocacyMatterService.updateMatter. Ignored for other statuses. */
  @IsOptional()
  @IsBoolean()
  confirmOutcome?: boolean;
}

class MergeAdvocacyMatterDto {
  @IsUUID()
  sourceMatterId!: string;
}

class CreateAdvocacyMatterDto {
  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsIn(['funding_request', 'legislative', 'regulatory', 'program_element', 'community_project', 'procurement', 'other'])
  matterType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;
}

class ReassignAdvocacyRecordDto {
  @IsUUID()
  targetMatterId!: string;
}

class NotAdvocacyDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

class LinkMeetingDto {
  @IsUUID()
  meetingId!: string;
}

class LinkMailThreadDto {
  @IsUUID()
  threadId!: string;
}

class LinkOutreachDto {
  @IsUUID()
  outreachRecordId!: string;
}

class LinkStrategyDto {
  @IsUUID()
  strategyId!: string;

  @IsOptional()
  @IsUUID()
  nodeId?: string;

  @IsIn(['planned_action', 'completed_action'])
  relationshipType!: 'planned_action' | 'completed_action';
}

class LinkRegulatoryDocketDto {
  @IsString()
  @MaxLength(64)
  documentId!: string;
}

class LinkRegulatoryDocumentDto {
  @IsString()
  @MaxLength(64)
  documentNumber!: string;
}

class LinkHearingDto {
  @IsUUID()
  hearingId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  manualRationale?: string;
}

class LinkTestimonyDto {
  @IsUUID()
  hearingId!: string;

  @IsString()
  @MaxLength(300)
  witnessName!: string;
}

class LinkFaraRecordDto {
  @IsString()
  @MaxLength(64)
  registrationNumber!: string;
}

/**
 * Advocacy Matter read/manage surface (product spec: "the central
 * abstraction is an Advocacy Matter"). This is a thin API over
 * `ClientAdvocacyMatterService` — clustering and record/link assignment
 * happen as a side effect of `ClientProfileFillCompletionService.applyFindings`
 * (see that service's `applyAdvocacyRecord`), not here. This controller
 * lists, reads, edits Matter metadata, merges two Matters, creates a Matter
 * by hand, and lets a user correct an individual record's Matter assignment
 * (reassign / detach / mark not advocacy) — the Matter correction UX
 * required by product spec section 6.
 */
@Controller('clients/:clientId/advocacy-matters')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientAdvocacyMatterController {
  constructor(private readonly matters: ClientAdvocacyMatterService) {}

  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.matters.listMatters(ctx, clientId);
  }

  @Get(':matterId')
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
  ) {
    return this.matters.getMatter(ctx, clientId, matterId);
  }

  @Post()
  @Roles('user_admin')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: CreateAdvocacyMatterDto,
  ) {
    return this.matters.createMatter(ctx, clientId, body);
  }

  @Patch(':matterId')
  @Roles('user_admin')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: UpdateAdvocacyMatterDto,
  ) {
    return this.matters.updateMatter(ctx, clientId, matterId, body);
  }

  @Post(':matterId/merge')
  @Roles('user_admin')
  merge(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: MergeAdvocacyMatterDto,
  ) {
    return this.matters.mergeMatters(ctx, clientId, matterId, body.sourceMatterId);
  }

  @Post('records/:recordId/reassign')
  @Roles('user_admin')
  reassignRecord(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('recordId') recordId: string,
    @Body() body: ReassignAdvocacyRecordDto,
  ) {
    return this.matters.reassignRecord(ctx, clientId, recordId, body.targetMatterId);
  }

  @Post('records/:recordId/detach')
  @Roles('user_admin')
  detachRecord(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('recordId') recordId: string,
  ) {
    return this.matters.detachRecord(ctx, clientId, recordId);
  }

  @Post('records/:recordId/not-advocacy')
  @Roles('user_admin')
  markNotAdvocacy(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('recordId') recordId: string,
    @Body() body: NotAdvocacyDto,
  ) {
    return this.matters.markRecordNotAdvocacy(ctx, clientId, recordId, body.reason);
  }

  @Post(':matterId/link-meeting')
  @Roles('user_admin')
  linkMeeting(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: LinkMeetingDto,
  ) {
    return this.matters.linkMeeting(ctx, clientId, matterId, body.meetingId);
  }

  @Post(':matterId/link-mail-thread')
  @Roles('user_admin')
  linkMailThread(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: LinkMailThreadDto,
  ) {
    return this.matters.linkMailThread(ctx, clientId, matterId, body.threadId);
  }

  @Post(':matterId/link-outreach')
  @Roles('user_admin')
  linkOutreach(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: LinkOutreachDto,
  ) {
    return this.matters.linkOutreach(ctx, clientId, matterId, body.outreachRecordId);
  }

  @Post(':matterId/link-strategy')
  @Roles('user_admin')
  linkStrategy(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: LinkStrategyDto,
  ) {
    return this.matters.linkStrategy(ctx, clientId, matterId, {
      strategyId: body.strategyId,
      nodeId: body.nodeId ?? null,
      relationshipType: body.relationshipType,
    });
  }

  @Post(':matterId/link-regulatory-docket')
  @Roles('user_admin')
  linkRegulatoryDocket(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: LinkRegulatoryDocketDto,
  ) {
    return this.matters.linkRegulatoryDocket(ctx, clientId, matterId, body.documentId);
  }

  @Post(':matterId/link-regulatory-document')
  @Roles('user_admin')
  linkRegulatoryDocument(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: LinkRegulatoryDocumentDto,
  ) {
    return this.matters.linkRegulatoryDocument(ctx, clientId, matterId, body.documentNumber);
  }

  @Post(':matterId/link-hearing')
  @Roles('user_admin')
  linkHearing(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: LinkHearingDto,
  ) {
    return this.matters.linkHearing(ctx, clientId, matterId, body.hearingId, body.manualRationale ?? null);
  }

  @Post(':matterId/link-testimony')
  @Roles('user_admin')
  linkTestimony(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: LinkTestimonyDto,
  ) {
    return this.matters.linkTestimony(ctx, clientId, matterId, body.hearingId, body.witnessName);
  }

  @Post(':matterId/link-fara-record')
  @Roles('user_admin')
  linkFaraRecord(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: LinkFaraRecordDto,
  ) {
    return this.matters.linkFaraRecord(ctx, clientId, matterId, body.registrationNumber);
  }
}
