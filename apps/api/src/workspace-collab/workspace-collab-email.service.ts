import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CollaboratorEmailReceipt, CollaboratorEmailStatus, SendInviteEmailDto } from './workspace-collab.dto.js';

type Invitation = { recipientId: string; email: string; recipientName: string; authorName: string;
  title: string; role: string; updatedAt: string; clientId: string | null; prospectId: string | null };
type InvitationContext = { tenantId: string; draftId: string; invitationId: string; actorId: string;
  invitation: Invitation | null; reason: string | null };
type Delivery = { id: string; draftId: string; requestedBy: string; status: Exclude<CollaboratorEmailStatus, 'not_requested'>;
  messageId: string | null; errorCode: string | null; updatedAt: Date };
const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeCode = (name: unknown) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'ProviderError';

/** Existing invitation identity is the dedupe key. SES has no idempotency key;
 * one committed receipt fences its only attempt, including across crashes.
 * No queue, automatic retry, implicit invitation send or delivery claim. */
@Injectable()
export class WorkspaceCollabEmailService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceCollabEmailService.name);
  private readonly ses: SESv2Client;
  private readonly appUrl: URL;
  private stopped = false;

  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService<AppConfig, true>) {
    this.ses = new SESv2Client({ region: config.get('AWS_REGION_DEFAULT', { infer: true }), maxAttempts: 1 });
    this.appUrl = new URL(config.get('NEWSLETTER_REVIEW_APP_URL', { infer: true }));
    if (!['http:', 'https:'].includes(this.appUrl.protocol) || this.appUrl.username || this.appUrl.password)
      throw new Error('NEWSLETTER_REVIEW_APP_URL must be a web URL without credentials');
  }

  onModuleDestroy() { this.stopped = true; this.ses.destroy(); }

  private async context(ctx: TenantContext, dto: SendInviteEmailDto): Promise<InvitationContext> {
    const base = this.config.get('WORKSPACE_API_BASE_URL', { infer: true });
    const secret = this.config.get('INTERNAL_SERVICE_SECRET', { infer: true });
    if (!base || !secret) throw new ServiceUnavailableException('Workspace invitation owner unavailable');
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new ServiceUnavailableException('Workspace invitation owner unavailable');
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/workspace-api/internal/workspace/collaborator-invitations/email-context`;
    url.search = ''; url.hash = '';
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-service-secret': secret },
        body: JSON.stringify({ tenantId: ctx.tenantId, actorId: ctx.clerkUserId, draftId: dto.draftId, invitationId: dto.invitationId }),
        redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch { throw new ServiceUnavailableException('Workspace invitation owner unavailable'); }
    if ([401, 403, 404].includes(response.status)) throw new NotFoundException('Invitation not found');
    if (!response.ok) throw new ServiceUnavailableException('Workspace invitation owner unavailable');
    let result: InvitationContext;
    try { result = await response.json() as InvitationContext; }
    catch { throw new ServiceUnavailableException('Workspace invitation response invalid'); }
    const item = result?.invitation;
    if (result?.tenantId !== ctx.tenantId || result.draftId !== dto.draftId || result.invitationId !== dto.invitationId ||
        result.actorId !== ctx.clerkUserId || !(item === null || (item &&
          ['recipientId', 'email', 'recipientName', 'authorName', 'title', 'role', 'updatedAt'].every(key => typeof item[key as keyof Invitation] === 'string') &&
          ['editor', 'reviewer', 'commenter', 'viewer'].includes(item.role) && Number.isFinite(Date.parse(item.updatedAt)) &&
          [item.clientId, item.prospectId].every(id => id === null || (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))) &&
          /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(item.email) && item.email.length <= 320)))
      throw new ServiceUnavailableException('Workspace invitation response invalid');
    return result;
  }

  private async read(ctx: TenantContext, dto: SendInviteEmailDto): Promise<Delivery | null> {
    return this.prisma.withTenant(ctx.tenantId, async tx => {
      // Read-side reconciliation consumes stale claims; it never redispatches.
      await tx.$executeRaw`UPDATE workspace_collaborator_email_deliveries
        SET status='outcome_unknown', error_code='RequestInterrupted', updated_at=now()
        WHERE tenant_id=${ctx.tenantId}::uuid AND id=${dto.invitationId}::uuid AND draft_id=${dto.draftId}::uuid
          AND requested_by=${ctx.clerkUserId} AND status IN ('claimed','sending') AND updated_at < now()-interval '10 minutes'`;
      const rows = await tx.$queryRaw<Delivery[]>`SELECT id, draft_id AS "draftId", requested_by AS "requestedBy", status,
        message_id AS "messageId", error_code AS "errorCode", updated_at AS "updatedAt"
        FROM workspace_collaborator_email_deliveries WHERE tenant_id=${ctx.tenantId}::uuid AND id=${dto.invitationId}::uuid`;
      const row = rows[0];
      if (row && (row.draftId !== dto.draftId || row.requestedBy !== ctx.clerkUserId))
        throw new NotFoundException('Invitation not found');
      return row ?? null;
    });
  }

  private receipt(dto: SendInviteEmailDto, row: Delivery | null): CollaboratorEmailReceipt {
    return { draftId: dto.draftId, invitationId: dto.invitationId, status: row?.status ?? 'not_requested',
      providerMessageId: row?.status === 'accepted' ? row.messageId : null,
      errorCode: row?.errorCode ?? null, updatedAt: row?.updatedAt.toISOString() ?? null };
  }

  async status(ctx: TenantContext, dto: SendInviteEmailDto): Promise<CollaboratorEmailReceipt> {
    const current = await this.context(ctx, dto);
    const row = await this.read(ctx, dto);
    if (!row && !current.invitation) throw new NotFoundException('Invitation not found');
    return this.receipt(dto, row);
  }

  async cancel(ctx: TenantContext, dto: SendInviteEmailDto): Promise<CollaboratorEmailReceipt> {
    const current = await this.context(ctx, dto);
    const prior = await this.read(ctx, dto);
    if (!prior && !current.invitation) throw new NotFoundException('Invitation not found');
    await this.prisma.withTenant(ctx.tenantId, async tx => {
      // Cancellation before an explicit send also consumes the invitation key.
      if (!prior) await tx.$executeRaw`INSERT INTO workspace_collaborator_email_deliveries
        (id,tenant_id,draft_id,requested_by,status,error_code)
        VALUES (${dto.invitationId}::uuid,${ctx.tenantId}::uuid,${dto.draftId}::uuid,${ctx.clerkUserId},'cancelled','CancelledByRequester')
        ON CONFLICT (id) DO NOTHING`;
      await tx.$executeRaw`UPDATE workspace_collaborator_email_deliveries SET status='cancelled',error_code='CancelledByRequester',updated_at=now()
        WHERE id=${dto.invitationId}::uuid AND tenant_id=${ctx.tenantId}::uuid AND draft_id=${dto.draftId}::uuid
          AND requested_by=${ctx.clerkUserId} AND status='claimed'`;
    });
    // Sending/accepted/unknown cannot be recalled. Return their actual state.
    return this.receipt(dto, await this.read(ctx, dto));
  }

  async sendInvite(ctx: TenantContext, dto: SendInviteEmailDto): Promise<CollaboratorEmailReceipt> {
    const current = await this.context(ctx, dto);
    const prior = await this.read(ctx, dto);
    if (prior) return this.receipt(dto, prior);
    const invitation = current.invitation;
    if (!invitation) throw new ConflictException({ code: safeCode(current.reason), message: 'Invitation is not eligible for email' });
    const claimed = await this.prisma.withTenant(ctx.tenantId, async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`INSERT INTO workspace_collaborator_email_deliveries
        (id,tenant_id,draft_id,requested_by,status)
        SELECT id,tenant_id,draft_id,${ctx.clerkUserId},'claimed' FROM ws_collaborator
        WHERE id=${dto.invitationId}::uuid AND tenant_id=${ctx.tenantId}::uuid AND draft_id=${dto.draftId}::uuid
          AND subject_id=${invitation.recipientId} AND invited_by_id=${ctx.clerkUserId} AND status::text='pending'
          AND updated_at=${new Date(invitation.updatedAt)}
        ON CONFLICT (id) DO NOTHING RETURNING id`;
      return rows.length === 1;
    });
    if (!claimed) {
      const row = await this.read(ctx, dto);
      if (!row) throw new ConflictException('Invitation changed; refresh before requesting email');
      return this.receipt(dto, row);
    }
    if (this.stopped || this.config.get('WORKSPACE_INVITE_EMAIL_ENABLED', { infer: true }) !== true) {
      await this.finish(ctx, dto, 'claimed', 'disabled', null, 'DeliveryDisabled');
      return this.receipt(dto, await this.read(ctx, dto));
    }
    // Recheck the canonical owner after the committed claim. Transport failure
    // consumes the claim; it cannot fall back to saved authority/content.
    let latest: InvitationContext;
    try { latest = await this.context(ctx, dto); }
    catch (error) {
      await this.finish(ctx, dto, 'claimed', 'cancelled', null, 'AccessUnavailable');
      throw error;
    }
    const snapshot = (value: Invitation) => JSON.stringify([value.recipientId, value.email, value.recipientName,
      value.authorName, value.title, value.role, value.updatedAt, value.clientId, value.prospectId]);
    if (!latest.invitation || snapshot(latest.invitation) !== snapshot(invitation)) {
      await this.finish(ctx, dto, 'claimed', 'cancelled', null, 'InvitationChanged');
      return this.receipt(dto, await this.read(ctx, dto));
    }
    if (this.stopped || this.config.get('WORKSPACE_INVITE_EMAIL_ENABLED', { infer: true }) !== true) {
      await this.finish(ctx, dto, 'claimed', 'disabled', null, 'DeliveryDisabled');
      return this.receipt(dto, await this.read(ctx, dto));
    }
    const sending = await this.prisma.withTenant(ctx.tenantId, tx => tx.$executeRaw`
      UPDATE workspace_collaborator_email_deliveries d SET status='sending',updated_at=now()
      FROM ws_collaborator i WHERE d.id=${dto.invitationId}::uuid AND d.tenant_id=${ctx.tenantId}::uuid
        AND d.draft_id=${dto.draftId}::uuid AND d.requested_by=${ctx.clerkUserId} AND d.status='claimed'
        AND i.id=d.id AND i.tenant_id=d.tenant_id AND i.draft_id=d.draft_id AND i.status::text='pending'
        AND i.subject_id=${invitation.recipientId} AND i.invited_by_id=${ctx.clerkUserId} AND i.updated_at=${new Date(invitation.updatedAt)}`);
    if (!sending) {
      await this.finish(ctx, dto, 'claimed', 'cancelled', null, 'InvitationChanged');
      return this.receipt(dto, await this.read(ctx, dto));
    }
    const destination = new URL('/modules/workspace', this.appUrl);
    destination.searchParams.set('draftId', dto.draftId);
    if (invitation.clientId) destination.searchParams.set('clientId', invitation.clientId);
    if (invitation.prospectId) destination.searchParams.set('prospectId', invitation.prospectId);
    const link = destination.href;
    const title = invitation.title.replace(/[\r\n\t]+/g, ' ').slice(0, 160);
    const author = invitation.authorName.replace(/[\r\n\t]+/g, ' ').slice(0, 100);
    const subject = `${author} invited you to collaborate on “${title}”`;
    const html = `<div><p>Hi ${escapeHtml(invitation.recipientName)},</p><p>${escapeHtml(author)} invited you to collaborate on <strong>${escapeHtml(title)}</strong> as ${escapeHtml(invitation.role)}.</p><p><a href="${escapeHtml(link)}">Open Workspace</a></p></div>`;
    const text = `Hi ${invitation.recipientName},\n\n${author} invited you to collaborate on "${title}" as ${invitation.role}.\n\nOpen Workspace: ${link}`;
    let status: 'accepted' | 'failed' | 'outcome_unknown';
    let messageId: string | null = null, errorCode: string | null = null;
    try {
      const result = await this.ses.send(new SendEmailCommand({
        FromEmailAddress: this.config.get('WORKSPACE_INVITE_EMAIL_FROM', { infer: true }), Destination: { ToAddresses: [invitation.email] },
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: {
          Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text, Charset: 'UTF-8' },
        } } },
      }), { abortSignal: AbortSignal.timeout(15_000) });
      messageId = result.MessageId || null;
      status = messageId ? 'accepted' : 'outcome_unknown';
      if (!messageId) errorCode = 'MissingMessageId';
    } catch (error) {
      const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      const code = failure?.$metadata?.httpStatusCode;
      status = code && code >= 400 && code < 500 && code !== 408 ? 'failed' : 'outcome_unknown';
      errorCode = safeCode(failure?.name);
      this.logger.warn('Workspace invitation email acceptance was not confirmed');
    }
    // A failed receipt write leaves sending. Exact retries/status reconcile to
    // unknown; never catch this error by re-entering the provider attempt.
    await this.finish(ctx, dto, 'sending', status, messageId, errorCode);
    return this.receipt(dto, await this.read(ctx, dto));
  }

  private async finish(ctx: TenantContext, dto: SendInviteEmailDto, from: 'claimed' | 'sending',
    status: Exclude<CollaboratorEmailStatus, 'not_requested' | 'claimed' | 'sending'>, messageId: string | null, errorCode: string | null) {
    await this.prisma.withTenant(ctx.tenantId, tx => tx.$executeRaw`UPDATE workspace_collaborator_email_deliveries
      SET status=${status},message_id=${messageId},error_code=${errorCode},updated_at=now()
      WHERE id=${dto.invitationId}::uuid AND tenant_id=${ctx.tenantId}::uuid AND draft_id=${dto.draftId}::uuid
        AND requested_by=${ctx.clerkUserId} AND status=${from}`);
  }
}
