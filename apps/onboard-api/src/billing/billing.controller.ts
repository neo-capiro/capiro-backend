/**
 * Billing endpoints (/onboard-api/billing). Every route is gated by
 * BillingActorGuard: capiro_admin or a user_admin with billing_admin — the
 * Gherkin "Super Admin". Non-billing-admins get an opaque 403 (billing is
 * entirely hidden from them, incl. these URLs).
 */
import { Body, Controller, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MIN_CLIENT_SLOTS } from '@capiro/shared';
import type { Request } from 'express';
import {
  BillingActorGuard,
  CurrentBillingActor,
  type BillingActor,
} from '../auth/billing-actor.guard.js';
import { CapiroAdminGuard } from '../auth/capiro-admin.guard.js';
import { BillingService } from './billing.service.js';

class CheckoutDto {
  @Type(() => Number)
  @IsInt()
  @Min(MIN_CLIENT_SLOTS)
  @Max(100_000)
  quantity!: number;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  promoCode?: string;
}

class CompDto {
  @IsBoolean()
  comped!: boolean;
}

@Controller('billing')
@UseGuards(BillingActorGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Start a Checkout flow to subscribe or add slots; returns a hosted URL. */
  @Post('checkout')
  checkout(@CurrentBillingActor() actor: BillingActor, @Body() body: CheckoutDto) {
    return this.billing.createCheckoutSession(actor, {
      quantity: body.quantity,
      promoCode: body.promoCode,
    });
  }

  /** Open the Stripe Customer Portal (manage payment, change quantity, invoices). */
  @Post('portal')
  portal(@CurrentBillingActor() actor: BillingActor) {
    return this.billing.createPortalSession(actor);
  }
}

/** Cross-tenant staff actions (comp toggle) — capiro_admin only. */
@Controller('admin/billing')
@UseGuards(CapiroAdminGuard)
export class BillingAdminController {
  constructor(private readonly billing: BillingService) {}

  @Post('tenants/:tenantId/comp')
  comp(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() body: CompDto,
    @Req() req: Request & { capiroAdmin?: { clerkUserId: string } },
  ) {
    return this.billing.setComped(tenantId, body.comped, req.capiroAdmin?.clerkUserId);
  }
}
