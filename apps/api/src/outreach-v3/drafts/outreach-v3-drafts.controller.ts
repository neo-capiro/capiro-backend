import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import {
  OutreachDraftService,
  type DraftEditKind,
} from '../../engagement/outreach-draft.service.js';
import { OutreachV3ExceptionFilter } from '../api/outreach-v3-exception.filter.js';
import { OutreachV3StateGuard } from '../api/outreach-v3-state.guard.js';
import { OutreachV3DraftApprovalService } from './outreach-v3-draft-approval.service.js';
import { OutreachV3DraftsGuard } from './outreach-v3-drafts.guard.js';

@Controller('engagement/outreach-v3/sessions/:sessionId/drafts')
@UseGuards(OutreachV3StateGuard, OutreachV3DraftsGuard, RolesGuard)
@UseFilters(OutreachV3ExceptionFilter)
@Roles('standard_user')
export class OutreachV3DraftsController {
  constructor(
    private readonly approvals: OutreachV3DraftApprovalService,
    private readonly drafts: OutreachDraftService,
  ) {}

  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.drafts.listForOutreach(ctx, sessionId);
  }

  @Get(':versionId')
  async getVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    const version = await this.drafts.getVersion(ctx, versionId);
    if (version.outreachRecordId !== sessionId) {
      throw new NotFoundException('Draft version not found.');
    }
    return version;
  }

  @Post(':artifactId/versions')
  async revise(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('artifactId', ParseUUIDPipe) artifactId: string,
    @Body() body: unknown,
  ) {
    // Validate campaign ownership before any append-only write. A same-user
    // artifact from another campaign must not receive a new version and then
    // fail only after the fact.
    const artifacts = await this.drafts.listForOutreach(ctx, sessionId);
    if (!artifacts.some((artifact) => artifact.id === artifactId)) {
      throw new NotFoundException('Draft artifact not found.');
    }
    return this.drafts.createEditedVersion(ctx, artifactId, revisionBody(body));
  }

  /** Human-only exact-version author approval. */
  @Post(':versionId/approval')
  approveVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    return this.approvals.approve(ctx, sessionId, versionId);
  }
}

function revisionBody(value: unknown): {
  baseVersionId: string;
  subject: string;
  body: string;
  editKind: DraftEditKind;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Request body must be an object.');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(['baseVersionId', 'subject', 'body', 'editKind']);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new BadRequestException('Request body contains an unsupported field.');
  }
  if (
    typeof record.baseVersionId !== 'string' ||
    typeof record.subject !== 'string' ||
    typeof record.body !== 'string'
  ) {
    throw new BadRequestException('baseVersionId, subject, and body are required.');
  }
  if (
    record.editKind !== undefined &&
    !['manual', 'improve', 'revert'].includes(String(record.editKind))
  ) {
    throw new BadRequestException('editKind must be manual, improve, or revert.');
  }
  const editKind = (record.editKind ?? 'manual') as DraftEditKind;
  return {
    baseVersionId: record.baseVersionId.trim(),
    subject: record.subject,
    body: record.body,
    editKind,
  };
}
