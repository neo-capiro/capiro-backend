/**
 * Flow-1 funnel endpoints (/onboard-api/funnel/*). Every route is gated by
 * ClerkUserGuard — an authenticated but ORG-LESS Clerk user (the purchaser).
 * No tenant context exists yet; all data hangs off onboard_purchaser /
 * onboard_session until the provisioning bridge creates the tenant.
 */
import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Request } from 'express';
import { ClerkUserGuard, type PurchaserAuth } from '../auth/clerk-user.guard.js';
import { CurrentPurchaser } from '../auth/current-purchaser.decorator.js';
import { FunnelService } from './funnel.service.js';
import { ProvisioningService } from './provisioning.service.js';

class RegisterDto {
  @IsString()
  @Length(1, 100)
  firstName!: string;

  @IsString()
  @Length(1, 100)
  lastName!: string;

  @IsString()
  @Length(2, 200)
  orgName!: string;
}

class PlanDto {
  @IsIn(['trial', 'paid'])
  plan!: 'trial' | 'paid';
}

class LegalAcceptDto {
  @IsString()
  @Length(1, 64)
  tosVersion!: string;

  @IsString()
  @Length(1, 64)
  saVersion!: string;
}

class SetupIntentDto {
  @IsIn(['card', 'ach'])
  method!: 'card' | 'ach';
}

class PayMethodDto {
  @IsIn(['card', 'ach', 'wire'])
  method!: 'card' | 'ach' | 'wire';

  /** Wire only: invoice recipient when it differs from the account email. */
  @IsOptional()
  @IsEmail()
  billingContact?: string;

  /**
   * Card/ACH: the SetupIntent the CLIENT actually confirmed. The server
   * stores only the latest-created intent id, which can be a different
   * (never-confirmed) one after tab switching — validating the client's id
   * closes that mismatch.
   */
  @IsOptional()
  @IsString()
  @Length(1, 128)
  setupIntentId?: string;
}

class SubscribeDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  profiles!: number;

  @IsIn(['card', 'ach', 'wire'])
  method!: 'card' | 'ach' | 'wire';

  /** Wire only: invoice recipient when it differs from the account email. */
  @IsOptional()
  @IsEmail()
  billingContact?: string;
}

class RoleDesignationDto {
  @IsEmail()
  email!: string;

  @IsIn(['super', 'admin'])
  role!: 'super' | 'admin';

  @IsOptional()
  @IsString()
  @Length(1, 100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  lastName?: string;
}

class RolesDto {
  @IsIn(['self', 'invite'])
  roleMode!: 'self' | 'invite';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoleDesignationDto)
  designations?: RoleDesignationDto[];
}

class ImportPrefDto {
  @IsIn(['self', 'managed'])
  importMode!: 'self' | 'managed';
}

class AddressDto {
  @IsString()
  @Length(1, 200)
  street!: string;

  @IsString()
  @Length(1, 100)
  city!: string;

  @IsString()
  @Length(1, 50)
  state!: string;

  @IsString()
  @Length(1, 20)
  zip!: string;
}

class OrgProfileDto {
  @IsString()
  @Length(2, 200)
  legalName!: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  vertical?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  teamSize?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  timezone?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  locale?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;
}

class OrgDto {
  @IsObject()
  @ValidateNested()
  @Type(() => OrgProfileDto)
  orgProfile!: OrgProfileDto;

  @IsOptional()
  @IsEmail()
  itAdminEmail?: string;
}

/** First hop of x-forwarded-for (ALB), falling back to the socket address. */
function clientIp(req: Request): string | null {
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[0] : header;
  const firstHop = raw?.split(',')[0]?.trim();
  return firstHop || req.ip || null;
}

@Controller('funnel')
@UseGuards(ClerkUserGuard)
export class FunnelController {
  constructor(
    private readonly funnel: FunnelService,
    private readonly provisioning: ProvisioningService,
  ) {}

  @Post('register')
  @HttpCode(200)
  register(@CurrentPurchaser() auth: PurchaserAuth, @Body() body: RegisterDto) {
    return this.funnel.register(auth, body);
  }

  @Get('session')
  session(@CurrentPurchaser() auth: PurchaserAuth) {
    return this.funnel.getSession(auth);
  }

  @Post('verify-check')
  @HttpCode(200)
  verifyCheck(@CurrentPurchaser() auth: PurchaserAuth) {
    return this.funnel.verifyCheck(auth);
  }

  @Post('plan')
  @HttpCode(200)
  plan(@CurrentPurchaser() auth: PurchaserAuth, @Body() body: PlanDto) {
    return this.funnel.selectPlan(auth, body.plan);
  }

  @Get('legal')
  legal(@CurrentPurchaser() auth: PurchaserAuth) {
    return this.funnel.getLegalDocs(auth);
  }

  @Post('legal-accept')
  @HttpCode(200)
  legalAccept(
    @CurrentPurchaser() auth: PurchaserAuth,
    @Body() body: LegalAcceptDto,
    @Req() req: Request,
  ) {
    return this.funnel.acceptLegal(auth, body, {
      ip: clientIp(req),
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
  }

  @Post('payment/setup-intent')
  @HttpCode(200)
  setupIntent(@CurrentPurchaser() auth: PurchaserAuth, @Body() body: SetupIntentDto) {
    return this.funnel.createSetupIntent(auth, body.method);
  }

  @Post('payment/trial-complete')
  @HttpCode(200)
  trialComplete(@CurrentPurchaser() auth: PurchaserAuth, @Body() body: PayMethodDto) {
    return this.funnel.trialComplete(auth, body.method, {
      billingContact: body.billingContact,
      setupIntentId: body.setupIntentId,
    });
  }

  @Post('payment/subscribe')
  @HttpCode(200)
  subscribe(@CurrentPurchaser() auth: PurchaserAuth, @Body() body: SubscribeDto) {
    return this.funnel.subscribe(auth, body);
  }

  @Post('payment/paid-status')
  @HttpCode(200)
  paidStatus(@CurrentPurchaser() auth: PurchaserAuth) {
    return this.funnel.paidStatus(auth);
  }

  @Post('roles')
  @HttpCode(200)
  roles(@CurrentPurchaser() auth: PurchaserAuth, @Body() body: RolesDto) {
    return this.funnel.setRoles(auth, body);
  }

  @Post('import-pref')
  @HttpCode(200)
  importPref(@CurrentPurchaser() auth: PurchaserAuth, @Body() body: ImportPrefDto) {
    return this.funnel.setImportPref(auth, body.importMode);
  }

  @Post('org')
  @HttpCode(200)
  org(@CurrentPurchaser() auth: PurchaserAuth, @Body() body: OrgDto) {
    return this.funnel.setOrg(auth, body);
  }

  @Post('provision')
  @HttpCode(200)
  provision(@CurrentPurchaser() auth: PurchaserAuth) {
    return this.provisioning.provision(auth);
  }

  @Get('status')
  status(@CurrentPurchaser() auth: PurchaserAuth) {
    return this.funnel.getStatus(auth);
  }
}
