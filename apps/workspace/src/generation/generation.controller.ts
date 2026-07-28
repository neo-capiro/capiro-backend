import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { IsArray, IsObject, IsOptional, IsString, Length, MinLength } from 'class-validator';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { GenerationService } from './generation.service.js';
import { MemoryPromotionService } from './memory-promotion.service.js';
import type { PeStructuralWarning } from './domain-grounding.helpers.js';

export class GenerateSectionDto {
  @IsString() @MinLength(1) section!: string;
}

export class ApplyGeneratedSectionsDto {
  @IsOptional() @IsObject() sectionContent?: Record<string, string>;
  @IsOptional() @IsObject() sectionMeta?: Record<string, { status: string }>;
  @IsOptional() @IsArray() structuralWarnings?: PeStructuralWarning[];
}

export class MeriIntakeDto {
  @IsString() @MinLength(3) prompt!: string;
  @IsOptional() @IsString() client?: string;
}

export class PromoteMemoryDto {
  /** The firm-memory fact/position to remember. Optional — omitted falls back to
   *  a lightweight draft-context line (see MemoryPromotionService). */
  @IsOptional() @IsString() @Length(1, 4000) note?: string;
}

/** Meri generation endpoints (Phase 6). Tenant-scoped. */
@Controller('drafts/:draftId')
@UseGuards(TenantGuard)
export class GenerationController {
  constructor(
    private readonly generation: GenerationService,
    private readonly memoryPromotion: MemoryPromotionService,
  ) {}

  /** Draft a single section with Meri. Honors the draft's anonymize flag. */
  @Post('generate-section')
  generateSection(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: GenerateSectionDto,
  ) {
    return this.generation.generateSection(ctx.tenantId, draftId, dto.section, ctx.clerkUserId);
  }

  /**
   * Draft every requested section and return the refreshed draft plus the
   * durable generationRun summary. The proxy and direct paths share the same
   * in-process implementation and therefore the same result contract.
   */
  @Post('generate-all')
  generateAll(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Req() req: Request,
  ) {
    return this.generation.generateAllSections(ctx.tenantId, draftId, ctx.clerkUserId, {
      bearerToken: extractGenBearer(req),
    });
  }

  /** Retry only sections the latest generationRun recorded as failed. */
  @Post('retry-failed-sections')
  retryFailed(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
  ) {
    return this.generation.retryFailedSections(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  /**
   * Write-back half of the optional orchestrator-generation contract. Workspace
   * remains the only writer of ws_draft.config.
   */
  @Post('apply-generated-sections')
  applyGeneratedSections(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: ApplyGeneratedSectionsDto,
  ) {
    return this.generation.applyGeneratedSections(ctx.tenantId, draftId, dto, ctx.clerkUserId);
  }

  /**
   * Non-proxy endpoint used by the orchestrator. It calls the same implementation
   * as the flag-off path and cannot recurse back to the orchestrator.
   */
  @Post('generate-all-direct')
  generateAllDirect(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
  ) {
    return this.generation.generateAllSectionsInProcess(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  /** Last durable context provenance for this draft, or null before generation. */
  @Get('context-used')
  contextUsed(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.generation.getContextUsed(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  /** Explicitly propose this artifact's key fact for governed memory review. */
  @Post('promote-memory')
  promoteMemory(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: PromoteMemoryDto,
  ) {
    return this.memoryPromotion.promoteDraft(ctx.tenantId, ctx.clerkUserId, draftId, dto.note);
  }
}

/** Resolve a free-text request to a canonical work product and seed its setup. */
@Controller('meri')
@UseGuards(TenantGuard)
export class MeriIntakeController {
  constructor(private readonly generation: GenerationService) {}

  @Post('intake')
  intake(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() dto: MeriIntakeDto) {
    return this.generation.meriIntake(ctx.tenantId, ctx.clerkUserId, dto.prompt, dto.client);
  }
}

function extractGenBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null;
  return match?.[1]?.trim() || undefined;
}
