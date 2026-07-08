import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthTenantContext } from '@capiro/auth';
import { effectiveClientSlots } from '@capiro/shared';
import type { OnboardTaskKey, OnboardTaskStatus } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantResolverService } from '../auth/tenant-resolver.service.js';
import { EmailService } from '../email/email.service.js';
import { renderItAdminInviteEmail } from '../email/email-templates.js';

const IT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SetupTaskRow {
  it_email: OnboardTaskStatus;
  import: OnboardTaskStatus;
  firm_ai: OnboardTaskStatus;
  invites: OnboardTaskStatus;
}

export interface SetupState {
  complete: boolean;
  tasks: SetupTaskRow;
  orgName: string;
  slug: string;
  plan: 'trial' | 'paid';
  imported: number;
  cap: number;
  trialEndsAt: string | null;
  itInvites: Array<{
    id: string;
    email: string;
    status: string;
    provider: string | null;
    expiresAt: string;
  }>;
}

/**
 * Flow-2A external setup dashboard state + org-level task machine.
 *
 * Multi-admin safety (Gherkin 2A): every task transition is a compare-and-set
 * (`updateMany where status=from`) so two admins working in parallel cannot
 * double-run a step — the loser gets a 409 and refetches.
 *
 * Setup completion (`invites` task done) is THE trial-clock anchor: the
 * 30-day countdown starts when the team invites go out (Gherkin Flow 3),
 * stamped here as tenants.trial_ends_at.
 */
@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantResolverService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  private get publicBaseUrl(): string {
    return (
      this.config.get<string>('ONBOARD_PUBLIC_BASE_URL') ?? 'https://onboarding.capiro.ai'
    ).replace(/\/$/, '');
  }

  /** Admin-only mutation gate — the dashboard is an admin surface. */
  private assertAdmin(ctx: AuthTenantContext): void {
    const role = (ctx.role ?? '').toLowerCase();
    if (!role.includes('admin')) {
      throw new ForbiddenException('Firm setup is limited to admins');
    }
  }

  async getState(ctx: AuthTenantContext): Promise<SetupState> {
    const tenantId = await this.tenants.resolveTenantUuid(ctx);
    const [tenant, tasks, invites, imported] = await Promise.all([
      this.prisma.withSystem((tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: {
            name: true,
            slug: true,
            billingStatus: true,
            clientSlots: true,
            trialEndsAt: true,
            onboardingFlowVersion: true,
          },
        }),
      ),
      this.prisma.onboardSetupTask.findMany({ where: { tenantId } }),
      this.prisma.onboardItInvite.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true, status: true, provider: true, expiresAt: true },
      }),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.client.count({ where: { tenantId, status: { not: 'archived' } } }),
      ),
    ]);
    if (!tenant) throw new NotFoundException('Tenant not found');

    const byKey = new Map(tasks.map((t) => [t.task, t.status]));
    const taskRow: SetupTaskRow = {
      it_email: byKey.get('it_email') ?? 'none',
      import: byKey.get('import') ?? 'none',
      firm_ai: byKey.get('firm_ai') ?? 'none',
      invites: byKey.get('invites') ?? 'none',
    };
    return {
      // Legacy tenants (no onboarding flow) are always "complete" — the
      // in-app SetupGate keys off this and must never hold them.
      complete: tenant.onboardingFlowVersion !== 1 || taskRow.invites === 'done',
      tasks: taskRow,
      orgName: tenant.name,
      slug: tenant.slug,
      plan: tenant.billingStatus === 'trialing' ? 'trial' : 'paid',
      imported,
      // A trial always gets at least the 10-profile allowance (Gherkin Flow 1:
      // "10 client profile limit") even if the tenant row was stamped with a
      // smaller/zero clientSlots — the import UI drives selection off this cap.
      cap: effectiveClientSlots(tenant.billingStatus, tenant.clientSlots),
      trialEndsAt: tenant.trialEndsAt ? tenant.trialEndsAt.toISOString() : null,
      itInvites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        status: i.status,
        provider: i.provider,
        expiresAt: i.expiresAt.toISOString(),
      })),
    };
  }

  /**
   * Compare-and-set task transition. 409 when another admin already moved the
   * task (the client refetches and reconciles).
   */
  async transitionTask(
    ctx: AuthTenantContext,
    task: OnboardTaskKey,
    from: OnboardTaskStatus,
    to: OnboardTaskStatus,
  ): Promise<{ task: OnboardTaskKey; status: OnboardTaskStatus }> {
    this.assertAdmin(ctx);
    const tenantId = await this.tenants.resolveTenantUuid(ctx);
    if (task === 'invites') {
      throw new BadRequestException('The invites step completes via /setup/complete');
    }
    const res = await this.prisma.onboardSetupTask.updateMany({
      where: { tenantId, task, status: from },
      data: {
        status: to,
        ...(to === 'done'
          ? { completedBy: ctx.clerkUserId, completedAt: new Date() }
          : { completedBy: null, completedAt: null }),
      },
    });
    if (res.count === 0) {
      throw new ConflictException(`Task ${task} is no longer '${from}' — refresh`);
    }
    return { task, status: to };
  }

  /** Invite an(other) IT admin. Multiple simultaneous contacts are allowed. */
  async createItInvite(ctx: AuthTenantContext, email: string): Promise<SetupState['itInvites']> {
    this.assertAdmin(ctx);
    const tenantId = await this.tenants.resolveTenantUuid(ctx);
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes('@')) throw new BadRequestException('A valid email is required');

    const tenant = await this.prisma.withSystem((tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    );
    await this.sendItInvite(tenantId, tenant?.name ?? 'your firm', normalized, ctx.clerkUserId);

    // First contact flips the card out of 'none'.
    await this.prisma.onboardSetupTask.updateMany({
      where: { tenantId, task: 'it_email', status: 'none' },
      data: { status: 'waiting' },
    });

    const state = await this.getState(ctx);
    return state.itInvites;
  }

  private async sendItInvite(
    tenantId: string,
    orgName: string,
    email: string,
    createdBy: string,
  ): Promise<void> {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await this.prisma.onboardItInvite.create({
      data: {
        tenantId,
        email,
        tokenHash,
        expiresAt: new Date(Date.now() + IT_INVITE_TTL_MS),
        createdBy,
      },
    });
    const rendered = renderItAdminInviteEmail(`${this.publicBaseUrl}/it/${rawToken}`, orgName);
    await this.email.send({
      to: email,
      kind: 'it_admin_invite',
      dedupeKey: `it:${tenantId}:${email}:${tokenHash.slice(0, 8)}`,
      tenantId,
      ...rendered,
    });
  }

  /** Re-send an IT invite: rotates the token (old link dies), extends expiry. */
  async resendItInvite(ctx: AuthTenantContext, inviteId: string): Promise<{ ok: true }> {
    this.assertAdmin(ctx);
    const tenantId = await this.tenants.resolveTenantUuid(ctx);
    const invite = await this.prisma.onboardItInvite.findFirst({
      where: { id: inviteId, tenantId },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.status === 'granted' || invite.status === 'verified') {
      throw new BadRequestException('This IT contact already connected');
    }
    const tenant = await this.prisma.withSystem((tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    );
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await this.prisma.onboardItInvite.update({
      where: { id: invite.id },
      data: {
        tokenHash,
        status: 'sent',
        expiresAt: new Date(Date.now() + IT_INVITE_TTL_MS),
      },
    });
    const rendered = renderItAdminInviteEmail(
      `${this.publicBaseUrl}/it/${rawToken}`,
      tenant?.name ?? 'your firm',
    );
    await this.email.send({
      to: invite.email,
      kind: 'it_admin_invite',
      dedupeKey: `it:${tenantId}:${invite.email}:${tokenHash.slice(0, 8)}`,
      tenantId,
      ...rendered,
    });
    return { ok: true };
  }

  /**
   * Finalize setup after the team invites were sent (Gherkin 2A.5). Gated on
   * email + import only — firm AI settings are OPTIONAL (Ninja 2026-07-08);
   * flips `invites` to done and — for trials — starts the 30-day clock
   * (tenants.trial_ends_at) exactly once.
   */
  async completeSetup(ctx: AuthTenantContext): Promise<SetupState> {
    this.assertAdmin(ctx);
    const tenantId = await this.tenants.resolveTenantUuid(ctx);
    const tasks = await this.prisma.onboardSetupTask.findMany({ where: { tenantId } });
    const byKey = new Map(tasks.map((t) => [t.task, t.status]));
    const blockers = (['it_email', 'import'] as const).filter((k) => byKey.get(k) !== 'done');
    if (blockers.length > 0) {
      throw new BadRequestException(
        `Setup steps still pending: ${blockers.join(', ')} — the team invites step unlocks once they're complete`,
      );
    }

    await this.prisma.onboardSetupTask.updateMany({
      where: { tenantId, task: 'invites', status: { not: 'done' } },
      data: { status: 'done', completedBy: ctx.clerkUserId, completedAt: new Date() },
    });

    // Trial clock: starts at setup completion, never re-stamped.
    const stamped = await this.prisma.withSystem((tx) =>
      tx.tenant.updateMany({
        where: { id: tenantId, billingStatus: 'trialing', trialEndsAt: null },
        data: { trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
      }),
    );
    if (stamped.count > 0) {
      await this.prisma.onboardBillingEvent.create({
        data: {
          tenantId,
          type: 'trial_clock_started',
          data: { by: ctx.clerkUserId },
          actor: ctx.clerkUserId,
        },
      });
      this.logger.log(`Trial clock started for tenant ${tenantId}`);
    }
    return this.getState(ctx);
  }
}
