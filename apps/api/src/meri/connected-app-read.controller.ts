import {
  Body,
  Controller,
  ForbiddenException,
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
} from './tool-service-secret.guard.js';
import { ConnectedAppReadService } from './connected-app-read.service.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';
import { assertMeriToolRequestActive } from './meri-tool-request-control.js';
import { MicrosoftGraphSyncService } from '../engagement/microsoft/microsoft-graph-sync.service.js';
import {
  TEAMS_READ_OPERATIONS,
  type TeamsReadOperation,
} from '../engagement/microsoft/microsoft-teams-contract.js';

@Controller('clio/tools')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class ConnectedAppReadController {
  constructor(
    private readonly owner: ConnectedAppReadService,
    private readonly teams: MicrosoftGraphSyncService,
  ) {}

  private receive(ctx: TenantContext, operation: string, body: unknown, req: Request) {
    assertMeriToolAllowed(operation);
    if (!hasVerifiedToolServiceIdentity(req))
      throw new ForbiddenException('Internal service required');
    return withMeriToolRequestControl(req, async () => {
      const result = (TEAMS_READ_OPERATIONS as readonly string[]).includes(operation)
        ? await this.teams.readTeams(ctx, operation as TeamsReadOperation, body)
        : await this.owner.read(ctx, operation, body);
      assertMeriToolRequestActive();
      return result;
    });
  }

  @Post('list_connected_app_reads')
  @HttpCode(200)
  list(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return this.receive(ctx, 'list_connected_app_reads', body, req);
  }

  @Post('read_connected_app')
  @HttpCode(200)
  read(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return this.receive(ctx, 'read_connected_app', body, req);
  }

  @Post('list_teams_channels')
  @HttpCode(200)
  channels(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return this.receive(ctx, 'list_teams_channels', body, req);
  }

  @Post('get_teams_channel_messages')
  @HttpCode(200)
  messages(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    return this.receive(ctx, 'get_teams_channel_messages', body, req);
  }
}
