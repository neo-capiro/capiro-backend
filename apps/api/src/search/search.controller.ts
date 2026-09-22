import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { SearchService } from './search.service.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import type { TenantContext } from '@capiro/shared';

class SearchQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  perSource?: number;
}

/**
 * Global keyword search for the top-bar search input. Read-only across the
 * shared federal reference datasets; any authenticated user may query it.
 */
@Controller('search')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  async globalSearch(@Query() query: SearchQueryDto, @CurrentTenant() tenant: TenantContext) {
    return this.search.search(query.q ?? '', query.perSource, tenant.tenantId);
  }
}
