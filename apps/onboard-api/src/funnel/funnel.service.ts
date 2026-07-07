import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';
import { ClerkService } from '@capiro/auth';
import { MIN_CLIENT_SLOTS } from '@capiro/shared';
import type {
  OnboardPurchaser,
  OnboardSession,
  Prisma,
} from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StripeClient } from '../billing/stripe.client.js';
import { EmailService } from '../email/email.service.js';
import { renderOpsNotificationEmail } from '../email/email-templates.js';
import { LegalService } from '../legal/legal.service.js';
import type { PurchaserAuth } from '../auth/clerk-user.guard.js';
import { isAtLeast, isLocked, nextState, type OrderedFunnelState } from './funnel-state.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RoleDesignation {
  email: string;
  role: 'super' | 'admin';
  firstName?: string;
  lastName?: string;
}

export interface FunnelSessionSnapshot {
  sessionId: string;
  state: OnboardSession['state'];
  plan: OnboardSession['plan'];
  payMethod: OnboardSession['payMethod'];
  profiles: number | null;
  roleMode: string | null;
  roleDesignations: unknown;
  importMode: string | null;
  itAdminEmails: string[];
  orgProfile: unknown;
  slugFinal: string | null;
  tenantId: string | null;
  failureReason: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
  orgName: string | null;
  stripe: { setupIntentStatus?: string; subscriptionStatus?: string };
}

interface PurchaserSession {
  purchaser: OnboardPurchaser;
  session: OnboardSession;
}

/**
 * Flow-1 funnel state machine (plan §5 Phase 3). One resumable
 * OnboardSession per purchaser walks registered → … → org_setup; the
 * provisioning bridge (ProvisioningService) owns the final hop. Steps may be
 * revisited before provisioning — data is updated and the state only ever
 * moves FORWARD (state = max(current, step)), so resuming always lands on the
 * furthest step reached.
 */
@Injectable()
export class FunnelService {
  private readonly logger = new Logger(FunnelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clerk: ClerkService,
    private readonly stripe: StripeClient,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly legal: LegalService,
  ) {}

  // ---------------------------------------------------------------------------
  // Registration / session
  // ---------------------------------------------------------------------------

  async register(
    auth: PurchaserAuth,
    dto: { firstName: string; lastName: string; orgName: string },
  ): Promise<FunnelSessionSnapshot> {
    const { email, verified } = await this.fetchClerkEmail(auth.clerkUserId);
    const purchaser = await this.prisma.onboardPurchaser.upsert({
      where: { clerkUserId: auth.clerkUserId },
      create: {
        clerkUserId: auth.clerkUserId,
        email,
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        orgName: dto.orgName.trim(),
      },
      update: {
        email,
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        orgName: dto.orgName.trim(),
      },
    });

    let session = await this.findActiveSession(purchaser.id);
    if (!session) {
      session = await this.prisma.onboardSession.create({ data: { purchaserId: purchaser.id } });
      this.logger.log(`New funnel session ${session.id} for purchaser ${purchaser.id}`);
    }
    // Clerk sign-up flows usually verify the email before the session token
    // exists — skip the extra verify-check roundtrip when that's the case.
    if (verified && !isLocked(session.state)) {
      session = await this.advance(session, 'verified');
    }
    return this.snapshot(purchaser, session);
  }

  async getSession(auth: PurchaserAuth): Promise<FunnelSessionSnapshot> {
    const { purchaser, session } = await this.loadPurchaserAndSession(auth.clerkUserId);
    return this.snapshot(purchaser, session);
  }

  async getStatus(auth: PurchaserAuth): Promise<{
    state: OnboardSession['state'];
    tenantId: string | null;
    slug: string | null;
    failureReason: string | null;
  }> {
    const { session } = await this.loadPurchaserAndSession(auth.clerkUserId);
    return {
      state: session.state,
      tenantId: session.tenantId,
      slug: session.slugFinal,
      failureReason: session.failureReason,
    };
  }

  async verifyCheck(auth: PurchaserAuth): Promise<{ verified: boolean }> {
    const { purchaser, session } = await this.loadPurchaserAndSession(auth.clerkUserId);
    const { email, verified } = await this.fetchClerkEmail(auth.clerkUserId);
    if (!verified) return { verified: false };
    if (email !== purchaser.email) {
      await this.prisma.onboardPurchaser.update({
        where: { id: purchaser.id },
        data: { email },
      });
    }
    if (!isLocked(session.state)) await this.advance(session, 'verified');
    return { verified: true };
  }

  // ---------------------------------------------------------------------------
  // Plan + legal
  // ---------------------------------------------------------------------------

  async selectPlan(auth: PurchaserAuth, plan: 'trial' | 'paid'): Promise<{ ok: true }> {
    const { session } = await this.requireStep(auth.clerkUserId, 'verified');
    await this.advance(session, 'plan_selected', { plan });
    return { ok: true };
  }

  async getLegalDocs(
    auth: PurchaserAuth,
  ): Promise<Array<{ docType: string; version: string; html: string; pdfS3Key?: string }>> {
    const { session } = await this.requireStep(auth.clerkUserId, 'plan_selected', {
      allowLocked: true,
    });
    if (!session.plan) throw new BadRequestException('Select a plan first.');
    const docs = await this.legal.getActiveDocs(session.plan);
    return [docs.tos, docs.sa].map((doc) => ({
      docType: doc.docType,
      version: doc.version,
      html: doc.html,
      ...(doc.pdfS3Key ? { pdfS3Key: doc.pdfS3Key } : {}),
    }));
  }

  async acceptLegal(
    auth: PurchaserAuth,
    dto: { tosVersion: string; saVersion: string },
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<{ ok: true }> {
    const { purchaser, session } = await this.requireStep(auth.clerkUserId, 'plan_selected');
    if (!session.plan) throw new BadRequestException('Select a plan first.');
    await this.legal.recordConsents({
      sessionId: session.id,
      purchaserId: purchaser.id,
      clerkUserId: auth.clerkUserId,
      plan: session.plan,
      accepts: [
        { docType: 'tos', version: dto.tosVersion },
        { docType: 'sa', version: dto.saVersion },
      ],
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.advance(session, 'legal_accepted');
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Payment — trial (method on file via SetupIntent)
  // ---------------------------------------------------------------------------

  async createSetupIntent(
    auth: PurchaserAuth,
    method: 'card' | 'ach',
  ): Promise<{ clientSecret: string | null }> {
    const { purchaser, session } = await this.requireStep(auth.clerkUserId, 'legal_accepted');
    if (session.plan !== 'trial') {
      throw new BadRequestException(
        'SetupIntents are for the trial plan — use payment/subscribe for a paid plan.',
      );
    }
    const stripe = this.stripe.require();
    const customerId = await this.ensurePurchaserCustomer(purchaser, stripe);
    const metadata = { purchaserId: purchaser.id, onboarding: '1' };
    const si = await stripe.setupIntents.create(
      method === 'card'
        ? { customer: customerId, payment_method_types: ['card'], metadata }
        : {
            customer: customerId,
            payment_method_types: ['us_bank_account'],
            // Financial Connections instant verification with micro-deposit
            // fallback; the mandate is collected client-side by Stripe.js.
            payment_method_options: { us_bank_account: { verification_method: 'automatic' } },
            metadata,
          },
    );
    await this.prisma.onboardSession.update({
      where: { id: session.id },
      data: { stripeSetupIntentId: si.id },
    });
    return { clientSecret: si.client_secret };
  }

  async trialComplete(
    auth: PurchaserAuth,
    method: 'card' | 'ach' | 'wire',
  ): Promise<{ ok: true; method: string; setupIntentStatus?: string }> {
    const { purchaser, session } = await this.requireStep(auth.clerkUserId, 'legal_accepted');
    if (session.plan !== 'trial') {
      throw new BadRequestException('Trial payment completion applies to the trial plan only.');
    }

    if (method === 'wire') {
      // "Wire on file" is billing-contact-only (plan §8 red flag 6): nothing
      // is storable — day-31 conversion just issues an invoice.
      await this.advance(session, 'payment_on_file', { payMethod: 'wire' });
      return { ok: true, method };
    }

    if (!session.stripeSetupIntentId) {
      throw new BadRequestException(
        'No payment method in progress — call payment/setup-intent first.',
      );
    }
    const stripe = this.stripe.require();
    const si = await stripe.setupIntents.retrieve(session.stripeSetupIntentId);
    // ACH micro-deposit verification completes later; card must be fully set up.
    const acceptable =
      method === 'card' ? ['succeeded'] : ['succeeded', 'processing', 'requires_action'];
    if (!acceptable.includes(si.status)) {
      throw new BadRequestException(
        `Payment method is not ready (SetupIntent status: ${si.status}).`,
      );
    }
    const paymentMethodId =
      typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
    if (paymentMethodId && purchaser.stripeCustomerId) {
      await stripe.customers.update(purchaser.stripeCustomerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }
    await this.advance(session, 'payment_on_file', { payMethod: method });
    return { ok: true, method, setupIntentStatus: si.status };
  }

  // ---------------------------------------------------------------------------
  // Payment — paid (immediate subscription)
  // ---------------------------------------------------------------------------

  async subscribe(
    auth: PurchaserAuth,
    dto: { profiles: number; method: 'card' | 'ach' | 'wire' },
  ): Promise<{
    subscriptionId: string;
    status: string;
    clientSecret?: string | null;
    hostedInvoiceUrl?: string | null;
  }> {
    const { purchaser, session } = await this.requireStep(auth.clerkUserId, 'legal_accepted');
    if (session.plan !== 'paid') {
      throw new BadRequestException(
        'Subscriptions are for the paid plan — use payment/setup-intent for a trial.',
      );
    }
    const stripe = this.stripe.require();
    const quantity = Math.max(MIN_CLIENT_SLOTS, Math.floor(dto.profiles || 0));

    // Idempotency: a live subscription from a previous submit is returned
    // as-is; a dangling incomplete one (user changed method/tier) is
    // cancelled and replaced.
    if (session.stripeSubscriptionId) {
      try {
        const existing = await stripe.subscriptions.retrieve(session.stripeSubscriptionId, {
          expand: ['latest_invoice.payment_intent'],
        });
        if (existing.status === 'incomplete') {
          await stripe.subscriptions.cancel(existing.id);
          this.logger.log(`Cancelled incomplete subscription ${existing.id} (resubmit)`);
        } else if (existing.status !== 'canceled' && existing.status !== 'incomplete_expired') {
          return this.subscribeResult(existing, session.payMethod ?? dto.method);
        }
      } catch (err) {
        this.logger.warn(
          `Stale subscription ${session.stripeSubscriptionId} unreadable: ${(err as Error).message}`,
        );
      }
    }

    const customerId = await this.ensurePurchaserCustomer(purchaser, stripe);
    const items: Stripe.SubscriptionCreateParams.Item[] = [{ price: this.slotsPriceId, quantity }];
    if (this.overagePriceId) items.push({ price: this.overagePriceId }); // metered — no quantity
    const base: Stripe.SubscriptionCreateParams = {
      customer: customerId,
      items,
      // tenantId/tenantSlug are stamped post-provision (ProvisioningService).
      metadata: { purchaserId: purchaser.id, onboarding: '1' },
    };

    const sub =
      dto.method === 'wire'
        ? await stripe.subscriptions.create({
            ...base,
            collection_method: 'send_invoice',
            days_until_due: this.wireDueDays,
            expand: ['latest_invoice'],
          })
        : await stripe.subscriptions.create({
            ...base,
            payment_behavior: 'default_incomplete',
            payment_settings: {
              save_default_payment_method: 'on_subscription',
              payment_method_types: [dto.method === 'card' ? 'card' : 'us_bank_account'],
            },
            expand: ['latest_invoice.payment_intent'],
          });

    await this.prisma.onboardSession.update({
      where: { id: session.id },
      data: { stripeSubscriptionId: sub.id, profiles: quantity, payMethod: dto.method },
    });
    return this.subscribeResult(sub, dto.method);
  }

  async paidStatus(auth: PurchaserAuth): Promise<{ status: string; advanced: boolean }> {
    const { session } = await this.requireStep(auth.clerkUserId, 'legal_accepted');
    if (session.plan !== 'paid') {
      throw new BadRequestException('Paid payment status applies to the paid plan only.');
    }
    if (!session.payMethod || !session.stripeSubscriptionId) {
      throw new BadRequestException('No subscription yet — call payment/subscribe first.');
    }
    const stripe = this.stripe.require();
    const sub = await stripe.subscriptions.retrieve(session.stripeSubscriptionId, {
      expand: ['latest_invoice.payment_intent'],
    });
    const invoice = typeof sub.latest_invoice === 'string' ? null : sub.latest_invoice;
    const pi =
      invoice && typeof invoice.payment_intent !== 'string' ? invoice.payment_intent : null;
    const advanced =
      session.payMethod === 'wire'
        ? true // invoice issued at subscribe; enforcement is the unpaid lockout
        : session.payMethod === 'card'
          ? sub.status === 'active'
          : sub.status === 'active' || pi?.status === 'processing';
    if (advanced) await this.advance(session, 'payment_on_file');
    return { status: sub.status, advanced };
  }

  // ---------------------------------------------------------------------------
  // Roles / import preference / org profile
  // ---------------------------------------------------------------------------

  async setRoles(
    auth: PurchaserAuth,
    dto: { roleMode: 'self' | 'invite'; designations?: RoleDesignation[] },
  ): Promise<{ ok: true }> {
    const { session } = await this.requireStep(auth.clerkUserId, 'payment_on_file');
    const designations: RoleDesignation[] = (dto.designations ?? []).map((d) => ({
      email: d.email.trim().toLowerCase(),
      role: d.role,
      ...(d.firstName?.trim() ? { firstName: d.firstName.trim() } : {}),
      ...(d.lastName?.trim() ? { lastName: d.lastName.trim() } : {}),
    }));
    if (dto.roleMode === 'invite') {
      const hasSuper = designations.some((d) => d.role === 'super' && EMAIL_RE.test(d.email));
      if (!hasSuper) {
        throw new BadRequestException(
          'Designate at least one Super Admin with a valid email address.',
        );
      }
    }
    await this.advance(session, 'roles_designated', {
      roleMode: dto.roleMode,
      roleDesignations: designations as unknown as Prisma.InputJsonValue,
    });
    return { ok: true };
  }

  async setImportPref(auth: PurchaserAuth, importMode: 'self' | 'managed'): Promise<{ ok: true }> {
    const { purchaser, session } = await this.requireStep(auth.clerkUserId, 'roles_designated');
    await this.advance(session, 'import_pref', { importMode });
    if (importMode === 'managed') {
      const rendered = renderOpsNotificationEmail('Managed import requested', [
        `Purchaser: ${purchaser.firstName ?? ''} ${purchaser.lastName ?? ''} <${purchaser.email}>`,
        `Organization: ${purchaser.orgName ?? 'unknown'}`,
        `Session: ${session.id}`,
        'Action: reach out within one business day to collect the client portfolio (Gherkin 1.8).',
      ]);
      try {
        await this.email.send({
          to: this.csNotifyEmail,
          kind: 'managed_import_requested',
          dedupeKey: `managed_import:${session.id}`,
          purchaserId: purchaser.id,
          ...rendered,
        });
      } catch (err) {
        // CS notification must not block the funnel; ops can also see the
        // import_mode flag on the tenant post-provision.
        this.logger.error(`Managed-import CS notification failed: ${(err as Error).message}`);
      }
    }
    return { ok: true };
  }

  async setOrg(
    auth: PurchaserAuth,
    dto: {
      orgProfile: {
        legalName: string;
        vertical?: string;
        teamSize?: string;
        timezone?: string;
        locale?: string;
        address?: { street: string; city: string; state: string; zip: string };
      };
      itAdminEmail?: string;
    },
  ): Promise<{ ok: true }> {
    const { session } = await this.requireStep(auth.clerkUserId, 'import_pref');
    const current = (session.orgProfile ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = {
      ...current,
      legalName: dto.orgProfile.legalName.trim(),
      ...(dto.orgProfile.vertical ? { vertical: dto.orgProfile.vertical } : {}),
      ...(dto.orgProfile.teamSize ? { teamSize: dto.orgProfile.teamSize } : {}),
      ...(dto.orgProfile.timezone ? { timezone: dto.orgProfile.timezone } : {}),
      ...(dto.orgProfile.locale ? { locale: dto.orgProfile.locale } : {}),
      ...(dto.orgProfile.address ? { address: dto.orgProfile.address } : {}),
    };
    const itAdminEmails = [...session.itAdminEmails];
    const itEmail = dto.itAdminEmail?.trim().toLowerCase();
    if (itEmail && EMAIL_RE.test(itEmail) && !itAdminEmails.includes(itEmail)) {
      itAdminEmails.push(itEmail);
    }
    await this.advance(session, 'org_setup', {
      orgProfile: merged as Prisma.InputJsonValue,
      itAdminEmails,
    });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Shared internals (also used by ProvisioningService)
  // ---------------------------------------------------------------------------

  /** Latest non-terminal session, if any. */
  async findActiveSession(purchaserId: string): Promise<OnboardSession | null> {
    return this.prisma.onboardSession.findFirst({
      where: { purchaserId, state: { notIn: ['provisioned', 'failed'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Purchaser + their latest session (active preferred, else most recent). */
  async loadPurchaserAndSession(clerkUserId: string): Promise<PurchaserSession> {
    const purchaser = await this.prisma.onboardPurchaser.findUnique({ where: { clerkUserId } });
    if (!purchaser) {
      throw new NotFoundException('Not registered — call POST /funnel/register first.');
    }
    const session =
      (await this.findActiveSession(purchaser.id)) ??
      (await this.prisma.onboardSession.findFirst({
        where: { purchaserId: purchaser.id },
        orderBy: { createdAt: 'desc' },
      }));
    if (!session) {
      throw new NotFoundException('No onboarding session — call POST /funnel/register first.');
    }
    return { purchaser, session };
  }

  private async requireStep(
    clerkUserId: string,
    min: OrderedFunnelState,
    opts?: { allowLocked?: boolean },
  ): Promise<PurchaserSession> {
    const loaded = await this.loadPurchaserAndSession(clerkUserId);
    if (!opts?.allowLocked && isLocked(loaded.session.state)) {
      throw new ConflictException(
        `Session is ${loaded.session.state} — funnel steps can no longer change.`,
      );
    }
    if (!isAtLeast(loaded.session.state, min)) {
      throw new BadRequestException(
        `Complete the "${min}" step first (session state: ${loaded.session.state}).`,
      );
    }
    return loaded;
  }

  private async advance(
    session: OnboardSession,
    to: OrderedFunnelState,
    data: Prisma.OnboardSessionUpdateInput = {},
  ): Promise<OnboardSession> {
    return this.prisma.onboardSession.update({
      where: { id: session.id },
      data: { ...data, state: nextState(session.state, to) },
    });
  }

  private async fetchClerkEmail(
    clerkUserId: string,
  ): Promise<{ email: string; verified: boolean }> {
    const user = await this.clerk.backend.users.getUser(clerkUserId);
    const primary =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ??
      user.emailAddresses[0];
    if (!primary?.emailAddress) {
      throw new BadRequestException('Your account has no email address.');
    }
    return {
      email: primary.emailAddress.toLowerCase(),
      verified: primary.verification?.status === 'verified',
    };
  }

  /** Find-or-create the PURCHASER's Stripe customer (pre-tenant). */
  private async ensurePurchaserCustomer(
    purchaser: OnboardPurchaser,
    stripe: Stripe,
  ): Promise<string> {
    if (purchaser.stripeCustomerId) return purchaser.stripeCustomerId;
    const name = [purchaser.firstName, purchaser.lastName].filter(Boolean).join(' ');
    const customer = await stripe.customers.create({
      email: purchaser.email,
      name: name || undefined,
      metadata: { purchaserId: purchaser.id, onboarding: '1' },
    });
    await this.prisma.onboardPurchaser.update({
      where: { id: purchaser.id },
      data: { stripeCustomerId: customer.id },
    });
    purchaser.stripeCustomerId = customer.id;
    return customer.id;
  }

  private subscribeResult(
    sub: Stripe.Subscription,
    method: 'card' | 'ach' | 'wire',
  ): {
    subscriptionId: string;
    status: string;
    clientSecret?: string | null;
    hostedInvoiceUrl?: string | null;
  } {
    const invoice = typeof sub.latest_invoice === 'string' ? null : sub.latest_invoice;
    if (method === 'wire') {
      return {
        subscriptionId: sub.id,
        status: sub.status,
        hostedInvoiceUrl: invoice?.hosted_invoice_url ?? null,
      };
    }
    const pi =
      invoice && typeof invoice.payment_intent !== 'string' ? invoice.payment_intent : null;
    return { subscriptionId: sub.id, status: sub.status, clientSecret: pi?.client_secret ?? null };
  }

  private async snapshot(
    purchaser: OnboardPurchaser,
    session: OnboardSession,
  ): Promise<FunnelSessionSnapshot> {
    const stripeInfo: FunnelSessionSnapshot['stripe'] = {};
    if (this.stripe.enabled && (session.stripeSetupIntentId || session.stripeSubscriptionId)) {
      const client = this.stripe.client!;
      try {
        if (session.stripeSetupIntentId) {
          stripeInfo.setupIntentStatus = (
            await client.setupIntents.retrieve(session.stripeSetupIntentId)
          ).status;
        }
        if (session.stripeSubscriptionId) {
          stripeInfo.subscriptionStatus = (
            await client.subscriptions.retrieve(session.stripeSubscriptionId)
          ).status;
        }
      } catch (err) {
        this.logger.warn(`Stripe snapshot lookup failed: ${(err as Error).message}`);
      }
    }
    return {
      sessionId: session.id,
      state: session.state,
      plan: session.plan,
      payMethod: session.payMethod,
      profiles: session.profiles,
      roleMode: session.roleMode,
      roleDesignations: session.roleDesignations,
      importMode: session.importMode,
      itAdminEmails: session.itAdminEmails,
      orgProfile: session.orgProfile,
      slugFinal: session.slugFinal,
      tenantId: session.tenantId,
      failureReason: session.failureReason,
      email: purchaser.email,
      firstName: purchaser.firstName,
      lastName: purchaser.lastName,
      orgName: purchaser.orgName,
      stripe: stripeInfo,
    };
  }

  private get slotsPriceId(): string {
    const id = this.config.get<string>('STRIPE_PRICE_SLOTS');
    if (!id) throw new BadRequestException('Slot price is not configured (STRIPE_PRICE_SLOTS).');
    return id;
  }

  private get overagePriceId(): string | undefined {
    return this.config.get<string>('STRIPE_PRICE_OVERAGE') || undefined;
  }

  private get wireDueDays(): number {
    const parsed = Number.parseInt(this.config.get<string>('ONBOARD_WIRE_DUE_DAYS') ?? '14', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
  }

  private get csNotifyEmail(): string {
    return this.config.get<string>('ONBOARD_CS_NOTIFY_EMAIL') || 'sales@capiro.ai';
  }
}
