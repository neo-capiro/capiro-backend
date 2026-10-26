import { Body, Controller, Delete, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { BrandAssetService } from './brand-asset.service.js';

/** The existing engagement upload + confirm flow owns bytes and scanning. */
export class RegisterBrandAssetDto {
  @IsUUID() attachmentId!: string;
}

@Controller('template-studio/assets')
@UseGuards(TenantGuard)
export class BrandAssetController {
  constructor(private readonly brandAsset: BrandAssetService) {}

  @Get()
  list(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.brandAsset.list(ctx.tenantId, authorization);
  }

  @Post()
  register(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() dto: RegisterBrandAssetDto,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.brandAsset.register(ctx.tenantId, ctx.clerkUserId, dto.attachmentId, authorization);
  }

  @Get('uploads')
  uploads(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.brandAsset.listUploads(ctx.tenantId, authorization);
  }

  @Delete(':assetId')
  remove(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('assetId') assetId: string) {
    return this.brandAsset.remove(ctx.tenantId, assetId);
  }
}
