import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ImpersonationService } from './impersonation.service.js';

class StartDto {
  @IsUUID() requestId!: string;
  @IsUUID() tenantId!: string;
  @IsString() @Length(10, 500) reason!: string;
}
class EndDto {
  @IsUUID() sessionId!: string;
}
class WorkspaceQuery {
  @IsOptional() @IsUUID() after?: string;
}

@Controller('capiro-admin/impersonate')
@UseGuards(RolesGuard)
@Roles('capiro_admin')
export class ImpersonationController {
  constructor(private readonly service: ImpersonationService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  active(@CurrentTenant() ctx: TenantContext, @Req() req: Request) {
    return this.service.active(ctx, req);
  }
  @Post()
  @Header('Cache-Control', 'no-store')
  start(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: StartDto) {
    return this.service.start(ctx, req, body);
  }
  @Get(':sessionId')
  @Header('Cache-Control', 'no-store')
  read(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Param('sessionId', ParseUUIDPipe) id: string,
  ) {
    return this.service.read(ctx, req, id);
  }
  @Post('end')
  @Header('Cache-Control', 'no-store')
  end(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: EndDto) {
    return this.service.end(ctx, req, body.sessionId);
  }
  @Get(':sessionId/workspace')
  @Header('Cache-Control', 'no-store')
  workspace(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Param('sessionId', ParseUUIDPipe) id: string,
    @Query() query: WorkspaceQuery,
  ) {
    return this.service.workspace(ctx, req, id, query.after);
  }
}
