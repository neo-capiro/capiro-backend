import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  TenantContext,
  CreateResearchPortfolioDto,
  CreateResearchPortfolioMemberDto,
  CreateResearchPortfolioClientLinkDto,
  DecideResearchPortfolioMembersDto,
  PutResearchPortfolioGrantDto,
  ChangeResearchPortfolioLifecycleDto,
  UpdateResearchPortfolioDto,
  ResearchPortfolioListResponseDto,
  ResearchPortfolioDetailDto,
  ResearchPortfolioGrantDto,
  ResearchPortfolioClientLinkDto,
  ResearchPortfolioMutationReceiptDto,
  ResearchPortfolioMutationMetaDto,
  ResearchPortfolioMemberDto,
  ResolveResearchPortfolioMemberDto,
  PreviewResearchPortfolioRuleDto,
  PublishResearchPortfolioRuleDto,
  CreateResearchPortfolioTemplateDto,
  CreateResearchPortfolioTemplateVersionDto,
  ResearchPortfolioRulePreviewDto,
  ResearchPortfolioRuleVersionDto,
  ResearchPortfolioTemplateDto,
  ResearchPortfolioTemplateVersionDto,
  ResearchTaxonomyVersionDto,
  AssignResearchPortfolioReviewDto,
  DecideResearchPortfolioReviewDto,
  BulkResearchPortfolioReviewsDto,
  ReopenResearchPortfolioAnnualReviewDto,
  ResearchPortfolioAnnualReviewDto,
  ResearchPortfolioReviewDto,
  ResearchPortfolioReviewMutationReceiptDto,
  CreateResearchPortfolioImportDto,
  ResearchPortfolioImportActionDto,
  ResearchPortfolioImportDetailDto,
  ResearchPortfolioImportJobDto,
  CreateResearchPortfolioSubscriptionDto,
  UpdateResearchPortfolioSubscriptionDto,
  UpdateResearchPortfolioEventStateDto,
  ResearchPortfolioChangeDto,
  ResearchPortfolioEventRecipientStateDto,
  ResearchPortfolioSubscriptionDto,
  ResearchPortfolioSubscriptionDeliveryDto,
  ResearchPortfolioAnalyticsDto,
  CreateResearchPortfolioSnapshotDto,
  ResearchPortfolioSnapshotDto,
  ResearchPortfolioSnapshotSummaryDto,
  CreateResearchPortfolioOutputDto,
  ResearchPortfolioOutputJobDto,
  SaveResearchPortfolioOutputToClientDto,
  ResearchPortfolioClientFileReceiptDto,
  CreateResearchPortfolioBookmarkDto,
  UpdateResearchPortfolioBookmarkDto,
  ResearchPortfolioBookmarkDto,
  ResearchPortfolioFitDto,
  CreateResearchPortfolioReviewNoteDto,
  ResearchPortfolioReviewNoteDto,
  ResearchPortfolioWatchConversionPreviewDto,
  ResearchPortfolioWatchConversionResultDto,
  ResearchPortfolioOperationDto,
  ResearchPortfolioTourStateDto,
} from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ResearchPortfoliosService } from './research-portfolios.service.js';
import { ResearchPortfolioRulesService } from './research-portfolio-rules.service.js';
import { ResearchPortfolioReviewService } from './research-portfolio-review.service.js';
import { ResearchPortfolioImportService } from './research-portfolio-import.service.js';
import { ResearchPortfolioChangesService } from './research-portfolio-changes.service.js';
import { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';
import { ResearchPortfolioOutputService } from './research-portfolio-output.service.js';
import { ResearchPortfolioPhase11Service } from './research-portfolio-phase11.service.js';

const RESERVED_STATIC_IDS = new Set(['templates', 'taxonomy', 'tour-state']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ensurePortfolioId(id: string): void {
  if (RESERVED_STATIC_IDS.has(id) || !UUID.test(id)) {
    throw new NotFoundException('Research portfolio not found');
  }
}

@Controller('research-portfolios')
@UseGuards(RolesGuard)
@Roles('standard_user', 'user_admin', 'capiro_admin')
export class ResearchPortfoliosController {
  constructor(
    private readonly service: ResearchPortfoliosService,
    private readonly rules: ResearchPortfolioRulesService,
    private readonly reviewService: ResearchPortfolioReviewService,
    private readonly importService: ResearchPortfolioImportService,
    private readonly changesService: ResearchPortfolioChangesService,
    private readonly analyticsService: ResearchPortfolioAnalyticsService,
    private readonly outputService: ResearchPortfolioOutputService,
    private readonly phase11: ResearchPortfolioPhase11Service,
  ) {}

  @Get(':id/changes')
  async changes(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: readonly ResearchPortfolioChangeDto[]; nextCursor: string | null }> {
    ensurePortfolioId(id);
    const parsed = limit ? Number.parseInt(limit, 10) : 50;
    return this.changesService.listChanges(ctx, id, cursor ?? null, Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50);
  }

  @Patch(':id/changes/:eventId/state')
  async updateChangeState(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Body() dto: UpdateResearchPortfolioEventStateDto,
  ): Promise<ResearchPortfolioEventRecipientStateDto> {
    ensurePortfolioId(id);
    return this.changesService.updateEventState(ctx, id, eventId, dto);
  }

  @Get(':id/subscriptions')
  async subscriptions(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<readonly ResearchPortfolioSubscriptionDto[]> {
    ensurePortfolioId(id);
    return this.changesService.listSubscriptions(ctx, id);
  }

  @Get(':id/subscription-deliveries')
  async subscriptionDeliveries(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<readonly ResearchPortfolioSubscriptionDeliveryDto[]> {
    ensurePortfolioId(id);
    return this.changesService.listDeliveries(ctx, id);
  }

  @Post(':id/subscriptions')
  async createSubscription(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateResearchPortfolioSubscriptionDto,
  ): Promise<ResearchPortfolioSubscriptionDto> {
    ensurePortfolioId(id);
    return this.changesService.createSubscription(ctx, id, dto);
  }

  @Patch(':id/subscriptions/:subscriptionId')
  async updateSubscription(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('subscriptionId') subscriptionId: string,
    @Body() dto: UpdateResearchPortfolioSubscriptionDto,
  ): Promise<ResearchPortfolioSubscriptionDto> {
    ensurePortfolioId(id);
    return this.changesService.updateSubscription(ctx, id, subscriptionId, dto);
  }

  @Get(':id/analytics')
  async analytics(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<ResearchPortfolioAnalyticsDto> {
    ensurePortfolioId(id);
    return this.analyticsService.analytics(ctx, id);
  }

  @Get(':id/snapshots')
  async snapshots(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<readonly ResearchPortfolioSnapshotSummaryDto[]> {
    ensurePortfolioId(id);
    return this.analyticsService.listSnapshots(ctx, id);
  }

  @Post(':id/snapshots')
  async createSnapshot(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateResearchPortfolioSnapshotDto,
  ): Promise<ResearchPortfolioSnapshotDto> {
    ensurePortfolioId(id);
    return this.analyticsService.createSnapshot(ctx, id, dto);
  }

  @Get(':id/snapshots/:snapshotId')
  async snapshot(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('snapshotId') snapshotId: string,
  ): Promise<ResearchPortfolioSnapshotDto> {
    ensurePortfolioId(id);
    return this.analyticsService.snapshot(ctx, id, snapshotId);
  }

  @Post(':id/outputs')
  async createOutput(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateResearchPortfolioOutputDto,
  ): Promise<ResearchPortfolioOutputJobDto> {
    ensurePortfolioId(id);
    return this.outputService.create(ctx, id, dto);
  }

  @Get(':id/output-jobs/:jobId')
  async outputJob(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ): Promise<ResearchPortfolioOutputJobDto> {
    ensurePortfolioId(id);
    return this.outputService.get(ctx, id, jobId);
  }

  @Post(':id/output-jobs/:jobId/cancel')
  async cancelOutput(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ): Promise<ResearchPortfolioOutputJobDto> {
    ensurePortfolioId(id);
    return this.outputService.cancel(ctx, id, jobId);
  }

  @Post(':id/output-jobs/:jobId/retry')
  async retryOutput(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ): Promise<ResearchPortfolioOutputJobDto> {
    ensurePortfolioId(id);
    return this.outputService.retry(ctx, id, jobId);
  }

  @Post(':id/output-jobs/:jobId/reconcile')
  async reconcileOutput(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ): Promise<ResearchPortfolioOutputJobDto> {
    ensurePortfolioId(id);
    return this.outputService.reconcile(ctx, id, jobId);
  }

  @Get(':id/outputs/:outputId/download')
  async downloadOutput(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('outputId') outputId: string,
    @Res() response: Response,
  ): Promise<void> {
    ensurePortfolioId(id);
    const output = await this.outputService.download(ctx, id, outputId);
    response.setHeader('Content-Type', output.mediaType);
    response.setHeader('Content-Disposition', `attachment; filename="${output.fileName.replace(/"/g, '')}"`);
    response.setHeader('ETag', `"${output.contentHash}"`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(output.bytes);
  }

  @Post(':id/outputs/:outputId/client-files')
  async saveOutputToClient(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('outputId') outputId: string,
    @Body() dto: SaveResearchPortfolioOutputToClientDto,
  ): Promise<ResearchPortfolioClientFileReceiptDto> {
    ensurePortfolioId(id);
    return this.outputService.saveToClient(ctx, id, outputId, dto);
  }

  @Get()
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ResearchPortfolioListResponseDto> {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 50;
    const limitNum = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 50)
      : 50;
    return this.service.list(ctx, cursor ?? null, limitNum);
  }

  @Post()
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateResearchPortfolioDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    return this.service.create(ctx, dto);
  }

  // Static routes are intentionally declared before :id so they can never be
  // interpreted as collection identifiers.
  @Get('taxonomy')
  async taxonomy(
    @CurrentTenant() ctx: TenantContext,
    @Query('version') version?: string,
  ): Promise<readonly ResearchTaxonomyVersionDto[]> {
    return this.rules.taxonomy(ctx, version ? Number.parseInt(version, 10) : undefined);
  }

  @Get('templates')
  async templates(@CurrentTenant() ctx: TenantContext): Promise<readonly ResearchPortfolioTemplateDto[]> {
    return this.rules.listTemplates(ctx);
  }

  @Post('templates')
  async createTemplate(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateResearchPortfolioTemplateDto,
  ): Promise<ResearchPortfolioTemplateDto> {
    return this.rules.createTemplate(ctx, dto);
  }

  @Get('templates/:templateId/versions/:versionId')
  async templateVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId') templateId: string,
    @Param('versionId') versionId: string,
  ): Promise<ResearchPortfolioTemplateVersionDto> {
    return this.rules.templateVersion(ctx, templateId, versionId);
  }

  @Post('templates/:templateId/versions')
  async createTemplateVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId') templateId: string,
    @Body() dto: CreateResearchPortfolioTemplateVersionDto,
  ): Promise<ResearchPortfolioTemplateVersionDto> {
    if (!UUID.test(templateId)) throw new NotFoundException('Template not found');
    return this.rules.createTemplateVersion(ctx, templateId, dto);
  }

  @Get(':id/rules')
  async listRules(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<readonly ResearchPortfolioRuleVersionDto[]> {
    ensurePortfolioId(id);
    return this.rules.listRules(ctx, id);
  }

  @Post(':id/rules/preview')
  async previewRule(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: PreviewResearchPortfolioRuleDto,
  ): Promise<ResearchPortfolioRulePreviewDto> {
    ensurePortfolioId(id);
    return this.rules.preview(ctx, id, dto);
  }

  @Post(':id/rules')
  async publishRule(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: PublishResearchPortfolioRuleDto,
  ): Promise<ResearchPortfolioRuleVersionDto> {
    ensurePortfolioId(id);
    return this.rules.publish(ctx, id, dto);
  }

  @Get(':id')
  async detail(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<ResearchPortfolioDetailDto> {
    ensurePortfolioId(id);
    return this.service.detail(ctx, id);
  }

  @Patch(':id')
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateResearchPortfolioDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.service.update(ctx, id, dto);
  }

  @Post(':id/archive')
  async archive(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: ChangeResearchPortfolioLifecycleDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.service.archive(ctx, id, dto);
  }

  @Post(':id/restore')
  async restore(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: ChangeResearchPortfolioLifecycleDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.service.restore(ctx, id, dto);
  }

  @Get(':id/grants')
  async listGrants(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<readonly ResearchPortfolioGrantDto[]> {
    ensurePortfolioId(id);
    return this.service.listGrants(ctx, id);
  }

  @Put(':id/grants/:principalId')
  async upsertGrant(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('principalId') principalId: string,
    @Body() dto: PutResearchPortfolioGrantDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.service.upsertGrant(ctx, id, principalId, dto);
  }

  @Delete(':id/grants/:principalId')
  async deleteGrant(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('principalId') principalId: string,
    @Body() dto: ResearchPortfolioMutationMetaDto & { expectedRevision: number },
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.service.deleteGrant(ctx, id, principalId, dto);
  }

  @Get(':id/client-links')
  async listClientLinks(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<readonly ResearchPortfolioClientLinkDto[]> {
    ensurePortfolioId(id);
    return this.service.listClientLinks(ctx, id);
  }

  @Post(':id/client-links')
  async createClientLink(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateResearchPortfolioClientLinkDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.service.createClientLink(ctx, id, dto);
  }

  @Delete(':id/client-links/:clientId')
  async deleteClientLink(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('clientId') clientId: string,
    @Body() dto: ResearchPortfolioMutationMetaDto & { expectedRevision: number },
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.service.deleteClientLink(ctx, id, clientId, dto);
  }

  @Get(':id/members')
  async listMembers(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<readonly ResearchPortfolioMemberDto[]> {
    ensurePortfolioId(id);
    return this.service.listMembers(ctx, id);
  }

  @Post(':id/members')
  async createMember(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateResearchPortfolioMemberDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.service.createMember(ctx, id, dto);
  }

  @Post(':id/members/decisions')
  async decideMembers(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: DecideResearchPortfolioMembersDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.service.decideMembers(ctx, id, dto);
  }

  @Post(':id/members/:memberId/resolve')
  async resolveMember(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() dto: ResolveResearchPortfolioMemberDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.service.resolveMember(ctx, id, memberId, dto);
  }

  @Post(':id/imports')
  async createImport(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateResearchPortfolioImportDto,
  ): Promise<ResearchPortfolioImportJobDto> {
    ensurePortfolioId(id);
    return this.importService.createJob(ctx, id, dto);
  }

  @Get(':id/imports/:jobId')
  async getImport(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ): Promise<ResearchPortfolioImportDetailDto> {
    ensurePortfolioId(id);
    return this.importService.getJob(ctx, id, jobId);
  }

  @Post(':id/imports/:jobId/:action')
  async actOnImport(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Param('action') action: string,
    @Body() dto: ResearchPortfolioImportActionDto,
  ): Promise<ResearchPortfolioImportDetailDto> {
    ensurePortfolioId(id);
    return this.importService.action(ctx, id, jobId, action, dto);
  }

  @Get(':id/reviews')
  async listReviews(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('lane') lane: 'mine' | 'team' | 'deferred' | 'resolved',
  ): Promise<readonly ResearchPortfolioReviewDto[]> {
    ensurePortfolioId(id);
    return this.reviewService.listReviews(ctx, id, lane ?? 'mine');
  }

  @Post(':id/reviews/:reviewId/assign')
  async assignReview(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: AssignResearchPortfolioReviewDto,
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.reviewService.assignReview(ctx, id, reviewId, dto);
  }

  @Post(':id/reviews/:reviewId/decision')
  async decideReview(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: DecideResearchPortfolioReviewDto,
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.reviewService.decideReview(ctx, id, reviewId, dto);
  }

  @Post(':id/reviews/bulk')
  async bulkDecideReviews(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: BulkResearchPortfolioReviewsDto,
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.reviewService.bulkDecideReviews(ctx, id, dto);
  }

  @Get(':id/annual-review')
  async getAnnualReview(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<ResearchPortfolioAnnualReviewDto> {
    ensurePortfolioId(id);
    return this.reviewService.getAnnualReview(ctx, id);
  }

  @Post(':id/annual-review/reopen')
  async reopenAnnualReview(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: ReopenResearchPortfolioAnnualReviewDto,
  ): Promise<ResearchPortfolioReviewMutationReceiptDto> {
    ensurePortfolioId(id);
    return this.reviewService.reopenAnnualReview(ctx, id, dto);
  }

  // --- Phase 11: bookmarks ---

  @Get(':id/bookmarks')
  async listBookmarks(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<readonly ResearchPortfolioBookmarkDto[]> {
    ensurePortfolioId(id);
    return this.phase11.listBookmarks(ctx, id);
  }

  @Post(':id/bookmarks')
  async createBookmark(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CreateResearchPortfolioBookmarkDto,
  ): Promise<ResearchPortfolioBookmarkDto> {
    ensurePortfolioId(id);
    return this.phase11.createBookmark(ctx, id, dto);
  }

  @Patch(':id/bookmarks/:bookmarkId')
  async updateBookmark(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('bookmarkId') bookmarkId: string,
    @Body() dto: UpdateResearchPortfolioBookmarkDto,
  ): Promise<ResearchPortfolioBookmarkDto> {
    ensurePortfolioId(id);
    return this.phase11.updateBookmark(ctx, id, bookmarkId, dto);
  }

  @Delete(':id/bookmarks/:bookmarkId')
  async deleteBookmark(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('bookmarkId') bookmarkId: string,
  ): Promise<void> {
    ensurePortfolioId(id);
    return this.phase11.deleteBookmark(ctx, id, bookmarkId);
  }

  // --- Phase 11: fit ---

  @Get(':id/fit')
  async fit(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<ResearchPortfolioFitDto> {
    ensurePortfolioId(id);
    return this.phase11.getFit(ctx, id);
  }

  @Post(':id/fit/refresh')
  async refreshFit(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<ResearchPortfolioFitDto> {
    ensurePortfolioId(id);
    return this.phase11.refreshFit(ctx, id);
  }

  // --- Phase 11: review notes ---

  @Post(':id/reviews/:reviewId/notes')
  async addReviewNote(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: CreateResearchPortfolioReviewNoteDto,
  ): Promise<ResearchPortfolioReviewNoteDto> {
    ensurePortfolioId(id);
    return this.phase11.addReviewNote(ctx, id, reviewId, dto);
  }

  // --- Phase 11: watch-conversion ---

  @Post(':id/watch-conversion/preview')
  async previewWatchConversion(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<ResearchPortfolioWatchConversionPreviewDto> {
    ensurePortfolioId(id);
    return this.phase11.previewWatchConversion(ctx, id);
  }

  @Post(':id/watch-conversion/apply')
  async applyWatchConversion(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<ResearchPortfolioWatchConversionResultDto> {
    ensurePortfolioId(id);
    return this.phase11.applyWatchConversion(ctx, id);
  }

  // --- Phase 11: operations ---

  @Get(':id/operations/:operationId')
  async operation(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('operationId') operationId: string,
  ): Promise<ResearchPortfolioOperationDto> {
    ensurePortfolioId(id);
    return this.phase11.getOperation(ctx, id, operationId);
  }

  @Post(':id/operations/:operationId/reconcile')
  async reconcileOperation(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('operationId') operationId: string,
  ): Promise<ResearchPortfolioOperationDto> {
    ensurePortfolioId(id);
    return this.phase11.reconcileOperation(ctx, id, operationId);
  }

  // --- Phase 11: tour state ---

  @Get('tour-state/:tourVersion')
  async getTourState(
    @CurrentTenant() ctx: TenantContext,
    @Param('tourVersion') tourVersion: string,
  ): Promise<ResearchPortfolioTourStateDto> {
    return this.phase11.getTourState(ctx, tourVersion);
  }

  @Post('tour-state/:tourVersion')
  async updateTourState(
    @CurrentTenant() ctx: TenantContext,
    @Param('tourVersion') tourVersion: string,
    @Body() dto: { status: 'dismissed' | 'completed' },
  ): Promise<ResearchPortfolioTourStateDto> {
    return this.phase11.updateTourState(ctx, tourVersion, dto.status);
  }
}
