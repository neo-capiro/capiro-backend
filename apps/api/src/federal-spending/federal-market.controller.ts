import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { FederalMarketGeographyService } from './federal-market-geography.service.js';
import type { FederalMarketQuery } from './federal-market.types.js';
import { FederalMarketService } from './federal-market.service.js';

class FederalMarketQueryDto implements FederalMarketQuery {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  agency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  recipient?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/)
  state?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(?:[0-9]{1,2}|00|AL)$/i)
  district?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2200)
  fiscalYear?: number;

  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

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
  pageSize?: number;
}

/**
 * One local, normalized federal-market read surface.
 *
 * No route calls MakeGov/Tango. Provider-backed rows were synchronized into
 * local tables first, so an upstream outage makes them visibly stale rather
 * than taking this API down. Client-scoped filters resolve only reviewed
 * identities inside the authenticated tenant.
 */
@Controller('federal-spending/market')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class FederalMarketController {
  constructor(
    private readonly market: FederalMarketService,
    private readonly geographyMarket: FederalMarketGeographyService,
  ) {}

  @Get('contracts')
  contracts(@CurrentTenant() ctx: TenantContext, @Query() query: FederalMarketQueryDto) {
    return this.market.listContracts(ctx.tenantId, query);
  }

  @Get('subawards')
  subawards(@CurrentTenant() ctx: TenantContext, @Query() query: FederalMarketQueryDto) {
    return this.market.listSubawards(ctx.tenantId, query);
  }

  @Get('vehicles')
  vehicles(@CurrentTenant() ctx: TenantContext, @Query() query: FederalMarketQueryDto) {
    return this.market.listVehicles(ctx.tenantId, query);
  }

  @Get('forecasts')
  forecasts(@Query() query: FederalMarketQueryDto) {
    // Forecasts are global public catalog facts. `clientId` is ignored here on
    // purpose rather than used as a pretend match; client matching belongs to
    // Funding Opportunities' deterministic recommendation service.
    const { clientId: _clientId, ...globalQuery } = query;
    return this.market.listForecasts(globalQuery);
  }

  @Get('geography')
  geography(@CurrentTenant() ctx: TenantContext, @Query() query: FederalMarketQueryDto) {
    return this.geographyMarket.geography(ctx.tenantId, query);
  }
}
