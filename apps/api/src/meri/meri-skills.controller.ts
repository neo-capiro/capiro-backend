import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  MERI_SKILL_REGISTRY,
  listMeriQuickActions,
  type MeriSkillScope,
} from '@capiro/shared/meri-skills';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';

interface MeriQuickActionTelemetryBody {
  skillId?: unknown;
  clientId?: unknown;
  subjectScope?: unknown;
}

const MERI_SKILL_SCOPE_SET = new Set<MeriSkillScope>([
  'general',
  'client',
  'portfolio',
  'external_entity',
]);

/**
 * Server-authoritative user-facing Meri skill catalog.
 *
 * The browser never owns a second copy of the Quick Action definitions and it
 * cannot widen the rollout. Raw tool schemas are deliberately absent from this
 * response; each item is a user intention backed by a canonical recipe.
 */
@Controller('clio/v3')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MeriSkillsController {
  private readonly logger = new Logger(MeriSkillsController.name);

  constructor(private readonly flags: MeriFeatureFlagsService) {}

  @Get('skills')
  async list(@CurrentTenant() ctx: TenantContext) {
    const enabled = await this.flags.isMeriQuickActionSkillsEnabled(
      ctx.tenantId,
      ctx.tenantSlug,
    );
    return {
      version: 1 as const,
      enabled,
      skills: enabled ? listMeriQuickActions() : [],
    };
  }

  /**
   * Records that a starter intention was actually submitted from the composer.
   * The prompt body is deliberately absent from this contract and from logs.
   */
  @Post('skills/telemetry')
  async recordQuickActionUse(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: MeriQuickActionTelemetryBody,
  ) {
    const enabled = await this.flags.isMeriQuickActionSkillsEnabled(
      ctx.tenantId,
      ctx.tenantSlug,
    );
    if (!enabled) return { accepted: false as const, reason: 'disabled' as const };

    const skillId = typeof body?.skillId === 'string' ? body.skillId.trim() : '';
    const skill = MERI_SKILL_REGISTRY.find((candidate) => candidate.id === skillId);
    if (!skill || !skill.userVisible || !skill.quickAction) {
      throw new BadRequestException('Unknown Meri Quick Action');
    }

    const clientId = typeof body?.clientId === 'string' && body.clientId.trim()
      ? body.clientId.trim()
      : null;
    const requestedScope =
      typeof body?.subjectScope === 'string' &&
      MERI_SKILL_SCOPE_SET.has(body.subjectScope as MeriSkillScope)
        ? (body.subjectScope as MeriSkillScope)
        : null;
    const subjectScope: MeriSkillScope = requestedScope ?? (clientId ? 'client' : 'general');

    this.logger.log(
      JSON.stringify({
        event: 'meri.skill_turn',
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        skillId: skill.id,
        quickActionUsed: true,
        subjectScope,
        clientScoped: Boolean(clientId),
        canonicalRecipe: skill.canonicalRecipe ?? null,
      }),
    );

    return { accepted: true as const };
  }
}
