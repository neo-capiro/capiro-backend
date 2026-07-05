import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { CapiroAdminService } from './capiro-admin.service.js';
import { MERIV2_FLAGS, type MeriV2FlagKey } from '../common/tenant-flags.js';
import { BillingService } from '../billing/billing.service.js';
import { AI_PROVIDERS } from '../ai-usage/ai-credential-store.service.js';
import type { AiProvider } from '../engagement/ai-credential-resolver.service.js';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/** '' / whitespace → undefined before validation (optional-string DTO pitfall). */
function EmptyToUndefined() {
  return Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  );
}

class CreateTenantDto {
  @IsString()
  @Length(2, 63)
  @Matches(/^[a-z0-9][a-z0-9-]*$/, { message: 'slug must be lowercase [a-z0-9-]' })
  slug!: string;

  @IsString()
  @Length(2, 200)
  name!: string;

  @IsEmail()
  adminEmail!: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  adminFirstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  adminLastName?: string;

  @IsOptional()
  @IsUrl()
  redirectUrl?: string;
}

class ResendInvitationDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsUrl()
  redirectUrl?: string;
}

class ImpersonateDto {
  @IsUUID()
  tenantId!: string;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

class AuditLogQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  action?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  entityType?: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class AiUsageRangeQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

class SetTenantAiCredentialDto {
  @IsIn(AI_PROVIDERS as readonly string[])
  provider!: AiProvider;

  @IsString()
  @Length(8, 400)
  apiKey!: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 80)
  modelOverride?: string;
}

class SetCompDto {
  @IsBoolean()
  comped!: boolean;
}

class QuarantineListQueryDto {
  @IsIn(['program_element', 'acquisition_personnel'])
  type!: 'program_element' | 'acquisition_personnel';

  @IsOptional()
  @IsString()
  @Length(1, 200)
  source?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * Capiro Admin console API. Every route is gated by the capiro_admin role.
 * Routes here run cross-tenant, the caller's TenantContext is the
 * `capiro-internal` synthetic tenant; data access is via prisma.withSystem.
 */
class SetMeriV2FlagDto {
  @IsIn(Object.values(MERIV2_FLAGS))
  flag!: MeriV2FlagKey;

  @IsBoolean()
  enabled!: boolean;
}

@Controller('capiro-admin')
@UseGuards(RolesGuard)
@Roles('capiro_admin')
export class CapiroAdminController {
  constructor(
    private readonly service: CapiroAdminService,
    private readonly billing: BillingService,
  ) {}

  @Get('tenants')
  listTenants() {
    return this.service.listTenants();
  }

  @Post('tenants')
  createTenant(@CurrentTenant() ctx: TenantContext, @Body() body: CreateTenantDto) {
    return this.service.createTenantWithFirstAdmin(body, ctx);
  }

  @Get('tenants/:tenantId')
  getTenant(@Param('tenantId') tenantId: string) {
    return this.service.getTenant(tenantId);
  }

  @Delete('tenants/:tenantId')
  deleteTenant(@Param('tenantId') tenantId: string) {
    return this.service.deleteTenant(tenantId);
  }

  /** A6: flip a MeriV2 rollout flag for one tenant (+ instant cache bust). */
  @Post('tenants/:tenantId/meriv2-flags')
  setMeriV2Flag(@Param('tenantId') tenantId: string, @Body() body: SetMeriV2FlagDto) {
    return this.service.setMeriV2Flag(tenantId, body.flag, body.enabled);
  }

  @Post('tenants/:tenantId/admins/resend')
  resendAdminInvitation(@Param('tenantId') tenantId: string, @Body() body: ResendInvitationDto) {
    return this.service.resendAdminInvitation(tenantId, body.email, body.redirectUrl);
  }

  @Delete('tenants/:tenantId/users/:userId')
  removeUser(@Param('tenantId') tenantId: string, @Param('userId') userId: string) {
    return this.service.removeUserFromTenant(tenantId, userId);
  }

  @Post('users/:clerkUserId/password-reset')
  sendPasswordReset(@Param('clerkUserId') clerkUserId: string) {
    return this.service.sendPasswordReset(clerkUserId);
  }

  @Post('impersonate')
  startImpersonation(@CurrentTenant() ctx: TenantContext, @Body() body: ImpersonateDto) {
    return this.service.startImpersonation(ctx.userId, body.tenantId, body.reason);
  }

  @Post('impersonate/end')
  endImpersonation(@CurrentTenant() ctx: TenantContext) {
    return this.service.endImpersonation(ctx.userId);
  }

  // --- AI keys & usage console ----------------------------------------------

  @Get('ai-usage')
  getAiUsageAllTenants(@Query() query: AiUsageRangeQueryDto) {
    return this.service.getAiUsageAllTenants(query);
  }

  @Get('tenants/:tenantId/ai-usage')
  getTenantAiUsage(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: AiUsageRangeQueryDto,
  ) {
    return this.service.getTenantAiUsage(tenantId, query);
  }

  @Get('tenants/:tenantId/ai-credential')
  listTenantAiCredentials(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.service.listTenantAiCredentials(tenantId);
  }

  @Post('tenants/:tenantId/ai-credential')
  setTenantAiCredential(
    @CurrentTenant() ctx: TenantContext,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: SetTenantAiCredentialDto,
  ) {
    return this.service.setTenantAiCredential(ctx, tenantId, {
      provider: body.provider,
      apiKey: body.apiKey,
      modelOverride: body.modelOverride,
    });
  }

  @Delete('tenants/:tenantId/ai-credential/:provider')
  removeTenantAiCredential(
    @CurrentTenant() ctx: TenantContext,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('provider') provider: string,
  ) {
    if (!(AI_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`provider must be one of: ${AI_PROVIDERS.join(', ')}`);
    }
    return this.service.removeTenantAiCredential(ctx, tenantId, provider as AiProvider);
  }

  // --- Billing console ------------------------------------------------------

  /** All tenants with billing posture + MTD LLM spend (paying-customers list). */
  @Get('billing/customers')
  listBillingCustomers() {
    return this.billing.adminListCustomers();
  }

  /** Comp / un-comp a tenant (Capiro staff + courtesy accounts pay $0). */
  @Post('tenants/:tenantId/comp')
  setTenantComp(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: SetCompDto) {
    return this.billing.setComped(tenantId, body.comped);
  }

  // --- Step 3.5: analyst console -------------------------------------------

  @Get('review-counts')
  getReviewCounts() {
    return this.service.getReviewCounts();
  }

  @Get('audit-logs')
  listAuditLogs(@CurrentTenant() ctx: TenantContext, @Query() query: AuditLogQueryDto) {
    return this.service.listAuditLogs(ctx, query);
  }

  @Get('quarantine')
  listQuarantine(@Query() query: QuarantineListQueryDto) {
    return this.service.listQuarantine(query);
  }

  @Post('quarantine/:type/:id/discard')
  discardQuarantine(
    @CurrentTenant() ctx: TenantContext,
    @Param('type') type: string,
    @Param('id') id: string,
  ) {
    return this.service.discardQuarantine(ctx, this.parseQuarantineType(type), id);
  }

  @Post('quarantine/:type/:id/reprocess')
  reprocessQuarantine(
    @CurrentTenant() ctx: TenantContext,
    @Param('type') type: string,
    @Param('id') id: string,
  ) {
    return this.service.reprocessQuarantine(ctx, this.parseQuarantineType(type), id);
  }

  private parseQuarantineType(type: string): 'program_element' | 'acquisition_personnel' {
    if (type !== 'program_element' && type !== 'acquisition_personnel') {
      throw new BadRequestException('type must be program_element or acquisition_personnel');
    }
    return type;
  }
}
