import { BadRequestException, Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MAX_SIGNATURE_HTML_LENGTH, sanitizeSignatureHtml } from '../common/sanitize-signature.js';
import {
  meetingsV2Enabled,
  outreachAsyncFlagEnabled,
  meriDockUndockUiEnabled,
  strategyPlannerEnabled,
  strategyMeriActive,
  agenticMeriActive,
  contextStewardActive,
  strategyWatcherActive,
  engagementVNextEnabled,
  businessDevelopmentDossierEnabled,
  businessDevelopmentEnabled,
  businessDevelopmentBriefEnabled,
  businessDevelopmentMeriProspectToolsEnabled,
  businessDevelopmentClaimValidationEnabled,
  entitlementsForTenant,
} from '../common/tenant-flags.js';
import { meriV3ChatActive } from '../common/meriv3-flags.js';
import type { AppConfig } from '../config/config.schema.js';

class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  /** Guided-tour completion (onboarding v1 Flow 2B.4): true on Finish/Skip. */
  @IsOptional()
  @IsBoolean()
  tourCompleted?: boolean;

  /** LegiWatch orientation preference; persisted per user across devices. */
  @IsOptional()
  @IsBoolean()
  legiwatchIntroSeen?: boolean;

  /**
   * PR D / LW-QA-013 — LegiWatch display preferences (one JSON doc per user:
   * preferred timezone / default hearings view / default chamber filter).
   * SECONDARY display only; the hearing record's official time+zone is never
   * modified. Stored verbatim as JSON (unknown keys round-trip); the WEB owns
   * normalization so an old/corrupt shape can never break rendering. Bounded
   * to 2 KB — this is a handful of scalars, not a document store.
   */
  @IsOptional()
  @IsObject()
  @MaxJSONDepth1()
  legiwatchPrefs?: Record<string, unknown>;
}

/** Guard: every value must be a JSON scalar (string|number|boolean|null) —
 *  no nested objects/arrays inside the prefs doc. Keeps the column a
 *  bounded scalar map, not an arbitrary nested blob. */
function MaxJSONDepth1() {
  return ValidateIf((_, value) => {
    if (value == null) return false;
    return Object.values(value as Record<string, unknown>).some(
      (v) => v !== null && typeof v === 'object',
    );
  }, { message: 'legiwatchPrefs must be a flat JSON object of scalar values' });
}

class UpdateEmailSignatureDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SIGNATURE_HTML_LENGTH)
  html?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SIGNATURE_HTML_LENGTH * 2)
  htmlBase64?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

@Controller()
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get('me')
  async me(@CurrentTenant() ctx: TenantContext) {
    const profile = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [user, tenant, membership] = await Promise.all([
        tx.user.findUnique({
          where: { id: ctx.userId },
          select: {
            email: true,
            firstName: true,
            lastName: true,
            title: true,
            emailSignatureHtml: true,
            emailSignatureEnabled: true,
            tourCompletedAt: true,
            legiwatchIntroSeenAt: true,
            legiwatchPrefs: true,
          },
        }),
        tx.tenant.findUnique({
          where: { id: ctx.tenantId },
          select: { name: true, settings: true, planTier: true },
        }),
        tx.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId: ctx.tenantId, userId: ctx.userId } },
          select: { billingAdmin: true },
        }),
      ] as const);
      return { user, tenant, membership };
    });
    const meriv3Chat = meriV3ChatActive(profile.tenant?.settings, ctx.tenantSlug);

    return {
      user: {
        id: ctx.userId,
        clerkUserId: ctx.clerkUserId,
        email: profile.user?.email ?? null,
        firstName: profile.user?.firstName ?? null,
        lastName: profile.user?.lastName ?? null,
        title: profile.user?.title ?? null,
        emailSignatureEnabled: profile.user?.emailSignatureEnabled ?? false,
        hasEmailSignature: Boolean(profile.user?.emailSignatureHtml),
        tourCompleted: Boolean(profile.user?.tourCompletedAt),
        legiwatchIntroSeen: Boolean(profile.user?.legiwatchIntroSeenAt),
        legiwatchPrefs: (profile.user?.legiwatchPrefs ?? null) as Record<string, unknown> | null,
      },
      tenant: {
        id: ctx.tenantId,
        slug: ctx.tenantSlug,
        name: profile.tenant?.name ?? ctx.tenantSlug,
      },
      role: ctx.role,
      billingAdmin: ctx.role === 'capiro_admin' || (profile.membership?.billingAdmin ?? false),
      entitlements: entitlementsForTenant(profile.tenant?.settings, profile.tenant?.planTier),
      features: {
        meetingsV2: meetingsV2Enabled(profile.tenant?.settings),
        outreachAsyncGen:
          this.config.get('OUTREACH_ASYNC_GEN', { infer: true }) &&
          outreachAsyncFlagEnabled(profile.tenant?.settings),
        outreachAsyncSend:
          this.config.get('OUTREACH_ASYNC_SEND', { infer: true }) &&
          outreachAsyncFlagEnabled(profile.tenant?.settings),
        versionedOutreach: this.config.get('ENGAGEMENT_VERSIONED_OUTREACH', { infer: true }),
        externalSendV2Required: this.config.get('ENGAGEMENT_EXTERNAL_SEND_V2_REQUIRED', {
          infer: true,
        }),
        // MeriV3's canary always receives the new workspace presentation. The
        // old flag remains independently usable by MeriV2 tenants.
        meriDockUndockUi: meriDockUndockUiEnabled(profile.tenant?.settings) || meriv3Chat,
        meriv3Chat,
        strategyPlanner: strategyPlannerEnabled(profile.tenant?.settings),
        // Engagement vNext tenant access gate (dogfood canary, capiro-internal
        // only for now) — VNextRouter reads this to decide which component
        // actually renders, not just nav visibility. See tenant-flags.ts.
        engagementVNext: engagementVNextEnabled(profile.tenant?.settings),
        strategyPlannerMeri: strategyMeriActive(profile.tenant?.settings),
        agenticMeri: agenticMeriActive(profile.tenant?.settings),
        contextSteward: contextStewardActive(profile.tenant?.settings),
        strategyWatcher: strategyWatcherActive(profile.tenant?.settings),
        businessDevelopment: businessDevelopmentEnabled(profile.tenant?.settings),
        businessDevelopmentDossier: businessDevelopmentDossierEnabled(
          profile.tenant?.settings,
        ),
        businessDevelopmentBrief: businessDevelopmentBriefEnabled(
          profile.tenant?.settings,
        ),
        businessDevelopmentMeriProspectTools: businessDevelopmentMeriProspectToolsEnabled(
          profile.tenant?.settings,
        ),
        businessDevelopmentClaimValidation: businessDevelopmentClaimValidationEnabled(
          profile.tenant?.settings,
        ),
      },
    };
  }

  @Patch('me')
  async updateMe(@CurrentTenant() ctx: TenantContext, @Body() body: UpdateMeDto) {
    if (
      body.title === undefined &&
      body.tourCompleted === undefined &&
      body.legiwatchIntroSeen === undefined &&
      body.legiwatchPrefs === undefined
    ) {
      throw new BadRequestException('No editable fields provided');
    }
    const normalized = body.title?.trim() ?? '';
    const next = normalized.length ? normalized : null;
    // PR D / LW-QA-013: prefs are bounded (≤2 KB, flat scalars — validator
    // enforces depth-1) before they touch the row. Stored verbatim; the web
    // normalizes on read.
    if (body.legiwatchPrefs !== undefined) {
      const serialized = JSON.stringify(body.legiwatchPrefs);
      if (serialized.length > 2048) {
        throw new BadRequestException('legiwatchPrefs too large (max 2 KB)');
      }
    }
    const data: {
      title?: string | null;
      tourCompletedAt?: Date | null;
      legiwatchIntroSeenAt?: Date | null;
      legiwatchPrefs?: Prisma.InputJsonValue;
    } = {};
    if (body.title !== undefined) data.title = next;
    if (body.tourCompleted !== undefined) {
      data.tourCompletedAt = body.tourCompleted ? new Date() : null;
    }
    if (body.legiwatchIntroSeen !== undefined) {
      data.legiwatchIntroSeenAt = body.legiwatchIntroSeen ? new Date() : null;
    }
    if (body.legiwatchPrefs !== undefined) {
      data.legiwatchPrefs = body.legiwatchPrefs as Prisma.InputJsonValue;
    }
    const profile = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const user = await tx.user.update({
        where: { id: ctx.userId },
        data,
        select: {
          email: true,
          firstName: true,
          lastName: true,
          title: true,
          emailSignatureHtml: true,
          emailSignatureEnabled: true,
          tourCompletedAt: true,
          legiwatchIntroSeenAt: true,
          legiwatchPrefs: true,
        },
      });
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { name: true, settings: true, planTier: true },
      });
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId: ctx.userId } },
        select: { billingAdmin: true },
      });
      return { user, tenant, membership };
    });
    const meriv3Chat = meriV3ChatActive(profile.tenant?.settings, ctx.tenantSlug);
    return {
      user: {
        id: ctx.userId,
        clerkUserId: ctx.clerkUserId,
        email: profile.user.email,
        firstName: profile.user.firstName,
        lastName: profile.user.lastName,
        title: profile.user.title,
        emailSignatureEnabled: profile.user.emailSignatureEnabled,
        hasEmailSignature: Boolean(profile.user.emailSignatureHtml),
        tourCompleted: Boolean(profile.user.tourCompletedAt),
        legiwatchIntroSeen: Boolean(profile.user.legiwatchIntroSeenAt),
        legiwatchPrefs: (profile.user.legiwatchPrefs ?? null) as Record<string, unknown> | null,
      },
      tenant: {
        id: ctx.tenantId,
        slug: ctx.tenantSlug,
        name: profile.tenant?.name ?? ctx.tenantSlug,
      },
      role: ctx.role,
      billingAdmin: ctx.role === 'capiro_admin' || (profile.membership?.billingAdmin ?? false),
      entitlements: entitlementsForTenant(profile.tenant?.settings, profile.tenant?.planTier),
      features: {
        meetingsV2: meetingsV2Enabled(profile.tenant?.settings),
        outreachAsyncGen:
          this.config.get('OUTREACH_ASYNC_GEN', { infer: true }) &&
          outreachAsyncFlagEnabled(profile.tenant?.settings),
        outreachAsyncSend:
          this.config.get('OUTREACH_ASYNC_SEND', { infer: true }) &&
          outreachAsyncFlagEnabled(profile.tenant?.settings),
        versionedOutreach: this.config.get('ENGAGEMENT_VERSIONED_OUTREACH', { infer: true }),
        externalSendV2Required: this.config.get('ENGAGEMENT_EXTERNAL_SEND_V2_REQUIRED', {
          infer: true,
        }),
        meriDockUndockUi: meriDockUndockUiEnabled(profile.tenant?.settings) || meriv3Chat,
        meriv3Chat,
        strategyPlanner: strategyPlannerEnabled(profile.tenant?.settings),
        // Engagement vNext tenant access gate (dogfood canary, capiro-internal
        // only for now) — VNextRouter reads this to decide which component
        // actually renders, not just nav visibility. See tenant-flags.ts.
        engagementVNext: engagementVNextEnabled(profile.tenant?.settings),
        strategyPlannerMeri: strategyMeriActive(profile.tenant?.settings),
        agenticMeri: agenticMeriActive(profile.tenant?.settings),
        contextSteward: contextStewardActive(profile.tenant?.settings),
        strategyWatcher: strategyWatcherActive(profile.tenant?.settings),
        businessDevelopment: businessDevelopmentEnabled(profile.tenant?.settings),
        businessDevelopmentDossier: businessDevelopmentDossierEnabled(
          profile.tenant?.settings,
        ),
        businessDevelopmentBrief: businessDevelopmentBriefEnabled(
          profile.tenant?.settings,
        ),
        businessDevelopmentMeriProspectTools: businessDevelopmentMeriProspectToolsEnabled(
          profile.tenant?.settings,
        ),
        businessDevelopmentClaimValidation: businessDevelopmentClaimValidationEnabled(
          profile.tenant?.settings,
        ),
      },
    };
  }

  @Get('me/email-signature')
  async getEmailSignature(@CurrentTenant() ctx: TenantContext) {
    const user = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.user.findUnique({
        where: { id: ctx.userId },
        select: { emailSignatureHtml: true, emailSignatureEnabled: true },
      }),
    );
    return {
      html: user?.emailSignatureHtml ?? null,
      enabled: user?.emailSignatureEnabled ?? false,
    };
  }

  @Put('me/email-signature')
  async updateEmailSignature(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: UpdateEmailSignatureDto,
  ) {
    if (body.html === undefined && body.htmlBase64 === undefined && body.enabled === undefined) {
      throw new BadRequestException('No editable fields provided');
    }
    const data: { emailSignatureHtml?: string | null; emailSignatureEnabled?: boolean } = {};
    const rawHtml =
      body.htmlBase64 !== undefined
        ? Buffer.from(body.htmlBase64, 'base64').toString('utf8')
        : body.html;
    if (rawHtml !== undefined) {
      const clean = sanitizeSignatureHtml(rawHtml);
      data.emailSignatureHtml = clean.length ? clean : null;
    }
    if (body.enabled !== undefined) data.emailSignatureEnabled = body.enabled;
    const user = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.user.update({
        where: { id: ctx.userId },
        data,
        select: { emailSignatureHtml: true, emailSignatureEnabled: true },
      }),
    );
    return {
      html: user.emailSignatureHtml ?? null,
      enabled: user.emailSignatureEnabled,
    };
  }

  @Get('me/memberships')
  async memberships(@CurrentTenant() ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.tenantMembership.findMany({
        where: { userId: ctx.userId },
        include: { tenant: { select: { id: true, slug: true, name: true } } },
      });
      return rows.map((m) => ({
        membershipId: m.id,
        tenant: m.tenant,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt,
      }));
    });
  }

  @Get('tenant-members')
  async tenantMembers(@CurrentTenant() ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId, status: 'active' },
        include: {
          user: {
            select: { id: true, clerkUserId: true, email: true, firstName: true, lastName: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((m) => {
        const name = `${m.user.firstName ?? ''} ${m.user.lastName ?? ''}`.trim() || m.user.email;
        return {
          id: m.user.id,
          clerkUserId: m.user.clerkUserId,
          email: m.user.email,
          name,
        };
      });
    });
  }
}
