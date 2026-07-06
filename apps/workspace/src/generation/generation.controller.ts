import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { IsArray, IsObject, IsOptional, IsString, MinLength } from 'class-validator';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { GenerationService } from './generation.service.js';
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

/** Meri generation endpoints (Phase 6). Tenant-scoped (Sonnet runtime). */
@Controller('drafts/:draftId')
@UseGuards(TenantGuard)
export class GenerationController {
  constructor(private readonly generation: GenerationService) {}

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
    return this.generation.generateSection(ctx.tenantId, draftId, dto.section);
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
    return this.generation.generateAllSections(ctx.tenantId, draftId, {
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
    return this.generation.applyGeneratedSections(ctx.tenantId, draftId, dto);
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
