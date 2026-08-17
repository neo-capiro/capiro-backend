import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsString, IsInt, Min, IsOptional } from 'class-validator';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { BrandAssetService } from './brand-asset.service.js';

/** Register a brand asset after S3 upload. */
export class RegisterBrandAssetDto {
  @IsString() objectKey!: string;
  @IsString() filename!: string;
  @IsString() mimeType!: string;
  @IsInt() @Min(0) sizeBytes!: number;
  @IsString() url!: string;
}

/** Optional query for listing assets scoped to a theme version. */
export class ListBrandAssetsDto {
  @IsOptional() @IsString() themeVersionId?: string;
}

/**
 * Brand Asset Controller — firm mark / logo upload registration (GAPS §16).
 * The client uploads to S3 via the existing presigned-URL pipeline, then
 * registers the asset here. Mounted under /workspace-api/template-studio/assets.
 */
@Controller('template-studio/assets')
@UseGuards(TenantGuard)
export class BrandAssetController {
  constructor(private readonly brandAsset: BrandAssetService) {}

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.brandAsset.list(ctx.tenantId);
  }

  @Post()
  register(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() dto: RegisterBrandAssetDto,
  ) {
    return this.brandAsset.register(ctx.tenantId, ctx.clerkUserId, dto);
  }

  @Delete(':assetId')
  remove(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('assetId') assetId: string,
  ) {
    return this.brandAsset.remove(ctx.tenantId, assetId);
  }
}
