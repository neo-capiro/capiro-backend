import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import {
  newsletterSourceClients,
  type NewsletterDesign,
  type NewsletterCampaignConfig,
} from '@capiro/shared/newsletter';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AppConfig } from '../config/config.schema.js';
import { NewsletterAccountProvider } from './newsletter-account-provider.js';

type Authority = {
  id: string;
  documentId: string;
  authorId: string;
  email: string;
  accountRole: string;
  design: NewsletterDesign;
  config: NewsletterCampaignConfig;
  sourceClientIds: string[];
  organizationId: string | null;
  authorRole: string;
  memberUserId: string | null;
  memberRole: string | null;
  cancelledAt: Date | null;
  activatedAt: Date | null;
  expiresAt: Date;
};
type Receipt = {
  id: string;
  status: string;
  accountRole: string;
  errorCode: string | null;
  organizationId: string;
  providerInvitationId: string | null;
  providerRole: string | null;
  attemptedAt: Date | null;
  attemptKind: string | null;
  leaseId: string | null;
  updatedAt: Date;
};
const admin = (role: string | null) => role === 'user_admin' || role === 'capiro_admin';
const messages: Record<string, string> = {
  checking: 'Checking the existing firm invitation. Check status before trying again.',
  sending: 'The account request is in progress. Check status before trying again.',
  invited:
    'Firm invitation sent. Newsletter access activates after joining and client access is available.',
  reused: 'Existing firm invitation reused. Its account role was preserved.',
  member_ready:
    'Firm membership is ready. Newsletter access still follows its document and client permissions.',
  role_conflict:
    'The existing firm invitation has a different account role. An administrator must review it in Manage users.',
  admin_required:
    'Newsletter request saved. A firm administrator must invite this person through Manage users.',
  waiting:
    'Another account request for this email is being checked. Retry this saved request after its status is known.',
  expired:
    'This invitation expired. Review it in Manage users and create a new newsletter request if needed.',
  revoked: 'The firm invitation was revoked. Review it in Manage users.',
  cancelled:
    'Newsletter access was cancelled. Any existing firm invitation and firm membership are retained.',
  failed: 'The account request could not be completed. Check status or review it in Manage users.',
  outcome_unknown:
    'The account result is unconfirmed. Check status or reconcile it in Manage users before sending another invitation.',
};
function publicReceipt(
  row: Pick<Receipt, 'id' | 'status' | 'accountRole' | 'attemptedAt' | 'errorCode'>,
) {
  return {
    id: row.id,
    status: row.status,
    accountRole: row.accountRole,
    message:
      row.errorCode === 'OrganizationNotLinked'
        ? 'This firm has no linked Clerk organization. Contact your administrator.'
        : messages[row.status] || messages.failed,
    canRetry: !row.attemptedAt && ['failed', 'waiting', 'admin_required'].includes(row.status),
  };
}
async function deadline<T>(operation: Promise<T>, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ProviderDeadline')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Neo approved this connection on October 7. Only Main calls Clerk; saved
 * Workspace requests are authoritative. Account roles never come from dispatch. */
@Injectable()
export class NewsletterAccountInvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: NewsletterAccountProvider,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private async authority(
    ctx: TenantContext,
    id: string,
    tx?: Prisma.TransactionClient,
    lock = false,
  ): Promise<Authority> {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id))
      throw new NotFoundException('Invitation not found');
    if (!tx)
      return this.prisma.withTenant(ctx.tenantId, (transaction) =>
        this.authority(ctx, id, transaction, lock),
      );
    const query = Prisma.sql`
      SELECT r.id, r.document_id AS "documentId", r.author_id AS "authorId", r.email,
        r.account_role AS "accountRole", r.source_client_ids AS "sourceClientIds", d.design, d.config,
        t.clerk_org_id AS "organizationId", am.role::text AS "authorRole",
        recipient.id AS "memberUserId", recipient.role AS "memberRole",
        r.cancelled_at AS "cancelledAt", r.activated_at AS "activatedAt", r.expires_at AS "expiresAt"
      FROM ws_newsletter_invitation r
      JOIN ws_newsletter_document d ON d.id=r.document_id AND d.tenant_id=r.tenant_id AND d.owner_id=r.author_id
      JOIN users a ON a.clerk_user_id=r.author_id AND a.id=${ctx.userId}::uuid
      JOIN tenant_memberships am ON am.user_id=a.id AND am.tenant_id=r.tenant_id AND am.status='active'
      JOIN tenants t ON t.id=r.tenant_id AND t.status='active'
      LEFT JOIN LATERAL (SELECT u.id, m.role::text AS role FROM users u
        JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id=r.tenant_id AND m.status='active'
        WHERE lower(u.email::text)=r.email LIMIT 1) recipient ON true
      WHERE r.id=${id}::uuid AND r.tenant_id=${ctx.tenantId}::uuid AND r.author_id=${ctx.clerkUserId}
      ${lock ? Prisma.sql`FOR SHARE OF r,d,am,t` : Prisma.empty}`;
    const row = (await tx.$queryRaw<Authority[]>(query))[0];
    if (!row) throw new NotFoundException('Invitation not found');
    for (const clientId of new Set([
      ...row.sourceClientIds,
      ...newsletterSourceClients(row.design, row.config.clientId),
    ])) {
      const client = await tx.$queryRaw<Array<{ allowed: boolean }>>`
        SELECT (NOT c.memory_wall OR (EXISTS (SELECT 1 FROM client_memory_access a WHERE a.client_id=c.id AND a.user_id=${ctx.userId}::uuid)
          AND (${row.memberUserId}::uuid IS NULL OR EXISTS (SELECT 1 FROM client_memory_access a WHERE a.client_id=c.id AND a.user_id=${row.memberUserId}::uuid)))) AS allowed
        FROM clients c WHERE c.id=${clientId}::uuid AND c.tenant_id=${ctx.tenantId}::uuid`;
      if (!client[0]?.allowed) throw new NotFoundException('Invitation not found');
    }
    return row;
  }
  private state(row: Authority) {
    if (row.cancelledAt) return 'cancelled';
    if (row.expiresAt.getTime() <= Date.now()) return 'expired';
    if (row.memberUserId && (row.accountRole !== 'admin' || admin(row.memberRole)))
      return 'member_ready';
    if (!admin(row.authorRole)) return 'admin_required';
    return null;
  }
  private receipt(ctx: TenantContext, id: string) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.newsletterAccountInvitation.findFirst({ where: { id, tenantId: ctx.tenantId } }),
    );
  }
  private async finish(
    ctx: TenantContext,
    receipt: Receipt,
    data: Prisma.NewsletterAccountInvitationUpdateManyMutationInput,
  ) {
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.newsletterAccountInvitation.updateMany({
        where: { id: receipt.id, tenantId: ctx.tenantId, leaseId: receipt.leaseId },
        data: { ...data, updatedAt: new Date() },
      }),
    );
    const current = await this.receipt(ctx, receipt.id);
    return publicReceipt(current!);
  }
  private redirect() {
    const explicit = this.config.get('INVITATION_REDIRECT_URL', { infer: true });
    if (explicit) return explicit;
    const origin = this.config.get('WEB_ORIGIN', { infer: true })?.split(',')[0]?.trim();
    return `${origin && /^https?:\/\//.test(origin) ? origin.replace(/\/$/, '') : 'https://app.capiro.ai'}/sign-up`;
  }
  private async actor(row: Authority) {
    const members = await deadline(this.provider.actor(row.organizationId!, row.authorId));
    if (
      !members.data.some(
        (member) => member.role === 'org:admin' && member.publicUserData?.userId === row.authorId,
      )
    )
      throw new BadRequestException('Current firm administrator access is required in Clerk.');
  }
  private async pending(row: Authority) {
    const until = Date.now() + 12_000;
    const matches: Awaited<ReturnType<NewsletterAccountProvider['pending']>>['data'] = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const remaining = until - Date.now();
      if (remaining <= 0) throw new Error('ProviderDeadline');
      const page = await deadline(this.provider.pending(row.organizationId!, offset), remaining);
      const found = page.data.filter(
        (item) =>
          item.emailAddress.trim().toLowerCase() === row.email &&
          item.organizationId === row.organizationId &&
          item.status === 'pending' &&
          item.expiresAt > Date.now(),
      );
      matches.push(...found);
      if (offset + page.data.length >= page.totalCount) return matches;
      if (!page.data.length) throw new Error('IncompleteProviderPage');
    }
    throw new Error('ProviderCatalogLimit');
  }
  private async claim(ctx: TenantContext, row: Authority) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`newsletter-account:${ctx.tenantId}:${row.email}`},0))`;
      const fresh = await this.authority(ctx, row.id, tx, true);
      const prior = await tx.newsletterAccountInvitation.findFirst({
        where: { id: row.id, tenantId: ctx.tenantId },
      });
      const state = this.state(fresh);
      if (state)
        return {
          view: publicReceipt({
            id: row.id,
            status: state,
            accountRole: row.accountRole,
            attemptedAt: prior?.attemptedAt || null,
            errorCode: null,
          }),
        };
      if (!fresh.organizationId)
        return {
          view: publicReceipt({
            id: row.id,
            status: 'failed',
            accountRole: fresh.accountRole,
            attemptedAt: prior?.attemptedAt || null,
            errorCode: 'OrganizationNotLinked',
          }),
        };
      if (
        prior &&
        prior.organizationId !== fresh.organizationId &&
        (prior.attemptedAt || prior.providerInvitationId)
      )
        return { view: publicReceipt({ ...prior, status: 'failed' }) };
      if (
        prior?.attemptedAt ||
        prior?.providerInvitationId ||
        (prior?.status === 'checking' && prior.updatedAt.getTime() > Date.now() - 120_000)
      )
        return { view: publicReceipt(prior) };
      const overlap = await tx.newsletterAccountInvitation.findFirst({
        where: {
          tenantId: ctx.tenantId,
          email: row.email,
          organizationId: fresh.organizationId,
          id: { not: row.id },
          OR: [
            { status: { in: ['sending', 'outcome_unknown'] } },
            { status: 'checking', updatedAt: { gt: new Date(Date.now() - 120_000) } },
          ],
        },
      });
      const receipt = await tx.newsletterAccountInvitation.upsert({
        where: { id: row.id },
        create: {
          id: row.id,
          tenantId: ctx.tenantId,
          documentId: row.documentId,
          authorId: row.authorId,
          email: row.email,
          organizationId: fresh.organizationId,
          accountRole: row.accountRole,
          status: overlap ? 'waiting' : 'checking',
          leaseId: randomUUID(),
        },
        update: {
          organizationId: fresh.organizationId,
          status: overlap ? 'waiting' : 'checking',
          leaseId: randomUUID(),
          errorCode: null,
          updatedAt: new Date(),
        },
      });
      return overlap ? { view: publicReceipt(receipt) } : { receipt, row: fresh };
    });
  }
  private async beginAttempt(ctx: TenantContext, receipt: Receipt, kind: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await this.authority(ctx, receipt.id, tx, true);
      if (
        this.state(row) ||
        (kind === 'promote_member' && !row.memberUserId) ||
        (kind === 'create_invitation' && row.memberUserId)
      )
        return null;
      if (!admin(row.authorRole) || row.organizationId !== receipt.organizationId) return null;
      const result = await tx.newsletterAccountInvitation.updateMany({
        where: {
          id: receipt.id,
          tenantId: ctx.tenantId,
          leaseId: receipt.leaseId,
          status: 'checking',
          attemptedAt: null,
        },
        data: {
          status: 'sending',
          attemptedAt: new Date(),
          attemptKind: kind,
          updatedAt: new Date(),
        },
      });
      if (!result.count) return null;
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: 'newsletter.account_invitation.attempted',
          entityType: 'newsletter_invitation',
          entityId: receipt.id,
          after: { accountRole: row.accountRole, kind },
        },
      });
      return row;
    });
  }
  async dispatch(ctx: TenantContext, id: string) {
    let row = await this.authority(ctx, id);
    if (!row.organizationId)
      return publicReceipt({
        id,
        status: 'failed',
        accountRole: row.accountRole,
        attemptedAt: null,
        errorCode: 'OrganizationNotLinked',
      });
    const claimed = await this.claim(ctx, row);
    if (!claimed.receipt) return claimed.view!;
    const receipt = claimed.receipt;
    row = claimed.row!;
    try {
      await this.actor(row);
      if (row.memberUserId && row.accountRole === 'admin' && !admin(row.memberRole)) {
        await this.actor(row);
        const permitted = await this.beginAttempt(ctx, receipt, 'promote_member');
        if (!permitted) return this.status(ctx, id);
        await deadline(this.provider.promote(ctx, permitted.memberUserId!));
        await this.finish(ctx, receipt, { status: 'member_ready' });
      } else {
        const existing = await this.pending(row);
        if (existing.length) {
          const conflict =
            existing.length !== 1 ||
            (row.accountRole === 'admin' && existing[0]!.role !== 'org:admin');
          await this.finish(ctx, receipt, {
            status: conflict ? 'role_conflict' : 'reused',
            providerInvitationId: existing[0]!.id,
            providerRole: existing[0]!.role,
          });
        } else {
          await this.actor(row);
          if (!(await this.beginAttempt(ctx, receipt, 'create_invitation')))
            return this.status(ctx, id);
          const created = await deadline(
            this.provider.create(
              receipt.organizationId,
              row.authorId,
              row.email,
              row.accountRole === 'admin' ? 'org:admin' : 'org:member',
              this.redirect(),
              ctx.tenantId,
              id,
            ),
          );
          if (
            created.organizationId !== row.organizationId ||
            created.emailAddress.trim().toLowerCase() !== row.email
          )
            throw new Error('UnexpectedProviderReceipt');
          await this.finish(ctx, receipt, {
            status: 'invited',
            providerInvitationId: created.id,
            providerRole: created.role,
          });
        }
      }
    } catch (error) {
      const live = await this.receipt(ctx, id);
      await this.finish(ctx, receipt, {
        status: live?.attemptedAt ? 'outcome_unknown' : 'failed',
        errorCode:
          error instanceof BadRequestException ? 'ClerkAdminUnavailable' : 'ProviderUnavailable',
      });
    }
    await this.authority(ctx, id); // Withhold the response after an access change.
    return publicReceipt((await this.receipt(ctx, id))!);
  }
  async status(ctx: TenantContext, id: string) {
    const row = await this.authority(ctx, id),
      receipt = await this.receipt(ctx, id);
    const local = this.state(row);
    if (local)
      return publicReceipt({
        id,
        status: local,
        accountRole: row.accountRole,
        attemptedAt: receipt?.attemptedAt || null,
        errorCode: null,
      });
    if (!receipt)
      return publicReceipt({
        id,
        status: 'waiting',
        accountRole: row.accountRole,
        attemptedAt: null,
        errorCode: null,
      });
    if (row.organizationId !== receipt.organizationId)
      return publicReceipt({ ...receipt, status: 'failed' });
    if (
      ['checking', 'sending'].includes(receipt.status) &&
      receipt.updatedAt.getTime() > Date.now() - 120_000
    )
      return publicReceipt(receipt);
    if (receipt.status === 'checking' && !receipt.attemptedAt && !receipt.providerInvitationId) {
      const recovered = await this.finish(ctx, receipt, {
        status: 'waiting',
        leaseId: randomUUID(),
      });
      await this.authority(ctx, id);
      return recovered;
    }
    try {
      await this.actor(row);
      const remote = receipt.providerInvitationId
        ? await deadline(this.provider.get(receipt.organizationId, receipt.providerInvitationId))
        : (await this.pending(row)).find(
            (item) => item.publicMetadata?.capiro_newsletter_invitation_id === id,
          );
      if (
        remote &&
        remote.organizationId === receipt.organizationId &&
        remote.emailAddress.trim().toLowerCase() === row.email
      ) {
        const status =
          remote.status === 'revoked'
            ? 'revoked'
            : remote.status === 'expired' || remote.expiresAt <= Date.now()
              ? 'expired'
              : remote.status === 'accepted'
                ? 'invited'
                : row.accountRole === 'admin' && remote.role !== 'org:admin'
                  ? 'role_conflict'
                  : receipt.status === 'reused'
                    ? 'reused'
                    : 'invited';
        await this.finish(ctx, receipt, {
          status,
          providerInvitationId: remote.id,
          providerRole: remote.role,
          errorCode: null,
        });
      } else if (receipt.attemptedAt)
        await this.finish(ctx, receipt, { status: 'outcome_unknown' });
    } catch {
      /* A read failure never resets the recorded provider attempt. */
    }
    await this.authority(ctx, id);
    return publicReceipt((await this.receipt(ctx, id))!);
  }
}
