import { BadRequestException, Body, Controller, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';
import { isLegislativeDocumentTool } from './legislative-document-action.contract.js';
import { LegislativeDocumentActionService } from './legislative-document-action.service.js';
function toolFrom(body: unknown): string {
  const value = (body as { tool?: unknown } | null)?.tool;
  if (!isLegislativeDocumentTool(typeof value === 'string' ? value : ''))
    throw new BadRequestException('Invalid legislative document effect');
  return value as string;
}
@Controller('clio/tools')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class LegislativeDocumentActionController {
  constructor(private readonly owner: LegislativeDocumentActionService) {}
  @Post('prepare_legislative_document_proposal')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  prepare(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertMeriToolAllowed(toolFrom(body));
    return withMeriToolRequestControl(req, () => this.owner.prepare(ctx, req, body));
  }
  @Post('read_legislative_document_proposal')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return withMeriToolRequestControl(req, () => this.owner.read(ctx, req, body));
  }
  @Post('decide_legislative_document')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  decide(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    assertMeriToolAllowed(toolFrom(body));
    return withMeriToolRequestControl(req, () => this.owner.decide(ctx, req, body));
  }
}
