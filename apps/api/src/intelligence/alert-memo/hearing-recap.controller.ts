import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { HearingRecapService } from './hearing-recap.service.js';

export class SaveHearingRecapDto {
  @IsString() @MaxLength(128) sessionId!: string;
  @IsString() @MaxLength(300) title!: string;
  @IsString() @MinLength(1) markdown!: string;
  @IsString() @MaxLength(300) clientName!: string;
  @IsOptional() @IsString() replaceAttachmentId?: string;
}

@Controller('intelligence')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class HearingRecapController {
  constructor(private readonly recaps: HearingRecapService) {}

  @Post('clients/:clientId/hearing-recaps')
  save(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: SaveHearingRecapDto,
  ) {
    return this.recaps.save(ctx, clientId, body);
  }
}
