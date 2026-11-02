import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  readMemoryCleanupRestriction,
  readMemoryRetentionPolicy,
} from './memory-retention-policy.js';

@Controller('memory/retention-policy')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MemoryRetentionPolicyController {
  constructor(private readonly prisma: PrismaService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: TenantContext) {
    return readMemoryRetentionPolicy(this.prisma, ctx);
  }

  @Get('cleanup-restriction')
  @Header('Cache-Control', 'private, no-store')
  cleanupRestriction(@CurrentTenant() ctx: TenantContext) {
    return readMemoryCleanupRestriction(this.prisma, ctx);
  }
}
