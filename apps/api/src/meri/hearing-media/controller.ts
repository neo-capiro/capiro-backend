import {
  Body,
  Controller,
  ForbiddenException,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import {
  ToolServiceSecretGuard,
  hasVerifiedToolServiceIdentity,
} from '../../auth/tool-service-secret.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MeriToolsService } from '../meri-tools.service.js';
import { withMeriToolRequestControl } from '../meri-tool-request-control.js';
import { readSavedHearingMedia } from './read.js';

@Controller('clio/conversations/hearing-media')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class HearingMediaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: MeriToolsService,
  ) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    if (!hasVerifiedToolServiceIdentity(req))
      throw new ForbiddenException('Verified service identity required');
    return withMeriToolRequestControl(req, () =>
      readSavedHearingMedia(this.prisma, this.tools, ctx, body),
    );
  }
}
