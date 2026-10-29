import { Body, Controller, Header, HttpCode, Module, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { MemoryModule } from '../../memory/memory.module.js';
import { MeriMemoryReceivingService } from './meri-memory-receiving.service.js';

/** Fixed Meri routes (`apps/control/memory/core-http.mjs` CORE_MEMORY_ROUTES).
 * Meri's JSON reader accepts HTTP 200 only, so every route pins it. */
@Controller('clio/memory')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class MeriMemoryReceivingController {
  constructor(private readonly memory: MeriMemoryReceivingService) {}

  @Post('review/submit')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  submit(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.memory.submit(req, ctx, body);
  }

  @Post('review/status')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  status(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.memory.status(req, ctx, body);
  }

  @Post('read_target')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  readTarget(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.memory.readTarget(req, ctx, body);
  }

  @Post('find_by_key')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  findByKey(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.memory.findByKey(req, ctx, body);
  }
}

@Module({
  imports: [PrismaModule, MemoryModule],
  controllers: [MeriMemoryReceivingController],
  providers: [MeriMemoryReceivingService, ToolServiceSecretGuard],
  exports: [MeriMemoryReceivingService],
})
export class MeriMemoryReceivingModule {}
