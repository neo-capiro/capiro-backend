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
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import {
  hasVerifiedToolServiceIdentity,
  ToolServiceSecretGuard,
} from '../auth/tool-service-secret.guard.js';
import { MeriChatAttachmentSourceService } from './meri-chat-attachment-source.js';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';

@Controller('clio/attachments')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class MeriChatAttachmentSourceController {
  constructor(private readonly source: MeriChatAttachmentSourceService) {}

  @Post('read-context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  context(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.execute(ctx, req, body, false);
  }

  @Post('read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  read(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.execute(ctx, req, body, true);
  }

  private execute(ctx: TenantContext, req: Request, body: unknown, read: boolean) {
    if (!hasVerifiedToolServiceIdentity(req))
      throw new ForbiddenException('Verified attachment service identity required');
    return withMeriToolRequestControl(req, () => this.source.execute(ctx, req, body, read));
  }
}
