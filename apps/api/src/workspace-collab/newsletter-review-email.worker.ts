import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  newsletterSourceClients,
  type NewsletterCampaignConfig,
  type NewsletterDesign,
} from '@capiro/shared/newsletter';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

type RequestIdentity = { id: string; tenantId: string };
type ReviewMessage = {
  documentId: string;
  commentId: string;
  recipientId: string;
  userId: string;
  authorUserId: string;
  email: string;
  name: string;
  authorName: string;
  title: string;
  message: string;
  design: NewsletterDesign;
  config: NewsletterCampaignConfig;
  sourceClientIds: string[];
};
type Outcome = 'sent' | 'failed' | 'cancelled' | 'outcome_unknown';
const BATCH_SIZE = 20;
const escape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Main API sends server-derived comment notifications. It only reads ws_*
 * tables. The durable receipt claims one provider attempt across replicas;
 * unknown outcomes are terminal so a timeout cannot duplicate an email. */
@Injectable()
export class NewsletterReviewEmailWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NewsletterReviewEmailWorker.name);
  private readonly ses: SESv2Client;
  private readonly appUrl: URL;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.ses = new SESv2Client({
      region: config.get('AWS_REGION_DEFAULT', { infer: true }),
      maxAttempts: 1,
    });
    this.appUrl = new URL(config.get('NEWSLETTER_REVIEW_APP_URL', { infer: true }));
    if (
      !['http:', 'https:'].includes(this.appUrl.protocol) ||
      this.appUrl.username ||
      this.appUrl.password
    )
      throw new Error('NEWSLETTER_REVIEW_APP_URL must be a web URL without credentials');
  }
  private enabled() {
    return this.config.get('NEWSLETTER_REVIEW_EMAIL_ENABLED', { infer: true }) === true;
  }
  onModuleInit() {
    if (!this.enabled()) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => this.logger.warn('Newsletter review email processing failed'));
    }, 30_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.ses.destroy();
  }
  async tick(): Promise<void> {
    if (this.busy || this.stopped || !this.enabled()) return;
    this.busy = true;
    try {
      // Trusted cross-tenant discovery returns identities only. Claims and
      // outcomes are tenant-scoped and committed with an audit event.
      const stale = await this.prisma.withSystem(
        (tx) => tx.$queryRaw<RequestIdentity[]>`
        SELECT id, tenant_id AS "tenantId" FROM newsletter_review_email_deliveries
        WHERE status IN ('claimed', 'sending') AND updated_at < now() - interval '10 minutes'
        ORDER BY updated_at, id LIMIT ${BATCH_SIZE}`,
      );
      for (const item of stale)
        await this.finish(item, 'outcome_unknown', undefined, 'WorkerInterrupted');
      const requests = await this.prisma.withSystem(
        (tx) => tx.$queryRaw<RequestIdentity[]>`
        SELECT r.id, r.tenant_id AS "tenantId" FROM ws_newsletter_review_email_request r
        LEFT JOIN newsletter_review_email_deliveries d ON d.id = r.id
        WHERE d.id IS NULL ORDER BY r.created_at, r.id LIMIT ${BATCH_SIZE}`,
      );
      for (const item of requests) {
        if (this.stopped || !this.enabled()) break;
        try {
          await this.deliver(item);
        } catch {
          this.logger.warn('Newsletter review email request could not be processed');
        }
      }
    } finally {
      this.busy = false;
    }
  }
  private async claim(item: RequestIdentity): Promise<boolean> {
    return this.prisma.withTenant(item.tenantId, async (tx) => {
      const claimed = await tx.$queryRaw<
        Array<{ id: string; documentId: string; commentId: string }>
      >`
        INSERT INTO newsletter_review_email_deliveries (id, tenant_id, document_id, comment_id, recipient_id, status)
        SELECT id, tenant_id, document_id, comment_id, recipient_id, 'claimed'
        FROM ws_newsletter_review_email_request WHERE id = ${item.id}::uuid AND tenant_id = ${item.tenantId}::uuid
        ON CONFLICT (id) DO NOTHING RETURNING id, document_id AS "documentId", comment_id AS "commentId"`;
      const claim = claimed[0];
      if (!claim) return false;
      await tx.auditLog.create({
        data: {
          tenantId: item.tenantId,
          action: 'newsletter_review_email_claimed',
          entityType: 'newsletter_review_email',
          entityId: item.id,
          after: { status: 'claimed', documentId: claim.documentId, commentId: claim.commentId },
        },
      });
      return true;
    });
  }
  private async authorizedMessage(item: RequestIdentity): Promise<ReviewMessage | null> {
    return this.prisma.withTenant(item.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<ReviewMessage[]>`
        SELECT d.id AS "documentId", c.id AS "commentId", r.recipient_id AS "recipientId",
          u.id AS "userId", a.id AS "authorUserId", u.email::text AS email,
          COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), 'Team member') AS name,
          COALESCE(NULLIF(trim(concat_ws(' ', a.first_name, a.last_name)), ''), 'A team member') AS "authorName",
          d.name AS title, c.message, d.design, d.config, r.source_client_ids AS "sourceClientIds"
        FROM ws_newsletter_review_email_request r
        JOIN ws_newsletter_document d ON d.id = r.document_id AND d.tenant_id = r.tenant_id
        JOIN ws_newsletter_comment c ON c.id = r.comment_id AND c.tenant_id = r.tenant_id AND c.document_id = r.document_id
        JOIN ws_newsletter_comment root ON root.id = r.root_id AND root.tenant_id = r.tenant_id AND root.document_id = r.document_id
        JOIN ws_newsletter_thread_watcher w ON w.root_id = r.root_id AND w.tenant_id = r.tenant_id AND w.document_id = r.document_id AND w.user_id = r.recipient_id
        JOIN users u ON u.clerk_user_id = r.recipient_id
        JOIN tenant_memberships m ON m.user_id = u.id AND m.tenant_id = r.tenant_id AND m.status = 'active'
        JOIN users a ON a.clerk_user_id = c.author_id
        JOIN tenant_memberships am ON am.user_id = a.id AND am.tenant_id = r.tenant_id AND am.status = 'active'
        JOIN tenants t ON t.id = r.tenant_id AND t.status = 'active'
        WHERE r.id = ${item.id}::uuid AND r.tenant_id = ${item.tenantId}::uuid
          AND root.parent_id IS NULL AND coalesce(c.parent_id, c.id) = root.id
          AND c.author_id <> r.recipient_id
          AND (d.owner_id = r.recipient_id OR EXISTS (
            SELECT 1 FROM ws_newsletter_reviewer g WHERE g.document_id = d.id AND g.tenant_id = d.tenant_id AND g.user_id = r.recipient_id
          ))
          AND (d.owner_id = c.author_id OR EXISTS (
            SELECT 1 FROM ws_newsletter_reviewer g WHERE g.document_id = d.id AND g.tenant_id = d.tenant_id AND g.user_id = c.author_id AND g.role IN ('commenter', 'editor')
          ))`;
      const message = rows[0];
      if (
        !message ||
        !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(message.email) ||
        message.email.length > 320
      )
        return null;
      // Keep the original source checks even after the document removes a
      // client block. An edit cannot remove a queued comment's access wall.
      for (const clientId of new Set([
        ...message.sourceClientIds,
        ...newsletterSourceClients(message.design, message.config.clientId),
      ])) {
        const access = await tx.$queryRaw<Array<{ allowed: boolean }>>`
          SELECT (NOT c.memory_wall OR (
            EXISTS (SELECT 1 FROM client_memory_access a WHERE a.client_id = c.id AND a.user_id = ${message.userId}::uuid)
            AND EXISTS (SELECT 1 FROM client_memory_access a WHERE a.client_id = c.id AND a.user_id = ${message.authorUserId}::uuid)
          )) AS allowed FROM clients c WHERE c.id = ${clientId}::uuid AND c.tenant_id = ${item.tenantId}::uuid`;
        if (!access[0]?.allowed) return null;
      }
      return message;
    });
  }
  private async deliver(item: RequestIdentity) {
    if (!(await this.claim(item))) return;
    // Re-evaluate current membership, review grant, subscription and every
    // source client after the claim, immediately before the provider boundary.
    const message = await this.authorizedMessage(item);
    if (!message) {
      await this.finish(item, 'cancelled', undefined, 'AccessUnavailable');
      return;
    }
    if (this.stopped || !this.enabled()) {
      await this.finish(item, 'cancelled', undefined, 'DeliveryDisabled');
      return;
    }
    const sending = await this.prisma.withTenant(item.tenantId, async (tx) => {
      const result = await tx.newsletterReviewEmailDelivery.updateMany({
        where: { id: item.id, status: 'claimed' },
        data: { status: 'sending', updatedAt: new Date() },
      });
      if (result.count)
        await tx.auditLog.create({
          data: {
            tenantId: item.tenantId,
            action: 'newsletter_review_email_sending',
            entityType: 'newsletter_review_email',
            entityId: item.id,
            after: { status: 'sending' },
          },
        });
      return result.count > 0;
    });
    if (!sending) return;
    const link = new URL(
      `/workspace/newsletters/${encodeURIComponent(message.documentId)}/review`,
      this.appUrl,
    ).href;
    const title = message.title.replace(/[\r\n\t]+/g, ' ').slice(0, 160);
    const author = message.authorName.replace(/[\r\n\t]+/g, ' ').slice(0, 100);
    const excerpt = message.message.slice(0, 2000);
    const subject = `${author} commented on “${title}”`;
    const html = `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#242b2a"><p>Hi ${escape(message.name)},</p><p>${escape(author)} commented on <strong>${escape(title)}</strong> in Capiro Workspace.</p><blockquote style="white-space:pre-wrap">${escape(excerpt)}</blockquote><p><a href="${escape(link)}">Open comment thread</a></p><p>Manage email notifications from this thread’s Edit notifications control in Capiro.</p></div>`;
    const text = `Hi ${message.name},\n\n${author} commented on "${title}" in Capiro Workspace.\n\n${excerpt}\n\nOpen comment thread: ${link}\n\nManage email notifications from this thread's Edit notifications control in Capiro.`;
    let result: { MessageId?: string };
    try {
      result = await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: this.config.get('WORKSPACE_INVITE_EMAIL_FROM', { infer: true }),
          Destination: { ToAddresses: [message.email] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: html, Charset: 'UTF-8' },
                Text: { Data: text, Charset: 'UTF-8' },
              },
            },
          },
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
    } catch (error) {
      const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      const code = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(failure?.name || '')
        ? failure.name
        : 'ProviderError';
      const status = failure?.$metadata?.httpStatusCode;
      await this.finish(
        item,
        status && status >= 400 && status < 500 && status !== 408 ? 'failed' : 'outcome_unknown',
        undefined,
        code,
      );
      return;
    }
    // Receipt persistence failures after acceptance leave 'sending'. The stale
    // sweep marks it unknown; they never trigger a second provider call.
    await this.finish(
      item,
      result.MessageId ? 'sent' : 'outcome_unknown',
      result.MessageId,
      result.MessageId ? undefined : 'MissingMessageId',
    );
  }
  private async finish(
    item: RequestIdentity,
    status: Outcome,
    messageId?: string,
    errorCode?: string,
  ) {
    await this.prisma.withTenant(item.tenantId, async (tx) => {
      const updated = await tx.newsletterReviewEmailDelivery.updateMany({
        where: { id: item.id, status: { in: ['claimed', 'sending'] } },
        data: {
          status,
          messageId: messageId || null,
          errorCode: errorCode || null,
          updatedAt: new Date(),
        },
      });
      if (updated.count)
        await tx.auditLog.create({
          data: {
            tenantId: item.tenantId,
            action: `newsletter_review_email_${status}`,
            entityType: 'newsletter_review_email',
            entityId: item.id,
            after: {
              status,
              ...(messageId ? { messageId } : {}),
              ...(errorCode ? { errorCode } : {}),
            },
          },
        });
    });
  }
}
