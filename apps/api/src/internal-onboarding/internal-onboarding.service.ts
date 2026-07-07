import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ClerkService } from '../auth/clerk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface ProvisionOnboardedTenantInput {
  name: string;
  /** Optional preferred slug seed; the FIRM NAME is used when absent. */
  slugBase?: string;
  plan: 'trial' | 'paid';
  clientSlots: number;
  importMode: 'self' | 'managed';
  orgProfile: Record<string, unknown>;
  stripeCustomerId?: string;
  purchaser: { clerkUserId: string; email: string; firstName?: string; lastName?: string };
  /** True when the purchaser designated themselves the (billing) Super Admin. */
  selfAssign: boolean;
  invites: Array<{ email: string; billingAdmin: boolean; firstName?: string; lastName?: string }>;
  /** Where admin invite emails land (the external setup dashboard). */
  inviteRedirectUrl: string;
}

export interface ProvisionOnboardedTenantResult {
  tenantId: string;
  slug: string;
  clerkOrgId: string;
  healthy: boolean;
  healthChecks: Record<string, boolean>;
  invitesSent: number;
  selfMembership: boolean;
}

/**
 * Slugs never come from user input (Gherkin 1.9): generated server-side from
 * the firm name, deduped with -2/-3…, and screened against reserved labels
 * (subdomain-sensitive words + the Capiro-internal org).
 */
const RESERVED_SLUGS = new Set([
  'onboarding',
  'app',
  'api',
  'www',
  'admin',
  'billing',
  'capiro',
  'capiro-internal',
  'internal',
  'staging',
  'dev',
  'test',
  'demo',
  'support',
  'mail',
  'marketing',
]);

export function slugifyFirmName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return base.length >= 2 ? base : `firm-${base}`.slice(0, 48);
}

/**
 * Self-service tenant provisioning (onboarding v1 Flow 1.10 bridge), called
 * ONLY by onboard-api over the InternalServiceGuard channel. Mirrors the
 * staff path (CapiroAdminService.createTenantWithFirstAdmin) step-for-step —
 * Clerk org → DB tenant → org metadata — with the onboarding deltas:
 *   • server-generated slug (never user input),
 *   • onboarding_flow_version=1 + plan/slots/import-mode/org-profile fields,
 *   • purchaser self-assignment creates a REAL membership immediately (we
 *     hold the real clerkUserId — the banned `pending:<id>` placeholder
 *     anti-pattern does not apply),
 *   • designated admins get Clerk org invitations carrying
 *     capiro_billing_admin metadata (mirrored onto the membership by the
 *     Clerk webhook) and a redirect to the external setup dashboard,
 *   • invites send ONLY after the health check passes (Gherkin bridge rule).
 */
@Injectable()
export class InternalOnboardingService {
  private readonly logger = new Logger(InternalOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clerk: ClerkService,
  ) {}

  async provisionTenant(
    input: ProvisionOnboardedTenantInput,
  ): Promise<ProvisionOnboardedTenantResult> {
    const name = input.name.trim();
    if (name.length < 2) throw new BadRequestException('Firm name is required');
    if (!Number.isInteger(input.clientSlots) || input.clientSlots < 1) {
      throw new BadRequestException('clientSlots must be a positive integer');
    }

    // ── 1. Slug (server-generated, deduped, reserved-screened) ──────────────
    const slug = await this.pickSlug(input.slugBase?.trim() || name);

    // ── 2. Clerk org (idempotent by slug) ───────────────────────────────────
    const existingList = await this.clerk.backend.organizations.getOrganizationList({
      query: slug,
      limit: 50,
    });
    let org = existingList.data.find((o) => o.slug === slug);
    if (!org) {
      org = await this.clerk.backend.organizations.createOrganization({ name, slug });
    }

    // ── 3. DB tenant + Clerk metadata ───────────────────────────────────────
    const tenant = await this.prisma.withSystem(async (tx) => {
      return tx.tenant.upsert({
        where: { slug },
        create: {
          slug,
          name,
          status: 'active',
          clerkOrgId: org!.id,
          onboardingFlowVersion: 1,
          importMode: input.importMode,
          clientSlots: input.clientSlots,
          // Trial tenants are 'trialing' from provisioning, but the 30-day
          // clock (trial_ends_at) starts only when setup completes (Gherkin
          // Flow 3) — onboard-api stamps it at invites-sent. Paid tenants'
          // status is driven by the Stripe subscription webhook sync.
          billingStatus: input.plan === 'trial' ? 'trialing' : 'none',
          ...(input.stripeCustomerId ? { stripeCustomerId: input.stripeCustomerId } : {}),
          settings: { orgProfile: (input.orgProfile ?? {}) as object } as object,
        },
        update: {
          name,
          status: 'active',
          clerkOrgId: org!.id,
          onboardingFlowVersion: 1,
          importMode: input.importMode,
          clientSlots: input.clientSlots,
          ...(input.stripeCustomerId ? { stripeCustomerId: input.stripeCustomerId } : {}),
          settings: { orgProfile: (input.orgProfile ?? {}) as object } as object,
        },
      });
    });
    await this.clerk.backend.organizations.updateOrganizationMetadata(org.id, {
      publicMetadata: { capiro_tenant_id: tenant.id, capiro_tenant_slug: slug },
    });

    // ── 4. Purchaser self-assignment (before health check — part of the org) ─
    let selfMembership = false;
    if (input.selfAssign) {
      await this.clerk.backend.organizations
        .createOrganizationMembership({
          organizationId: org.id,
          userId: input.purchaser.clerkUserId,
          role: 'org:admin',
        })
        .catch((err: unknown) => {
          // Already-a-member on a retry is fine; anything else surfaces.
          const message = err instanceof Error ? err.message : String(err);
          if (!/already a member|already exists/i.test(message)) throw err;
        });
      // Mirror the membership locally NOW (the webhook will upsert the same
      // rows idempotently) so billing_admin is set deterministically.
      await this.prisma.withSystem(async (tx) => {
        const user = await tx.user.upsert({
          where: { clerkUserId: input.purchaser.clerkUserId },
          create: {
            clerkUserId: input.purchaser.clerkUserId,
            email: input.purchaser.email.toLowerCase(),
            firstName: input.purchaser.firstName ?? null,
            lastName: input.purchaser.lastName ?? null,
          },
          update: {
            firstName: input.purchaser.firstName ?? undefined,
            lastName: input.purchaser.lastName ?? undefined,
          },
        });
        await tx.tenantMembership.upsert({
          where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
          create: {
            tenantId: tenant.id,
            userId: user.id,
            role: 'user_admin',
            status: 'active',
            billingAdmin: true,
            joinedAt: new Date(),
          },
          update: { role: 'user_admin', status: 'active', billingAdmin: true },
        });
      });
      selfMembership = true;
    }

    // ── 5. Health check — MUST pass before any invite sends ─────────────────
    const healthChecks = await this.healthCheck(tenant.id, org.id);
    const healthy = Object.values(healthChecks).every(Boolean);
    if (!healthy) {
      this.logger.error(
        `Onboarded tenant ${slug} failed health check: ${JSON.stringify(healthChecks)} — invites HELD`,
      );
      return {
        tenantId: tenant.id,
        slug,
        clerkOrgId: org.id,
        healthy: false,
        healthChecks,
        invitesSent: 0,
        selfMembership,
      };
    }

    // ── 6. Role invites (org:admin; billing bit rides invitation metadata) ──
    let invitesSent = 0;
    for (const invite of input.invites) {
      const email = invite.email.trim().toLowerCase();
      if (!email.includes('@')) continue;
      try {
        await this.clerk.backend.organizations.createOrganizationInvitation({
          organizationId: org.id,
          emailAddress: email,
          role: 'org:admin',
          publicMetadata: {
            capiro_tenant_id: tenant.id,
            ...(invite.firstName ? { first_name: invite.firstName } : {}),
            ...(invite.lastName ? { last_name: invite.lastName } : {}),
            ...(invite.billingAdmin ? { capiro_billing_admin: true } : {}),
          },
          redirectUrl: input.inviteRedirectUrl,
        });
        invitesSent += 1;
      } catch (err) {
        // A stale pending invite for the same email is the only expected
        // failure on retry; log and continue (resend exists on the dashboard).
        this.logger.warn(
          `Onboarding invite to ${email} for ${slug} failed: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Provisioned onboarded tenant ${slug} (${tenant.id}): plan=${input.plan} slots=${input.clientSlots} self=${selfMembership} invites=${invitesSent}`,
    );
    return {
      tenantId: tenant.id,
      slug,
      clerkOrgId: org.id,
      healthy: true,
      healthChecks,
      invitesSent,
      selfMembership,
    };
  }

  /**
   * 90-day retention hard delete (decision Q4). Server-side eligibility is
   * authoritative: self-serve tenant, canceled ≥90 days, no deletion hold.
   * Mirrors CapiroAdminService.deleteTenant: best-effort Clerk org delete,
   * then the cascading tenant delete.
   */
  async hardDeleteExpiredTenant(
    tenantId: string,
  ): Promise<{ ok: true; deletedTenantId: string; slug: string }> {
    const tenant = await this.prisma.withSystem((tx) =>
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          slug: true,
          clerkOrgId: true,
          billingStatus: true,
          canceledAt: true,
          deletionHold: true,
          onboardingFlowVersion: true,
        },
      }),
    );
    if (!tenant) throw new BadRequestException('Tenant not found');
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const eligible =
      tenant.onboardingFlowVersion === 1 &&
      tenant.billingStatus === 'canceled' &&
      !tenant.deletionHold &&
      tenant.canceledAt != null &&
      Date.now() - tenant.canceledAt.getTime() >= ninetyDaysMs;
    if (!eligible) {
      throw new BadRequestException(
        'Tenant is not eligible for retention deletion (must be a self-serve tenant, canceled ≥90 days, with no deletion hold)',
      );
    }

    if (tenant.clerkOrgId) {
      await this.clerk.backend.organizations
        .deleteOrganization(tenant.clerkOrgId)
        .catch((err: unknown) => {
          this.logger.warn(
            `Clerk deleteOrganization(${tenant.clerkOrgId}) failed: ${(err as Error).message}`,
          );
        });
    }
    await this.prisma.withSystem(async (tx) => {
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    this.logger.log(`Retention hard-delete: tenant ${tenant.slug} (${tenantId}) removed`);
    return { ok: true, deletedTenantId: tenantId, slug: tenant.slug };
  }

  private async pickSlug(seed: string): Promise<string> {
    const base = slugifyFirmName(seed);
    for (let i = 0; i < 50; i += 1) {
      const candidate = i === 0 ? base : `${base}-${i + 1}`;
      if (RESERVED_SLUGS.has(candidate)) continue;
      const taken = await this.prisma.withSystem((tx) =>
        tx.tenant.findUnique({ where: { slug: candidate }, select: { id: true } }),
      );
      if (!taken) return candidate;
    }
    throw new BadRequestException('Could not derive a unique workspace identifier');
  }

  /**
   * Post-provision health check (Gherkin bridge): every signal a first login
   * depends on. Invites are held unless ALL pass.
   */
  private async healthCheck(
    tenantId: string,
    clerkOrgId: string,
  ): Promise<Record<string, boolean>> {
    const checks: Record<string, boolean> = {
      tenantRow: false,
      orgLinked: false,
      orgMetadata: false,
    };
    try {
      const tenant = await this.prisma.withSystem((tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { clerkOrgId: true, status: true },
        }),
      );
      checks.tenantRow = tenant?.status === 'active';
      checks.orgLinked = tenant?.clerkOrgId === clerkOrgId;
      const org = await this.clerk.backend.organizations.getOrganization({
        organizationId: clerkOrgId,
      });
      checks.orgMetadata =
        (org.publicMetadata as Record<string, unknown> | null)?.['capiro_tenant_id'] === tenantId;
    } catch (err) {
      this.logger.error(`Health check error for ${tenantId}: ${(err as Error).message}`);
    }
    return checks;
  }
}
