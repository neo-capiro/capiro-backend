import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { IsArray, IsObject, IsOptional, IsString, Length, MinLength } from 'class-validator';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { GenerationService } from './generation.service.js';
import { MemoryPromotionService } from './memory-promotion.service.js';
import type { PeStructuralWarning } from './domain-grounding.helpers.js';
import {
  assertContextPersistenceReleased,
  runWithContextPersistenceBoundary,
} from './context-persistence-hold.js';
import { runWithGenerationAssuranceTenant } from './generation-assurance.js';
import { assertSingleGeneratedSectionRelease } from './single-section-assurance.js';

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
  @IsOptional() @IsString() @Length(1, 4000) note?: string;
}

@Controller('drafts/:draftId')
@UseGuards(TenantGuard)
export class GenerationController {
  constructor(
    private readonly generation: GenerationService,
    private readonly memoryPromotion: MemoryPromotionService,
  ) {}

  @Post('generate-section')
  generateSection(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: GenerateSectionDto,
  ) {
    return runWithGenerationAssuranceTenant(ctx.tenantId, () =>
      runWithContextPersistenceBoundary(ctx.tenantId, draftId, async () => {
        const result = await this.generation.generateSection(
          ctx.tenantId,
          draftId,
          dto.section,
          ctx.clerkUserId,
        );
        // The standalone endpoint returns generated prose directly instead of
        // entering generate-all's per-section persistence gate. Apply that same
        // tenant-aware claim decision before any high-risk section leaves the API.
        assertSingleGeneratedSectionRelease(result);
        // generateSection returns content directly instead of writing ws_draft, so the
        // Prisma middleware cannot enforce this boundary. Consume the same request-local
        // hold before the response leaves the service.
        assertContextPersistenceReleased(ctx.tenantId, draftId);
        return result;
      }),
    );
  }

  @Post('generate-all')
  generateAll(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Req() req: Request,
  ) {
    return runWithGenerationAssuranceTenant(ctx.tenantId, () =>
      runWithContextPersistenceBoundary(ctx.tenantId, draftId, () =>
        this.generation.generateAllSections(ctx.tenantId, draftId, ctx.clerkUserId, {
          bearerToken: extractGenBearer(req),
        }),
      ),
    );
  }

  @Post('retry-failed-sections')
  retryFailed(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return runWithGenerationAssuranceTenant(ctx.tenantId, () =>
      runWithContextPersistenceBoundary(ctx.tenantId, draftId, () =>
        this.generation.retryFailedSections(ctx.tenantId, draftId, ctx.clerkUserId),
      ),
    );
  }

  @Post('apply-generated-sections')
  applyGeneratedSections(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: ApplyGeneratedSectionsDto,
  ) {
    return runWithGenerationAssuranceTenant(ctx.tenantId, () =>
      this.generation.applyGeneratedSections(ctx.tenantId, draftId, dto, ctx.clerkUserId),
    );
  }

  @Post('generate-all-direct')
  generateAllDirect(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
  ) {
    return runWithGenerationAssuranceTenant(ctx.tenantId, () =>
      runWithContextPersistenceBoundary(ctx.tenantId, draftId, () =>
        this.generation.generateAllSectionsInProcess(ctx.tenantId, draftId, ctx.clerkUserId),
      ),
    );
  }

  @Get('context-used')
  contextUsed(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.generation.getContextUsed(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Post('promote-memory')
  promoteMemory(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: PromoteMemoryDto,
  ) {
    return this.memoryPromotion.promoteDraft(ctx.tenantId, ctx.clerkUserId, draftId, dto.note);
  }
}

@Controller('meri')
@UseGuards(TenantGuard)
export class MeriIntakeController {
  constructor(private readonly generation: GenerationService) {}

  @Post('intake')
  intake(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() dto: MeriIntakeDto) {
    return runWithGenerationAssuranceTenant(ctx.tenantId, () =>
      this.generation.meriIntake(ctx.tenantId, ctx.clerkUserId, dto.prompt, dto.client),
    );
  }
}

function extractGenBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null;
  return match?.[1]?.trim() || undefined;
}
