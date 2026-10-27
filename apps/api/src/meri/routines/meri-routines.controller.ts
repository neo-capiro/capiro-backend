import { Body, Controller, Header, HttpCode, Logger, Module, Post, Req, UseGuards, type Provider } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { InternalServiceGuard } from '../../auth/internal-service.guard.js';
import { RetainedReadDispatcher } from '../retained-read-dispatch.js';
import { ApplicationAuthorityModule } from '../../auth/application-authority.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { MERI_ROUTINE_CANCEL_SIGNER, MERI_ROUTINE_FIRE_SIGNER, MeriRoutinesService } from './meri-routines.service.js';
import { createCoreKmsSigner, readCoreEd25519KeyConfig, type CoreEd25519Purpose } from '../../auth/core-ed25519-kms-config.js';

/**
 * Item 5 routes (docs/integration/MERI-ROUTINES-POLICY-AND-CANCELLATION-DRAFT.md),
 * mounted (D016 item 5 / D016-A item 5). Wires A and B are attended (native
 * session + verified service identity). HTTP 200 only (Meri's readers refuse
 * anything else). Each signer is 503 until its key configuration exists.
 */
@Controller('clio/routines')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class MeriRoutinesController {
  constructor(private readonly routines: MeriRoutinesService) {}

  @Post('management/current')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  managementCurrent(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.routines.managementCurrent(req, ctx, body);
  }

  @Post('management/policy/check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  managementPolicyCheck(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.routines.managementPolicyCheck(req, ctx, body);
  }

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

/**
 * Wire C (D016-A item 5): the unattended firing grant. The verified service
 * identity alone (no user session exists for an unattended occurrence); the
 * tenant middleware admits exactly this POST without a bearer and sets no
 * tenant context. No RolesGuard: the authority is the stored signed-in consent
 * and the owner's current membership, read by the service.
 */
@Controller('clio/routines')
@UseGuards(ToolServiceSecretGuard)
export class MeriRoutineFiringController {
  constructor(private readonly routines: MeriRoutinesService) {}

  @Post('unattended-grant')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  unattendedGrant(@Req() req: Request, @Body() body: unknown) {
    return this.routines.unattendedGrant(req, body);
  }
}

/** Control-only typed reads from the saved native routine and consent. */
@Controller('internal/routines')
@UseGuards(InternalServiceGuard)
export class MeriRoutineReadController {
  constructor(private readonly routines: MeriRoutinesService, private readonly reads: RetainedReadDispatcher) {}
  @Post('current') @HttpCode(200) @Header('Cache-Control', 'no-store')
  current(@Body() body: unknown, @Req() req: Request) { return this.routines.current(body, req); }
  @Post('reads') @HttpCode(200) @Header('Cache-Control', 'no-store')
  read(@Body() body: unknown, @Req() req: Request) { return this.routines.read(body, req, this.reads); }
}

/** One KMS Ed25519 signer per purpose, from its `<PURPOSE>_*` configuration; null (503) when absent or invalid. */
function routineSignerProvider(token: symbol, purpose: CoreEd25519Purpose): Provider {
  return {
    provide: token,
    useFactory: () => {
      try {
        const config = readCoreEd25519KeyConfig(process.env, purpose);
        return config ? createCoreKmsSigner(config) : null;
      } catch (error) {
        new Logger('MeriRoutines').error(`${purpose} disabled: ${(error as Error).message}`);
        return null;
      }
    },
  };
}

@Module({
  imports: [PrismaModule, ApplicationAuthorityModule],
  controllers: [MeriRoutinesController, MeriRoutineFiringController],
  providers: [
    MeriRoutinesService,
    ToolServiceSecretGuard,
    routineSignerProvider(MERI_ROUTINE_CANCEL_SIGNER, 'MERI_ROUTINE_CANCEL_SIGNER'),
    routineSignerProvider(MERI_ROUTINE_FIRE_SIGNER, 'MERI_ROUTINE_FIRE_SIGNER'),
  ],
  exports: [MeriRoutinesService],
})
export class MeriRoutinesModule {}
