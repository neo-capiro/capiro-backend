import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ClientFileBatchService } from './client-file-batch.service.js';

@Controller('clients/:clientId/files/batch-moves')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientFileBatchController {
  constructor(private readonly service: ClientFileBatchService) {}
  @Post()
  @Header('Cache-Control', 'no-store')
  move(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() body: unknown,
  ) {
    return this.service.move(ctx, clientId, body);
  }
  @Get(':requestId')
  @Header('Cache-Control', 'no-store')
  receipt(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.service.receipt(ctx, clientId, requestId);
  }
}
