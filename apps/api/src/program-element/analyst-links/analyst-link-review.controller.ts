import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { AnalystLinkReviewService } from './analyst-link-review.service.js';

class ReviewQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
class ReviewDecision {
  @IsUUID() requestId!: string;
  @Matches(/^[a-f0-9]{64}$/) expectedVersion!: string;
  @IsIn(['accept', 'reject']) decision!: 'accept' | 'reject';
  @IsString() @Length(1, 4000) reason!: string;
}
@Controller('capiro-admin/analyst-links')
@UseGuards(RolesGuard)
@Roles('capiro_admin')
export class AnalystLinkReviewController {
  constructor(private readonly service: AnalystLinkReviewService) {}
  @Get('receipts/:requestId')
  @Header('Cache-Control', 'no-store')
  receipt(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.service.receipt(ctx, req, requestId);
  }
  @Get(':kind')
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Param('kind') kind: string,
    @Query() query: ReviewQuery,
  ) {
    return this.service.list(ctx, req, kind, query);
  }
  @Get(':kind/:id')
  @Header('Cache-Control', 'no-store')
  detail(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Param('kind') kind: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.detail(ctx, req, kind, id);
  }
  @Post(':kind/:id/decision')
  @Header('Cache-Control', 'no-store')
  decide(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Param('kind') kind: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewDecision,
  ) {
    return this.service.decide(ctx, req, kind, id, body);
  }
}
