import { Body, Controller, Header, HttpCode, Module, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { ApplicationAuthorityModule } from '../../auth/application-authority.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { MERI_ROUTINE_CANCEL_SIGNER, MeriRoutinesService } from './meri-routines.service.js';

/**
 * DRAFT item 5 routes (docs/integration/MERI-ROUTINES-POLICY-AND-CANCELLATION-DRAFT.md).
 * NOT MOUNTED: `MeriRoutinesModule` is deliberately absent from AppModule until
 * R0/laneB review lands. HTTP 200 only (Meri's readers refuse anything else).
 */
@Controller('clio/routines')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class MeriRoutinesController {
  constructor(private readonly routines: MeriRoutinesService) {}

  @Post('policy/check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  policyCheck(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.routines.policyCheck(req, ctx, body);
  }

  @Post('cancellation-proof')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancellationProof(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.routines.cancellationProof(req, ctx, body);
  }
}

@Module({
  imports: [PrismaModule, ApplicationAuthorityModule],
  controllers: [MeriRoutinesController],
  providers: [
    MeriRoutinesService,
    ToolServiceSecretGuard,
    // No key exists; the deployment packet supplies a CoreEd25519Signer.
    { provide: MERI_ROUTINE_CANCEL_SIGNER, useValue: null },
  ],
})
export class MeriRoutinesModule {}
