import { createHash, randomBytes } from 'node:crypto';
import { BadGatewayException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MIN_CLIENT_SLOTS } from '@capiro/shared';
import type { OnboardPurchaser, OnboardSession } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StripeClient } from '../billing/stripe.client.js';
import { BillingService } from '../billing/billing.service.js';
import { EmailService } from '../email/email.service.js';
import {
  renderConfirmationEmail,
  renderItAdminInviteEmail,
  renderOpsNotificationEmail,
  renderReceiptEmail,
} from '../email/email-templates.js';
import type { PurchaserAuth } from '../auth/clerk-user.guard.js';
import { FunnelService, type RoleDesignation } from './funnel.service.js';

const IT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Response contract of apps/api POST /api/internal/onboarding/tenants. */
interface InternalProvisionResponse {
  tenantId: string;
  slug: string;
  clerkOrgId: string;
  healthy: boolean;
  healthChecks: Record<string, boolean>;
  invitesSent: number;
  selfMembership: boolean;
}

export interface ProvisionStatus {
  state: OnboardSession['state'];
  tenantId: string | null;
  slug: string | null;
  failureReason?: string | null;
}

/**
 * Flow-1.10 provisioning bridge. Idempotent by construction:
 *   1. a conditional updateMany claims org_setup → provisioning exactly once
 *      (double-submits observe the claim and just report status),
 *   2. the unique OnboardSession.tenantId backstops against two tenants ever
 *      linking to one session,
 *   3. every email is deduped via onboard_email_log.
 *
 * The tenant + Clerk org are created by apps/api's internal endpoint (same
 * machinery as staff-created tenants); invites are only sent by apps/api after
 * its health check passes — a failed health check fails the session here and
 * alerts CS.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly stripe: StripeClient,
    private readonly billing: BillingService,
    private readonly email: EmailService,
    private readonly funnel: FunnelService,
  ) {}

  async provision(auth: PurchaserAuth): Promise<ProvisionStatus> {
    const { purchaser, session } = await this.funnel.loadPurchaserAndSession(auth.clerkUserId);

    // ── Conditional claim: exactly one caller enters provisioning ────────────
    const claimed = await this.prisma.onboardSession.updateMany({
      where: { id: session.id, state: 'org_setup' },
      data: { state: 'provisioning' },
    });
    if (claimed.count === 0) {
      const fresh = await this.prisma.onboardSession.findUnique({ where: { id: session.id } });
      if (fresh && (fresh.state === 'provisioning' || fresh.state === 'provisioned')) {
        return {
          state: fresh.state,
          tenantId: fresh.tenantId,
          slug: fresh.slugFinal,
          failureReason: fresh.failureReason,
        };
      }
      throw new ConflictException(
        `Session is not ready to provision (state: ${fresh?.state ?? 'missing'}).`,
      );
    }
    this.logger.log(`Provisioning claimed for session ${session.id} (${purchaser.email})`);

    // ── 1. Create tenant + Clerk org via the apps/api internal endpoint ─────
    const secret = this.config.get<string>('INTERNAL_SERVICE_SECRET');
    if (!secret) {
      return this.failSession(session, purchaser, 'INTERNAL_SERVICE_SECRET is not configured');
    }
    const orgProfile = (session.orgProfile ?? {}) as Record<string, unknown>;
    const legalName =
      typeof orgProfile.legalName === 'string' && orgProfile.legalName.trim()
        ? orgProfile.legalName.trim()
        : undefined;
    const designations = (session.roleDesignations ?? []) as unknown as RoleDesignation[];
    const payload = {
      name: legalName ?? purchaser.orgName ?? '',
      plan: session.plan,
      clientSlots:
        session.plan === 'trial' ? MIN_CLIENT_SLOTS : (session.profiles ?? MIN_CLIENT_SLOTS),
      importMode: session.importMode ?? 'self',
      orgProfile,
      ...(purchaser.stripeCustomerId ? { stripeCustomerId: purchaser.stripeCustomerId } : {}),
      purchaser: {
        clerkUserId: purchaser.clerkUserId,
        email: purchaser.email,
        ...(purchaser.firstName ? { firstName: purchaser.firstName } : {}),
        ...(purchaser.lastName ? { lastName: purchaser.lastName } : {}),
      },
      selfAssign: session.roleMode === 'self',
      invites: designations.map((d) => ({
        email: d.email,
        billingAdmin: d.role === 'super',
        ...(d.firstName ? { firstName: d.firstName } : {}),
        ...(d.lastName ? { lastName: d.lastName } : {}),
      })),
      inviteRedirectUrl: `${this.publicBaseUrl}/accept-invite`,
    };

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(`${this.appsApiBase}/api/internal/onboarding/tenants`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-secret': secret,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return this.failSession(
        session,
        purchaser,
        `internal provisioning call failed: ${(err as Error).message}`,
      );
    }
    const bodyText = await response.text().catch(() => '');
    if (response.status !== 200) {
      return this.failSession(
        session,
        purchaser,
        `internal provisioning endpoint returned ${response.status}: ${bodyText.slice(0, 300)}`,
      );
    }
    let result: InternalProvisionResponse;
    try {
      result = JSON.parse(bodyText) as InternalProvisionResponse;
    } catch {
      return this.failSession(
        session,
        purchaser,
        'internal provisioning endpoint returned unparseable JSON',
      );
    }
    if (!result.healthy || !result.tenantId || !result.slug) {
      return this.failSession(
        session,
        purchaser,
        `tenant health check failed (invites held): ${JSON.stringify(result.healthChecks ?? {})}`,
      );
    }

    // ── 2. Link session/purchaser → tenant; sync Stripe billing state ───────
    const { tenantId, slug } = result;
    await this.prisma.onboardSession.update({
      where: { id: session.id },
      data: { tenantId, slugFinal: slug, state: 'provisioned' },
    });
    await this.prisma.onboardPurchaser.update({
      where: { id: purchaser.id },
      data: { tenantId },
    });

    let hostedInvoiceUrl: string | null = null;
    if (session.stripeSubscriptionId && this.stripe.enabled) {
      try {
        const client = this.stripe.client!;
        await client.subscriptions.update(session.stripeSubscriptionId, {
          metadata: { tenantId, tenantSlug: slug },
        });
        const sub = await client.subscriptions.retrieve(session.stripeSubscriptionId, {
          expand: ['latest_invoice'],
        });
        const invoice = typeof sub.latest_invoice === 'string' ? null : sub.latest_invoice;
        hostedInvoiceUrl = invoice?.hosted_invoice_url ?? null;
        // Land the billing state on the tenant immediately (webhooks would
        // eventually converge, but the confirm screen reads it right away).
        await this.billing.syncSubscription(sub);
      } catch (err) {
        // Non-fatal: the tenant exists; the Stripe webhook sync will converge.
        this.logger.error(
          `Post-provision Stripe sync failed for ${slug}: ${(err as Error).message}`,
        );
      }
    }

    // ── 3. IT-admin invites + Flow-2A setup task seed ────────────────────────
    const orgDisplayName = legalName ?? purchaser.orgName ?? slug;
    for (const itEmail of session.itAdminEmails) {
      try {
        const rawToken = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(rawToken).digest('hex');
        await this.prisma.onboardItInvite.create({
          data: {
            tenantId,
            email: itEmail,
            tokenHash,
            expiresAt: new Date(Date.now() + IT_INVITE_TTL_MS),
            createdBy: purchaser.clerkUserId,
          },
        });
        const rendered = renderItAdminInviteEmail(
          `${this.publicBaseUrl}/it/${rawToken}`,
          orgDisplayName,
        );
        await this.email.send({
          to: itEmail,
          kind: 'it_admin_invite',
          dedupeKey: `it:${tenantId}:${itEmail}:${tokenHash.slice(0, 8)}`,
          tenantId,
          purchaserId: purchaser.id,
          ...rendered,
        });
      } catch (err) {
        // The dashboard has a resend path; don't fail a provisioned tenant.
        this.logger.error(`IT-admin invite to ${itEmail} failed: ${(err as Error).message}`);
      }
    }

    await this.prisma.onboardSetupTask.createMany({
      data: [
        { tenantId, task: 'it_email', status: session.itAdminEmails.length ? 'waiting' : 'none' },
        { tenantId, task: 'import', status: 'none' },
        { tenantId, task: 'firm_ai', status: 'none' },
        { tenantId, task: 'invites', status: 'none' },
      ],
      skipDuplicates: true,
    });

    // ── 4. Confirmation + receipt to the purchaser (deduped per session) ────
    await this.sendPurchaserEmails(purchaser, session, orgDisplayName, designations, {
      hostedInvoiceUrl,
    });

    this.logger.log(`Session ${session.id} provisioned → tenant ${slug} (${tenantId})`);
    return { state: 'provisioned', tenantId, slug };
  }

  private async sendPurchaserEmails(
    purchaser: OnboardPurchaser,
    session: OnboardSession,
    orgDisplayName: string,
    designations: RoleDesignation[],
    extras: { hostedInvoiceUrl: string | null },
  ): Promise<void> {
    const plan = session.plan ?? 'trial';
    const roleLabel = (role: 'super' | 'admin') => (role === 'super' ? 'Super Admin' : 'Admin');
    const adminSummaries =
      session.roleMode === 'self'
        ? [`${purchaser.email} (Super Admin)`]
        : designations.map((d) => `${d.email} (${roleLabel(d.role)})`);

    try {
      const confirmation = renderConfirmationEmail({
        firstName: purchaser.firstName,
        orgName: orgDisplayName,
        plan,
        adminSummaries,
        itAdminEmails: session.itAdminEmails,
      });
      await this.email.send({
        to: purchaser.email,
        kind: 'confirmation',
        dedupeKey: `confirmation:${session.id}`,
        tenantId: session.tenantId ?? undefined,
        purchaserId: purchaser.id,
        ...confirmation,
      });
    } catch (err) {
      this.logger.error(`Confirmation email failed: ${(err as Error).message}`);
    }

    try {
      const receipt = renderReceiptEmail({
        plan,
        method: session.payMethod ?? 'card',
        profiles: plan === 'trial' ? MIN_CLIENT_SLOTS : (session.profiles ?? MIN_CLIENT_SLOTS),
        orgName: orgDisplayName,
        firstName: purchaser.firstName,
        wireDueDate: new Date(Date.now() + this.wireDueDays * 24 * 60 * 60 * 1000),
        billedAt: new Date(),
        hostedInvoiceUrl: extras.hostedInvoiceUrl,
      });
      await this.email.send({
        to: purchaser.email,
        kind: 'receipt',
        dedupeKey: `receipt:${session.id}`,
        tenantId: session.tenantId ?? undefined,
        purchaserId: purchaser.id,
        ...receipt,
      });
    } catch (err) {
      this.logger.error(`Receipt email failed: ${(err as Error).message}`);
    }
  }

  /** Mark the session failed, alert CS, and surface a clean 502. */
  private async failSession(
    session: OnboardSession,
    purchaser: OnboardPurchaser,
    reason: string,
  ): Promise<never> {
    this.logger.error(`Provisioning failed for session ${session.id}: ${reason}`);
    await this.prisma.onboardSession.update({
      where: { id: session.id },
      data: { state: 'failed', failureReason: reason.slice(0, 1000) },
    });
    const rendered = renderOpsNotificationEmail('Provisioning FAILED — invites held', [
      `Purchaser: ${purchaser.firstName ?? ''} ${purchaser.lastName ?? ''} <${purchaser.email}>`,
      `Organization: ${purchaser.orgName ?? 'unknown'}`,
      `Session: ${session.id}`,
      `Plan: ${session.plan ?? 'unset'} · pay method: ${session.payMethod ?? 'unset'}`,
      `Reason: ${reason}`,
      'Action: investigate, then reset the session state to org_setup to allow a retry.',
    ]);
    try {
      await this.email.send({
        to: this.csNotifyEmail,
        kind: 'provisioning_failed',
        dedupeKey: `provisioning_failed:${session.id}`,
        purchaserId: purchaser.id,
        ...rendered,
      });
    } catch (err) {
      this.logger.error(`Provisioning-failure CS alert failed: ${(err as Error).message}`);
    }
    throw new BadGatewayException(
      'We could not provision your workspace. Our team has been alerted — please contact support@capiro.ai.',
    );
  }

  private get appsApiBase(): string {
    return (this.config.get<string>('ONBOARD_APPS_API_BASE') ?? 'https://app.capiro.ai').replace(
      /\/+$/,
      '',
    );
  }

  private get publicBaseUrl(): string {
    return (
      this.config.get<string>('ONBOARD_PUBLIC_BASE_URL') ?? 'https://onboarding.capiro.ai'
    ).replace(/\/+$/, '');
  }

  private get wireDueDays(): number {
    const parsed = Number.parseInt(this.config.get<string>('ONBOARD_WIRE_DUE_DAYS') ?? '14', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
  }

  private get csNotifyEmail(): string {
    return this.config.get<string>('ONBOARD_CS_NOTIFY_EMAIL') || 'sales@capiro.ai';
  }
}
