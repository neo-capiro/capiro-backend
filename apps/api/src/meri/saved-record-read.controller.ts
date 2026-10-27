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
  ToolServiceSecretGuard,
  hasVerifiedToolServiceIdentity,
} from './tool-service-secret.guard.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';
import { SavedRecordReadService } from './saved-record-read.service.js';

@Controller('clio/tools')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class SavedRecordReadController {
  constructor(private readonly owner: SavedRecordReadService) {}

  @Post('read_saved_record')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    assertMeriToolAllowed('read_saved_record');
    if (!hasVerifiedToolServiceIdentity(req))
      throw new ForbiddenException('Internal service required');
    return withMeriToolRequestControl(req, () => this.owner.read(ctx, body, req));
  }
}
