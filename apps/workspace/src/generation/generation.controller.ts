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

/** Meri generation endpoints (Phase 6). Tenant-scoped (Sonnet runtime). */
@Controller('drafts/:draftId')
@UseGuards(TenantGuard)
export class GenerationController {
  constructor(
    private readonly generation: GenerationService,
    private readonly memoryPromotion: MemoryPromotionService,
  ) {}

  /**
   * POST /workspace-api/drafts/:draftId/generate-section
   * Draft a single section with Meri (Claude Sonnet, tenant key when present).
   * Honors the draft's anonymize flag end-to-end.
   */
  @Post('generate-section')
  generateSection(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: GenerateSectionDto,
  ) {
    return this.generation.generateSection(ctx.tenantId, draftId, dto.section, ctx.clerkUserId);
  }

  /**
   * POST /workspace-api/drafts/:draftId/generate-all
   * Draft EVERY section of the document with Meri (concurrent, best-effort),
   * grounded in the draft config + the Context Builder plan. Used after the
   * Context Builder ("Open editor") and by the editor's "Regenerate All".
   * Returns the refreshed draft so the client can re-hydrate.
   */
  @Post('generate-all')
  generateAll(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Req() req: Request,
  ) {
    // Forward the caller's bearer so the MeriV2 proxy branch (flag-gated, OFF
    // by default) can authenticate to the orchestrator; flipping
    // meriv2.workspaceGen ON without this fails every generate-all with
    // "requires the caller bearer token". No-op for the legacy path.
    return this.generation.generateAllSections(ctx.tenantId, draftId, ctx.clerkUserId, {
      bearerToken: extractGenBearer(req),
    });
  }

  /**
   * POST /workspace-api/drafts/:draftId/apply-generated-sections
   * Write-back half of the MeriV2 orchestrator-generation contract: the
   * orchestrator does the reasoning (dormant proxy branch in generate-all)
   * and calls back here, forwarding the caller's bearer, so apps/workspace
   * remains the only writer of ws_draft.config. Tenant-scoped like every
   * other draft mutation — grants no capability beyond what the normal editor
   * save path already allows for a caller's own draft.
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
   * POST /workspace-api/drafts/:draftId/generate-all-direct
   * The NON-PROXY generate-all entry the MeriV2 orchestrator routes to
   * (/meri-api/workspace-generation → here, forwarding the caller's bearer).
   * Runs generateAllSectionsInProcess directly, so it NEVER re-enters the
   * meriv2.workspaceGen proxy branch (no orchestrator→workspace→orchestrator
   * recursion). Identical result to the flag-off generate-all path — the
   * reasoning + anonymization stay in apps/workspace where they are proven.
   * Tenant-scoped; same capability as the normal editor generate.
   */
  @Post('generate-all-direct')
  generateAllDirect(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
  ) {
    return this.generation.generateAllSectionsInProcess(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  /**
   * GET /workspace-api/drafts/:draftId/context-used
   * Phase 3.3 "Context used in this draft" panel: the provenance snapshot from
   * the last generation (context items, memory files, linked PEs that actually
   * grounded the text). Returns null when the draft has not been generated yet.
   */
  @Get('context-used')
  contextUsed(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.generation.getContextUsed(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  /**
   * POST /workspace-api/drafts/:draftId/promote-memory
   * Phase 3.4 memory write-back: explicitly promote this artifact's key fact
   * into FIRM institutional memory (a separate decision from export/approve).
   * Creates a firm-scope memory_candidate via apps/api's internal endpoint —
   * it lands 'pending' in the admin review queue (Phase 1 lifecycle), never
   * auto-committed. Tenant-scoped like every other draft action.
   */
  @Post('promote-memory')
  promoteMemory(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: PromoteMemoryDto,
  ) {
    return this.memoryPromotion.promoteDraft(ctx.tenantId, ctx.clerkUserId, draftId, dto.note);
  }
}

/**
 * "Start with Meri" intake (handoff Q-LIB-3): resolve a free-text prompt to a
 * work product + cascade, create the draft, auto-draft the sections, and return
 * it so the UI can open the editor directly.
 */
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
