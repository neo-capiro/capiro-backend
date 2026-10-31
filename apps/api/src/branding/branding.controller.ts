import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { IsIn, IsInt, IsString, Max, Min } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { BrandingService } from './branding.service.js';

class UploadUrlDto {
  @IsString()
  @IsIn(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'])
  contentType!: 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'image/webp';

  @IsInt()
  @Min(1)
  @Max(2 * 1024 * 1024)
  contentLength!: number;
}

class ConfirmUploadDto {
  @IsString()
  s3Key!: string;

  @IsString()
  @IsIn(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'])
  contentType!: 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'image/webp';
}

@Controller('tenant-admin/branding')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class BrandingController {
  constructor(private readonly service: BrandingService) {}

  @Get()
  get(@CurrentTenant() ctx: TenantContext) {
    return this.service.getBranding(ctx);
  }

  /**
   * M1 (firm half): stable, session-authenticated firm-logo bytes, mirroring the accepted
   * client-logo route. The app's branding payload must not carry a presigned S3 URL, so the
   * image stops embedding temporary AWS credentials and stops expiring after five minutes.
   */
  @Get('logo')
  async logo(@CurrentTenant() ctx: TenantContext, @Res() res: Response) {
    const logo = await this.service.readLogo(ctx);
    res.setHeader('Content-Type', logo.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(logo.body);
  }

  @Post('logo/upload-url')
  @Roles('user_admin')
  uploadUrl(@CurrentTenant() ctx: TenantContext, @Body() body: UploadUrlDto) {
    return this.service.createLogoUploadUrl(ctx, body.contentType, body.contentLength);
  }

  @Post('logo/confirm')
  @Roles('user_admin')
  confirm(@CurrentTenant() ctx: TenantContext, @Body() body: ConfirmUploadDto) {
    return this.service.confirmLogoUpload(ctx, body.s3Key, body.contentType);
  }
}
