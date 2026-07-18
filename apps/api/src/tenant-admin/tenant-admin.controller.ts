import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { ContactInfoInput } from './tenant-admin.service.js';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { TenantAdminService } from './tenant-admin.service.js';

class InviteDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsIn(['user_admin', 'standard_user'])
  role!: 'user_admin' | 'standard_user';

  @IsOptional()
  @IsString()
  @Length(1, 100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  lastName?: string;

  @IsOptional()
  @IsUrl()
  redirectUrl?: string;
}

class UpdateTeamMemberRoleDto {
  @IsString()
  @IsIn(['user_admin', 'standard_user'])
  role!: 'user_admin' | 'standard_user';
}

class SetBillingAdminDto {
  @IsBoolean()
  billingAdmin!: boolean;
}

class UpdateContactInfoDto implements ContactInfoInput {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  mailingStreet1?: string;

  @IsOptional()
  @IsString()
  mailingStreet2?: string;

  @IsOptional()
  @IsString()
  mailingCity?: string;

  @IsOptional()
  @IsString()
  mailingStateZip?: string;

  @IsOptional()
  @IsString()
  permanentStreet1?: string;

  @IsOptional()
  @IsString()
  permanentStreet2?: string;

  @IsOptional()
  @IsString()
  permanentCity?: string;

  @IsOptional()
  @IsString()
  permanentStateZip?: string;
}

class UpdateBrandingDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  logoS3Key?: string;

  @IsOptional()
  @IsString()
  logoContentType?: string;
}

/** Customer audit-trail query (#3d). No actorUserId filter — a Capiro-internal
 *  staff UUID is not a meaningful/safe customer filter. Query params arrive as
 *  strings, so page/limit are coerced with @Type. */
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

/**
 * Per-tenant admin endpoints. Caller must be `user_admin` (own tenant) or
 * `capiro_admin` (any tenant). The TenantContext is set by middleware; all
 * data access goes through prisma.withTenant which applies RLS.
 */
@Controller('tenant-admin')
@UseGuards(RolesGuard)
@Roles('user_admin')
export class TenantAdminController {
  constructor(private readonly service: TenantAdminService) {}

  @Get('team')
  team(@CurrentTenant() ctx: TenantContext) {
    return this.service.listTeam(ctx);
  }

  /** #3d — a tenant's own admins read its audit trail (incl. privileged Capiro
   *  actions now routed to this tenant). user_admin only; redacted projection. */
  @Get('audit-logs')
  auditLogs(@CurrentTenant() ctx: TenantContext, @Query() query: AuditLogQueryDto) {
    return this.service.listAuditLogs(ctx, query);
  }

  @Get('team/invitations')
  invitations(@CurrentTenant() ctx: TenantContext) {
    return this.service.listPendingInvitations(ctx);
  }

  @Post('team/invite')
  invite(@CurrentTenant() ctx: TenantContext, @Body() body: InviteDto) {
    return this.service.inviteTeamMember(ctx, body);
  }

  @Post('team/invitations/:invitationId/resend')
  resend(@CurrentTenant() ctx: TenantContext, @Param('invitationId') invitationId: string) {
    return this.service.resendInvitation(ctx, invitationId);
  }

  @Delete('team/:userId')
  remove(@CurrentTenant() ctx: TenantContext, @Param('userId') userId: string) {
    return this.service.removeMember(ctx, userId);
  }

  @Put('team/:userId/role')
  updateRole(
    @CurrentTenant() ctx: TenantContext,
    @Param('userId') userId: string,
    @Body() body: UpdateTeamMemberRoleDto,
  ) {
    return this.service.updateMemberRole(ctx, userId, body.role);
  }

  /**
   * Grant/revoke the billing permission (onboarding v1 "Super Admin" bit).
   * Route min-role is user_admin; the service additionally requires the
   * caller to be capiro_admin or an existing billing admin.
   */
  @Put('team/:userId/billing-admin')
  setBillingAdmin(
    @CurrentTenant() ctx: TenantContext,
    @Param('userId') userId: string,
    @Body() body: SetBillingAdminDto,
  ) {
    return this.service.setBillingAdmin(ctx, userId, body.billingAdmin);
  }

  @Get('contact-info')
  @Roles('standard_user')
  getContactInfo(@CurrentTenant() ctx: TenantContext) {
    return this.service.getContactInfo(ctx);
  }

  @Put('contact-info')
  updateContactInfo(@CurrentTenant() ctx: TenantContext, @Body() body: UpdateContactInfoDto) {
    return this.service.updateContactInfo(ctx, body);
  }

  @Put('branding')
  branding(@CurrentTenant() ctx: TenantContext, @Body() body: UpdateBrandingDto) {
    return this.service.updateBranding(ctx, body);
  }

  @Get('billing')
  billing(@CurrentTenant() ctx: TenantContext) {
    return this.service.getBilling(ctx);
  }
}
