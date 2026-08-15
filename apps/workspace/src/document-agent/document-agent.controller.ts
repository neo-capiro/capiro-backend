// Document Agent Controller — thin HTTP layer. All business logic is in the
// service. Uses TenantGuard + @CurrentTenant() for auth. TenantId, ownerId,
// and actor IDs come from the authenticated context, never from request bodies.

import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { DocumentAgentService } from './document-agent.service.js';
import { DocumentAgentQualityService } from './document-agent-quality.service.js';
import {
  RecommendDocumentSetupDto,
  InitializeAgentDto,
  PatchAgentDto,
  SendMessageDto,
  UpdateBriefDto,
  ApproveBriefDto,
  SynthesizeBriefDto,
  ReopenBriefDto,
  RecommendContextDto,
  AnalyzeContextDto,
  ApproveContextDto,
  PatchContextItemDto,
  GenerateOutlineDto,
  UpdateOutlineDto,
  ReviseOutlineDto,
  ApproveOutlineDto,
  DecideProposalDto,
  GenerateDto,
  RetryGenerationDto,
  CancelGenerationDto,
  FixIssueDto,
} from './dto/document-agent.dto.js';

/**
 * Catalog and recommendation routes (not draft-scoped).
 */
@Controller('document-agent')
@UseGuards(TenantGuard)
export class DocumentAgentCatalogController {
  constructor(private readonly agent: DocumentAgentService) {}

  @Get('catalog')
  getCatalog(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.agent.getCatalog(ctx.tenantId);
  }

  @Post('recommend')
  recommend(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() dto: RecommendDocumentSetupDto) {
    return this.agent.recommendDocumentSetup(ctx.tenantId, dto.goal, dto.client);
  }
}

/**
 * Draft-scoped agent routes.
 */
@Controller('drafts/:draftId/agent')
@UseGuards(TenantGuard)
export class DocumentAgentController {
  constructor(
    private readonly agent: DocumentAgentService,
    private readonly quality: DocumentAgentQualityService,
  ) {}

  @Get()
  getAgent(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.agent.getAgentState(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Post('initialize')
  initialize(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: InitializeAgentDto,
  ) {
    return this.agent.initializeAgent(ctx.tenantId, draftId, ctx.clerkUserId, dto);
  }

  @Patch()
  patchAgent(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: PatchAgentDto,
  ) {
    return this.agent.patchAgentState(
      ctx.tenantId,
      draftId,
      ctx.clerkUserId,
      dto.expectedRevision,
      dto,
    );
  }

  // ── Conversation ──────────────────────────────────────────────────────

  @Get('messages')
  getMessages(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.agent.getMessages(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Post('messages')
  sendMessage(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.agent.sendMessage(ctx.tenantId, draftId, ctx.clerkUserId, dto);
  }

  // ── Brief ─────────────────────────────────────────────────────────────

  @Put('brief')
  updateBrief(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: UpdateBriefDto,
  ) {
    return this.agent.updateBrief(ctx.tenantId, draftId, ctx.clerkUserId, dto.expectedRevision, dto);
  }

  @Post('brief/synthesize')
  synthesizeBrief(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: SynthesizeBriefDto,
  ) {
    return this.agent.synthesizeBrief(ctx.tenantId, draftId, ctx.clerkUserId, dto.expectedRevision);
  }

  @Post('brief/approve')
  approveBrief(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: ApproveBriefDto,
  ) {
    return this.agent.approveBrief(ctx.tenantId, draftId, ctx.clerkUserId, dto.expectedRevision);
  }

  @Post('brief/reopen')
  reopenBrief(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: ReopenBriefDto,
  ) {
    return this.agent.reopenBrief(ctx.tenantId, draftId, ctx.clerkUserId, dto.expectedRevision);
  }

  // ── Context ──────────────────────────────────────────────────────────

  @Post('context/recommend')
  recommendContext(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: RecommendContextDto,
  ) {
    return this.agent.recommendContext(ctx.tenantId, draftId, ctx.clerkUserId, dto.expectedRevision);
  }

  @Post('context/analyze')
  analyzeContext(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: AnalyzeContextDto,
  ) {
    return this.agent.analyzeContext(ctx.tenantId, draftId, ctx.clerkUserId, dto.expectedRevision);
  }

  @Post('context/approve')
  approveContext(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: ApproveContextDto,
  ) {
    return this.agent.approveContext(ctx.tenantId, draftId, ctx.clerkUserId, dto.expectedRevision);
  }

  // ── Outline ───────────────────────────────────────────────────────────

  @Post('outline/generate')
  generateOutline(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: GenerateOutlineDto,
  ) {
    return this.agent.generateOutline(ctx.tenantId, draftId, ctx.clerkUserId, dto.expectedRevision);
  }

  @Put('outline')
  updateOutline(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: UpdateOutlineDto,
  ) {
    return this.agent.updateOutline(
      ctx.tenantId,
      draftId,
      ctx.clerkUserId,
      dto.expectedRevision,
      dto.sections,
    );
  }

  @Post('outline/revise')
  reviseOutline(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: ReviseOutlineDto,
  ) {
    return this.agent.reviseOutline(
      ctx.tenantId,
      draftId,
      ctx.clerkUserId,
      dto.expectedRevision,
      dto.instruction,
    );
  }

  @Post('outline/approve')
  approveOutline(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: ApproveOutlineDto,
  ) {
    return this.agent.approveOutline(ctx.tenantId, draftId, ctx.clerkUserId, dto.expectedRevision);
  }

  // ── Proposals ────────────────────────────────────────────────────────

  @Get('proposals')
  getProposals(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.agent.getProposals(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Post('proposals/:proposalId/accept')
  acceptProposal(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('proposalId') proposalId: string,
    @Body() dto: DecideProposalDto,
  ) {
    return this.agent.acceptProposal(
      ctx.tenantId,
      draftId,
      proposalId,
      ctx.clerkUserId,
      dto.expectedRevision,
    );
  }

  @Post('proposals/:proposalId/reject')
  rejectProposal(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('proposalId') proposalId: string,
    @Body() dto: DecideProposalDto,
  ) {
    return this.agent.rejectProposal(
      ctx.tenantId,
      draftId,
      proposalId,
      ctx.clerkUserId,
      dto.expectedRevision,
      dto.note,
    );
  }

  // ── Generation ──────────────────────────────────────────────────────

  @Post('generate')
  generate(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: GenerateDto,
  ) {
    return this.agent.generate(
      ctx.tenantId,
      draftId,
      ctx.clerkUserId,
      dto.expectedRevision,
      dto.mode ?? 'standard',
    );
  }

  @Get('generation')
  getGeneration(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
  ) {
    return this.agent.getGenerationStatus(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Post('generation/retry')
  retryGeneration(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: RetryGenerationDto,
  ) {
    return this.agent.retryGeneration(
      ctx.tenantId,
      draftId,
      ctx.clerkUserId,
      dto.expectedRevision,
      dto.sectionIds,
    );
  }

  @Post('generation/cancel')
  cancelGeneration(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: CancelGenerationDto,
  ) {
    return this.agent.cancelGeneration(
      ctx.tenantId,
      draftId,
      ctx.clerkUserId,
      dto.expectedRevision,
    );
  }

  // ── Quality ──────────────────────────────────────────────────────────

  @Get('quality')
  getQuality(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.quality.evaluate(ctx.tenantId, draftId);
  }

  @Post('quality/issues/:issueId/fix')
  fixIssue(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('issueId') issueId: string,
    @Body() dto: FixIssueDto,
  ) {
    return this.quality.createFixProposal({
      tenantId: ctx.tenantId,
      draftId,
      issueId,
      createdById: ctx.clerkUserId,
      baseRevision: dto.expectedRevision,
      baseHash: '',
      instruction: dto.instruction,
    });
  }
}

/**
 * Context item patch route (extends existing context CRUD).
 */
@Controller('drafts/:draftId/context')
@UseGuards(TenantGuard)
export class AgentContextItemController {
  constructor(private readonly agent: DocumentAgentService) {}

  @Patch(':itemId')
  patchContextItem(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('itemId') itemId: string,
    @Body() dto: PatchContextItemDto,
  ) {
    return this.agent.patchContextItem(ctx.tenantId, draftId, itemId, dto.payload);
  }
}
