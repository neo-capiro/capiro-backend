import { MeriMemoryReceivingModule } from '../memory-receiving/meri-memory-receiving.controller.js';
import { Body, Controller, Header, HttpCode, Module, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
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
import { EngagementModule } from '../../engagement/engagement.module.js';
import { TenantModule } from '../../tenant/tenant.module.js';
import { MeriExecutionReceiverService } from '../execution-capability/meri-execution-receiver.service.js';
import { ClientDocumentsModule } from '../../client-documents/client-documents.module.js';
import { MeriClientFilingService } from '../meri-client-filing.service.js';

/** Bodies and receipts are the native provider operations `approval/record`
 * and `approval/decision` byte-for-byte; revoke also carries Meri's approver.
 * HTTP 200 only: Meri's native client refuses any other status. */
@Controller('clio/approvals/native')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class NativeApprovalController {
  constructor(private readonly approvals: NativeApprovalService, private readonly executions: NativeExecutionService,
    private readonly receiver: MeriExecutionReceiverService) {}

  @Post('execute')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  executeTask(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.receiver.nativeApproved(req, ctx, body, 'execute');
  }

  @Post('execution/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async readTask(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown,
    @Res() response: Response) {
    // Nest's ordinary null return becomes an empty body. The native reader
    // distinguishes canonical JSON null (no execution) from a malformed reply.
    return response.json(await this.receiver.nativeApproved(req, ctx, body, 'read'));
  }

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

  /** Browser consequential-action decision (SCRUM-222): the attended approver's
   * bearer authenticates the human and the retained preparation supplies the
   * subject; only its digest becomes the decision's commandSha256. */
  @Post('browser/record')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  browserRecord(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.approvals.recordBrowser(req, ctx, body);
  }

  /** ONE permissive answer, only for the transaction that inserts the fresh
   * CLAIMED row. Every repeat/restart/ambiguity answers a non-permissive readback. */
  @Post('browser/consume')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  browserConsume(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.approvals.consumeBrowser(req, ctx, body);
  }

  /** Status readback: retained decision/consumption facts, never a grant. */
  @Post('browser/status')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  browserStatus(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.approvals.statusBrowser(req, ctx, body);
  }

  /** Effect settlement: one CLAIMED row may complete once with the actual
   * browser result. A completion record is evidence, never permission. */
  @Post('browser/result')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  browserResult(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return this.approvals.resultBrowser(req, ctx, body);
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
  imports: [PrismaModule, ApplicationAuthorityModule, EngagementModule, TenantModule, ClientDocumentsModule, MeriMemoryReceivingModule],
  controllers: [NativeApprovalController],
  providers: [
    NativeApprovalService, NativeApprovalMetadataVerifier, ToolServiceSecretGuard, NativeExecutionService, MeriExecutionReceiverService, MeriClientFilingService,
    meriExecutionKeyConfigProvider, meriExecutionSignerProvider,
  ],
  exports: [MeriExecutionReceiverService, MeriClientFilingService],
})
export class NativeApprovalModule {}
