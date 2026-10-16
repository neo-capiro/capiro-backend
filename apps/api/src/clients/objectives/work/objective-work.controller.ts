import { Body, Controller, Get, Header, HttpCode, HttpException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../../auth/roles.decorator.js';
import { RolesGuard } from '../../../auth/roles.guard.js';
import { CurrentTenant } from '../../../tenant/current-tenant.decorator.js';
import { ObjectiveWorkError, parseWorkCommand, parseWorkRead } from './objective-work-command.js';
import { ObjectiveWorkService } from './objective-work.service.js';

@Controller('clients/:clientId/objectives/:objectiveId/generation')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ObjectiveWorkController {
  constructor(private readonly service: ObjectiveWorkService) {}
  private async safe<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      const e = error instanceof ObjectiveWorkError ? error : new ObjectiveWorkError('AUTHORITY_UNAVAILABLE');
      const status = e.code === 'INVALID_REQUEST' ? 400 : e.code === 'NOT_AVAILABLE' ? 404
        : ['AUTHORITY_UNAVAILABLE', 'RECEIPT_UNVERIFIABLE'].includes(e.code) ? 503 : 409;
      throw new HttpException({ schemaVersion: 1, requestId: e.requestId, code: e.code }, status);
    }
  }
  @Post('commands')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  command(@CurrentTenant() ctx: TenantContext, @Req() req: Request,
    @Param('clientId') client: string, @Param('objectiveId') objective: string, @Body() body: unknown) {
    return this.safe(() => this.service.command(ctx, req, parseWorkCommand(client, objective, body)));
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: TenantContext, @Req() req: Request,
    @Param('clientId') client: string, @Param('objectiveId') objective: string, @Query() query: unknown) {
    return this.safe(() => this.service.read(ctx, req, parseWorkRead(client, objective, query)));
  }
}
