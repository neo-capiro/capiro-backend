import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { InternalOnboardingService } from './internal-onboarding.service.js';

class PurchaserDto {
  @IsString()
  @Length(1, 128)
  clerkUserId!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  lastName?: string;
}

class InviteDto {
  @IsEmail()
  email!: string;

  @IsBoolean()
  billingAdmin!: boolean;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  lastName?: string;
}

class ProvisionTenantDto {
  @IsString()
  @Length(2, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(2, 63)
  slugBase?: string;

  @IsIn(['trial', 'paid'])
  plan!: 'trial' | 'paid';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  clientSlots!: number;

  @IsIn(['self', 'managed'])
  importMode!: 'self' | 'managed';

  @IsObject()
  orgProfile!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  stripeCustomerId?: string;

  @ValidateNested()
  @Type(() => PurchaserDto)
  purchaser!: PurchaserDto;

  @IsBoolean()
  selfAssign!: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InviteDto)
  invites!: InviteDto[];

  @IsUrl({ require_tld: false })
  inviteRedirectUrl!: string;
}

/**
 * Internal-only (InternalServiceGuard) self-service tenant provisioning,
 * called by apps/onboard-api at the Flow-1.10 bridge. Never reachable by a
 * browser-held Clerk JWT — the shared x-internal-service-secret header is the
 * gate (same channel as BYOK3's ai-credential resolve).
 */
@Controller('internal/onboarding')
@UseGuards(InternalServiceGuard)
export class InternalOnboardingController {
  constructor(private readonly service: InternalOnboardingService) {}

  @Post('tenants')
  @HttpCode(200)
  provision(@Body() body: ProvisionTenantDto) {
    return this.service.provisionTenant(body);
  }

  /**
   * 90-day retention hard delete (onboarding v1, decision Q4). Called by
   * onboard-api's lifecycle cron; the eligibility guards are re-verified
   * HERE (canceled ≥90d, no deletion hold, self-serve tenant) so a buggy or
   * compromised caller can never delete an ineligible tenant.
   */
  @Post('tenants/:tenantId/hard-delete')
  @HttpCode(200)
  hardDelete(@Param('tenantId', new ParseUUIDPipe()) tenantId: string) {
    return this.service.hardDeleteExpiredTenant(tenantId);
  }
}
