import { Body, Controller, ForbiddenException, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { ToolServiceSecretGuard, hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { checkPassiveMemoryEligibility } from './meri-passive-memory-source.js';
import { withMeriToolRequestControl, assertMeriToolRequestActive } from '../meri-tool-request-control.js';

/** Current eligibility for the exact page, authenticated by ordinary user and
 * verified service identity. Correlation hashes are data, not credentials. */
@Controller('clio/tools')
@UseGuards(ToolServiceSecretGuard)
export class MeriMemoryHelperController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('search_memory_eligibility')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  eligibility(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() req: Request) {
    if (!hasVerifiedToolServiceIdentity(req) || typeof req.headers.authorization !== 'string' ||
        !/^Bearer \S+$/i.test(req.headers.authorization)) throw new ForbiddenException('Passive memory helper refused');
    return withMeriToolRequestControl(req, async () => {
      const result = await checkPassiveMemoryEligibility(this.prisma, ctx, body);
      assertMeriToolRequestActive();
      return result;
    });
  }
}
