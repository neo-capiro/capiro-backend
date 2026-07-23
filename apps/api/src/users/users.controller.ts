import { BadRequestException, Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MAX_SIGNATURE_HTML_LENGTH, sanitizeSignatureHtml } from '../common/sanitize-signature.js';
import {
  meetingsV2Enabled,
  outreachAsyncFlagEnabled,
  meriDockUndockUiEnabled,
  strategyPlannerEnabled,
  strategyMeriActive,
  entitlementsForTenant,
} from '../common/tenant-flags.js';
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
}

class UpdateEmailSignatureDto {
  // Raw HTML from the editor / pasted-or-uploaded signature. Server-sanitized
  // before storage. Empty/whitespace clears the signature (stored as NULL).
  // NOTE: the browser sends `htmlBase64` instead (see below) — a raw HTML body
  // trips the WAF's XSS body rule (403 before it reaches the API). `html` stays
  // for non-browser/API callers and tests.
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SIGNATURE_HTML_LENGTH)
  html?: string;

  // Base64-encoded (UTF-8) signature HTML. The web app sends this so the AWS
  // WAF's CrossSiteScripting_BODY rule doesn't false-positive on legitimate
  // pasted signature markup. Decoded then sanitized server-side (the sanitizer
  // remains the authoritative XSS trust boundary). base64 inflates ~33%, so the
  // cap is higher than the raw-HTML cap.
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SIGNATURE_HTML_LENGTH * 2)
  htmlBase64?: string;

  // Append-by-default preference.
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * Demo controller proving the RLS round-trip works end-to-end:
 *   GET /me            → identity from the Clerk JWT + the chosen tenant
 *   PATCH /me          → update mutable profile fields (currently just `title`)
 *   GET /me/memberships → only memberships for the active tenant are visible
 *
 * The membership query runs through `withTenant`, so RLS enforces the scope.
 * If you swap tenant_id in `withTenant` to a different tenant, the same query
 * returns zero rows, that's the fail-closed behavior we want.
 */
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
          // emailSignatureHtml is fetched only to derive the `hasEmailSignature`
          // boolean — the (potentially large) blob itself is NOT returned on the
          // hot /me path; the Settings page loads it via GET /me/email-signature.
          select: {
            email: true,
            firstName: true,
            lastName: true,
            title: true,
            emailSignatureHtml: true,
            emailSignatureEnabled: true,
            tourCompletedAt: true,
          },
        }),
        tx.tenant.findUnique({
          where: { id: ctx.tenantId },
          // settings_jsonb is read to resolve per-tenant feature flags surfaced
          // to the web (see `features` below) — it is NOT returned wholesale.
          select: { name: true, settings: true, planTier: true },
        }),
        // billing_admin permission bit (onboarding v1) — drives billing-tab
        // visibility + purchase CTAs in the web app. Deliberately read here
        // rather than in the change-controlled tenant-context middleware.
        tx.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId: ctx.tenantId, userId: ctx.userId } },
          select: { billingAdmin: true },
        }),
      ] as const);
      return { user, tenant, membership };
    });

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
      },
      tenant: {
        id: ctx.tenantId,
        slug: ctx.tenantSlug,
        name: profile.tenant?.name ?? ctx.tenantSlug,
      },
      role: ctx.role,
      // capiro_admin implicitly has billing powers; tenant users need the
      // explicit membership bit (the Gherkin "Super Admin").
      billingAdmin: ctx.role === 'capiro_admin' || (profile.membership?.billingAdmin ?? false),
      // Per-tenant feature flags the web needs to route/render. The first entry
      // (Meetings & Meri redesign) gates the rebuilt Engagement → Meetings module;
      // there was no prior flag-surfacing pipe (flags were server-side only), so
      // this `features` block is the single place the web reads them.
      // Phase 5 §5.1: effective feature entitlements (tier map + per-tenant
      // overrides). Additive; today every tier grants everything (no-op). No
      // web consumer yet — this is the "planTier is read by a real resolver"
      // proof and the future gate source.
      entitlements: entitlementsForTenant(profile.tenant?.settings, profile.tenant?.planTier),
      features: {
        meetingsV2: meetingsV2Enabled(profile.tenant?.settings),
        // Async outreach (plan W4.4): the job-mode wizard UI is on for a tenant only
        // when the GLOBAL env kill-switch is on AND the tenant has opted in (canary).
        // Both default off, so flipping the env alone changes no tenant's UX.
        outreachAsyncGen:
          this.config.get('OUTREACH_ASYNC_GEN', { infer: true }) &&
          outreachAsyncFlagEnabled(profile.tenant?.settings),
        outreachAsyncSend:
          this.config.get('OUTREACH_ASYNC_SEND', { infer: true }) &&
          outreachAsyncFlagEnabled(profile.tenant?.settings),
        meriDockUndockUi: meriDockUndockUiEnabled(profile.tenant?.settings),
        strategyPlanner: strategyPlannerEnabled(profile.tenant?.settings),
        strategyPlannerMeri: strategyMeriActive(profile.tenant?.settings),
      },
    };
  }

  @Patch('me')
  async updateMe(@CurrentTenant() ctx: TenantContext, @Body() body: UpdateMeDto) {
    // Editable from the client: `title` and the tour-completion flag.
    // firstName/lastName/email are owned by Clerk and synced on login.
    if (body.title === undefined && body.tourCompleted === undefined) {
      throw new BadRequestException('No editable fields provided');
    }
    const normalized = body.title?.trim() ?? '';
    const next = normalized.length ? normalized : null;
    const data: { title?: string | null; tourCompletedAt?: Date | null } = {};
    if (body.title !== undefined) data.title = next;
    if (body.tourCompleted !== undefined) {
      data.tourCompletedAt = body.tourCompleted ? new Date() : null;
    }
    // Return the SAME full shape as GET /me — the client writes this straight
    // into the ['me'] cache, so a partial response would blank tenant/role and
    // the signature flags until the next refetch.
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
      },
      tenant: {
        id: ctx.tenantId,
        slug: ctx.tenantSlug,
        name: profile.tenant?.name ?? ctx.tenantSlug,
      },
      role: ctx.role,
      billingAdmin: ctx.role === 'capiro_admin' || (profile.membership?.billingAdmin ?? false),
      // Phase 5 §5.1: effective feature entitlements (tier map + per-tenant
      // overrides). Additive; today every tier grants everything (no-op). No
      // web consumer yet — this is the "planTier is read by a real resolver"
      // proof and the future gate source.
      entitlements: entitlementsForTenant(profile.tenant?.settings, profile.tenant?.planTier),
      features: {
        meetingsV2: meetingsV2Enabled(profile.tenant?.settings),
        outreachAsyncGen:
          this.config.get('OUTREACH_ASYNC_GEN', { infer: true }) &&
          outreachAsyncFlagEnabled(profile.tenant?.settings),
        outreachAsyncSend:
          this.config.get('OUTREACH_ASYNC_SEND', { infer: true }) &&
          outreachAsyncFlagEnabled(profile.tenant?.settings),
        meriDockUndockUi: meriDockUndockUiEnabled(profile.tenant?.settings),
        strategyPlanner: strategyPlannerEnabled(profile.tenant?.settings),
        strategyPlannerMeri: strategyMeriActive(profile.tenant?.settings),
      },
    };
  }

  /**
   * Read the current user's email signature. Kept off the hot /me path because
   * the HTML (with an inline logo) can be large; only the Settings page needs it.
   */
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

  /**
   * Save the current user's email signature. HTML is sanitized server-side
   * (the authoritative trust boundary) before storage; empty input clears it.
   * `enabled` is the append-by-default preference (each campaign can override).
   */
  @Put('me/email-signature')
  async updateEmailSignature(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: UpdateEmailSignatureDto,
  ) {
    if (body.html === undefined && body.htmlBase64 === undefined && body.enabled === undefined) {
      throw new BadRequestException('No editable fields provided');
    }
    const data: { emailSignatureHtml?: string | null; emailSignatureEnabled?: boolean } = {};
    // The browser sends htmlBase64 (WAF-safe transport); decode it. `html` stays
    // supported for non-browser callers. htmlBase64 wins when both are present.
    const rawHtml =
      body.htmlBase64 !== undefined
        ? Buffer.from(body.htmlBase64, 'base64').toString('utf8')
        : body.html;
    if (rawHtml !== undefined) {
      const clean = sanitizeSignatureHtml(rawHtml);
      data.emailSignatureHtml = clean.length ? clean : null;
    }
    if (body.enabled !== undefined) {
      data.emailSignatureEnabled = body.enabled;
    }
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

  /**
   * Lightweight roster of the active tenant's members for display/attribution
   * (comment authors, collaborators, @-mentions). Unlike GET /tenant-admin/team
   * this is NOT role-gated — it returns only display fields (id, clerk id, name,
   * email) that every member legitimately needs to render who-said-what, and is
   * RLS-scoped to the active tenant via withTenant. Active memberships only.
   */
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
