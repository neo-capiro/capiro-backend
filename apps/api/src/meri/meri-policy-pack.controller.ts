import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import {
  MeriPolicyPackService,
  type PolicyPackDraftInput,
  type PolicyPackRevisionInput,
} from './meri-policy-pack.service.js';

class CreatePolicyPackDto {
  @IsString() @Length(1, 120) packKey!: string;
  @IsString() @Length(1, 80) version!: string;
  @IsIn(['all', 'federal', 'state', 'local', 'regulatory', 'procurement', 'grants'])
  jurisdiction!: PolicyPackDraftInput['jurisdiction'];
  @IsOptional()
  @IsIn(['not_required_product_policy', 'pending', 'approved', 'rejected'])
  legalReviewStatus?: PolicyPackDraftInput['legalReviewStatus'];
  @IsObject() authority!: PolicyPackDraftInput['authority'];
  @IsString() effectiveFrom!: string;
  @IsOptional() @IsString() effectiveUntil?: string | null;
  @IsOptional() @IsBoolean() fourEyesRequired?: boolean;
  @IsArray() rules!: PolicyPackDraftInput['rules'];
  @IsOptional() @IsIn(['PASS', 'WARN', 'BLOCK']) fallback?: PolicyPackDraftInput['fallback'];
  @IsOptional() @IsBoolean() nonProduction?: boolean;
}

class RevisePolicyPackDto {
  @IsOptional()
  @IsIn(['all', 'federal', 'state', 'local', 'regulatory', 'procurement', 'grants'])
  jurisdiction?: PolicyPackRevisionInput['jurisdiction'];
  @IsOptional()
  @IsIn(['not_required_product_policy', 'pending', 'approved', 'rejected'])
  legalReviewStatus?: PolicyPackRevisionInput['legalReviewStatus'];
  @IsOptional() @IsObject() authority?: PolicyPackRevisionInput['authority'];
  @IsOptional() @IsString() effectiveFrom?: string;
  @IsOptional() @IsString() effectiveUntil?: string | null;
  @IsOptional() @IsBoolean() fourEyesRequired?: boolean;
  @IsOptional() @IsArray() rules?: PolicyPackRevisionInput['rules'];
  @IsOptional() @IsIn(['PASS', 'WARN', 'BLOCK']) fallback?: PolicyPackRevisionInput['fallback'];
  @IsOptional() @IsBoolean() nonProduction?: boolean;
}

class ReasonDto {
  @IsString() @Length(1, 4000) reason!: string;
}

class ReviewPolicyPackDto extends ReasonDto {
  @IsIn(['not_required_product_policy', 'approved'])
  legalReviewStatus!: 'not_required_product_policy' | 'approved';
}

class SimulatePolicyPackDto {
  @IsString() @Length(1, 120) tool!: string;
  @IsObject() input!: Record<string, unknown>;
  @IsOptional()
  @IsIn(['federal', 'state', 'local', 'regulatory', 'procurement', 'grants'])
  jurisdiction?: 'federal' | 'state' | 'local' | 'regulatory' | 'procurement' | 'grants';
  @IsOptional() @IsUUID() clientId?: string;
}

@Controller('clio/policy-packs')
@UseGuards(RolesGuard)
@Roles('user_admin', 'capiro_admin')
export class MeriPolicyPackController {
  constructor(private readonly packs: MeriPolicyPackService) {}

  @Get()
  list(@CurrentTenant() ctx: TenantContext) {
    return this.packs.listAdmin(ctx);
  }

  @Get('decisions/recent')
  decisions(@CurrentTenant() ctx: TenantContext) {
    return this.packs.recentDecisions(ctx);
  }

  @Post('seed-baseline')
  seed(@CurrentTenant() ctx: TenantContext) {
    return this.packs.seedBaseline(ctx);
  }

  @Post()
  create(@CurrentTenant() ctx: TenantContext, @Body() body: CreatePolicyPackDto) {
    return this.packs.createDraft(ctx, body);
  }

  @Patch(':packId')
  revise(
    @CurrentTenant() ctx: TenantContext,
    @Param('packId') packId: string,
    @Body() body: RevisePolicyPackDto,
  ) {
    return this.packs.reviseDraft(ctx, packId, body);
  }

  @Post(':packId/submit-review')
  submitReview(
    @CurrentTenant() ctx: TenantContext,
    @Param('packId') packId: string,
    @Body() body: ReasonDto,
  ) {
    return this.packs.submitReview(ctx, packId, body.reason);
  }

  @Post(':packId/review')
  review(
    @CurrentTenant() ctx: TenantContext,
    @Param('packId') packId: string,
    @Body() body: ReviewPolicyPackDto,
  ) {
    return this.packs.review(ctx, packId, body.legalReviewStatus, body.reason);
  }

  @Post(':packId/second-approve')
  secondApprove(
    @CurrentTenant() ctx: TenantContext,
    @Param('packId') packId: string,
    @Body() body: ReasonDto,
  ) {
    return this.packs.secondApprove(ctx, packId, body.reason);
  }

  @Post(':packId/simulate')
  simulate(
    @CurrentTenant() ctx: TenantContext,
    @Param('packId') packId: string,
    @Body() body: SimulatePolicyPackDto,
  ) {
    return this.packs.simulateAdmin(ctx, packId, body.tool, body.input, {
      ...(body.jurisdiction ? { jurisdiction: body.jurisdiction } : {}),
      ...(body.clientId ? { clientId: body.clientId } : {}),
    });
  }

  @Post(':packId/publish')
  publish(
    @CurrentTenant() ctx: TenantContext,
    @Param('packId') packId: string,
    @Body() body: ReasonDto,
  ) {
    return this.packs.publish(ctx, packId, body.reason);
  }

  @Post(':packId/retire')
  retire(
    @CurrentTenant() ctx: TenantContext,
    @Param('packId') packId: string,
    @Body() body: ReasonDto,
  ) {
    return this.packs.retire(ctx, packId, body.reason);
  }

  @Post(':packId/rollback/:targetId')
  rollback(
    @CurrentTenant() ctx: TenantContext,
    @Param('packId') packId: string,
    @Param('targetId') targetId: string,
    @Body() body: ReasonDto,
  ) {
    return this.packs.rollback(ctx, packId, targetId, body.reason);
  }

  @Get(':packId/events')
  events(@CurrentTenant() ctx: TenantContext, @Param('packId') packId: string) {
    return this.packs.events(ctx, packId);
  }
}
