import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../../../tenant/current-tenant.decorator.js';
import {
  parseOperationalCommand,
  parseOperationalReadQuery,
  parseOperationalReceiptQuery,
} from './objective-operational.rules.js';
import { ObjectiveOperationalService } from './objective-operational.service.js';
import { ObjectiveOperationalGuard } from './objective-operational.guard.js';

@Controller('clients/:clientId/objectives')
@UseGuards(ObjectiveOperationalGuard)
export class ObjectiveOperationalController {
  constructor(private readonly service: ObjectiveOperationalService) {}
  @Get('operational')
  @Header('Cache-Control', 'private, no-store')
  read(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Query() query: unknown,
  ) {
    return this.service.read(ctx, parseOperationalReadQuery(clientId, query));
  }
  @Post('operational-associations')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  command(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: unknown,
  ) {
    return this.service.command(ctx, parseOperationalCommand(body, clientId));
  }
  @Get('operational-associations/:requestId')
  @Header('Cache-Control', 'private, no-store')
  receipt(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('requestId') requestId: string,
    @Query() query: unknown,
  ) {
    return this.service.receipt(ctx, parseOperationalReceiptQuery(clientId, requestId, query));
  }
}
