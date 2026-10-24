import { Body, Controller, Header, HttpCode, Module, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { NativeApprovalService } from './native-approval.service.js';
import { NativeApprovalMetadataVerifier } from './native-approval-metadata.js';
import { NativeExecutionService } from './native-execution.service.js';
import { meriExecutionKeyConfigProvider, meriExecutionSignerProvider } from '../execution-capability/meri-execution-authority.js';
import { ApplicationAuthorityModule } from '../../auth/application-authority.module.js';

/** Bodies and receipts are the native provider operations `approval/record`
 * and `approval/decision` byte-for-byte; revoke also carries Meri's approver.
 * HTTP 200 only: Meri's native client refuses any other status. */
@Controller('clio/approvals/native')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class NativeApprovalController {
  constructor(private readonly approvals: NativeApprovalService, private readonly executions: NativeExecutionService) {}

  @Post('record')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  record(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.approvals.record(req, ctx, body);
  }

  @Post('decision')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  decision(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.approvals.decision(req, ctx, body);
  }

  /** Approver revocation (append-only; the decision stays immutable). */
  @Post('revoke')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  revoke(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.approvals.revoke(req, ctx, body);
  }

  /** Approved-execution capability issuance (D016 #9): Meri's decide route,
   * attended approver's native bearer + verified service identity. */
  @Post('execution')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  execution(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.executions.issue(req, ctx, body);
  }
}

@Module({
  imports: [PrismaModule, ApplicationAuthorityModule],
  controllers: [NativeApprovalController],
  providers: [
    NativeApprovalService, NativeApprovalMetadataVerifier, ToolServiceSecretGuard, NativeExecutionService,
    meriExecutionKeyConfigProvider, meriExecutionSignerProvider,
  ],
})
export class NativeApprovalModule {}
