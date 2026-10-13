import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  findNewsletterBlock,
  newsletterSourceClients,
  type NewsletterDesign,
  type NewsletterRecipient,
  type NewsletterOutreachStage,
} from '@capiro/shared/newsletter';
import {
  newsletterEscape,
  newsletterSafeUrl,
  renderNewsletterDesign,
} from '@capiro/shared/newsletter-render';
import sanitizeHtml from 'sanitize-html';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService, type OutreachRecipientInput } from './engagement.service.js';
import { OutreachDraftService } from './outreach-draft.service.js';
import { OutreachSendIntentService } from './outreach-send-intent.service.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';

export type { NewsletterOutreachStage } from '@capiro/shared/newsletter';
export interface NewsletterDestination {
  email: string;
  name?: string;
  clientId?: string;
  directoryContactId?: string;
  company?: string;
  phone?: string;
  cc?: string[];
  bcc?: string[];
  groupMembers?: Array<{ email: string; name?: string }>;
}
interface NewsletterPrepareInput {
  recipients: NewsletterDestination[];
  targets: object[];
  senderConnectionId: string;
  subject: string;
}
interface NewsletterSendInput {
  requestKey: string;
  senderConnectionId: string;
  versionIds: string[];
}
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** HTML fragments are still untrusted; only the shared renderer owns email CSS. */
export function sanitizeNewsletterFragment(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'span',
      'div',
      'a',
      'h1',
      'h2',
      'h3',
      'h4',
      'ul',
      'ol',
      'li',
      'table',
      'thead',
      'tbody',
      'tr',
      'td',
      'th',
      'img',
      'hr',
      'blockquote',
      'pre',
      'code',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel', 'id'],
      img: ['src', 'alt', 'width', 'height'],
      '*': ['style'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    allowedStyles: {
      '*': {
        color: [/^#[a-f\d]{3,8}$/i],
        'background-color': [/^#[a-f\d]{3,8}$/i],
        'font-size': [/^\d{1,3}px$/],
        'font-family': [/^[a-z\d ,'-]{1,100}$/i],
        'font-weight': [/^(normal|bold|[1-9]00)$/],
        'font-style': [/^(normal|italic)$/],
        'text-align': [/^(left|center|right)$/],
        'text-decoration': [/^(none|underline|line-through)$/],
        'line-height': [/^[0-4](\.\d{1,2})?$/],
      },
    },
    transformTags: {
      a: (_tag, attrs) => ({
        tagName: 'a',
        attribs: {
          ...attrs,
          href: newsletterSafeUrl(attrs.href ?? '') || '#',
          rel: 'noopener noreferrer',
        },
      }),
    },
  });
}

@Injectable()
export class NewsletterOutreachService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
    private readonly drafts: OutreachDraftService,
    private readonly sendIntents: OutreachSendIntentService,
    private readonly runtime: EngagementRuntimePolicyService,
  ) {}
  private publicBase() {
    return (
      (process.env.API_PUBLIC_URL || process.env.WEB_PUBLIC_URL || 'https://app.capiro.ai').replace(
        /\/$/,
        '',
      ) + '/api/engagement/newsletter-public'
    );
  }
  private async assertClient(ctx: TenantContext, clientId?: string | null) {
    if (!clientId) return;
    if (!uuid.test(clientId)) throw new NotFoundException('Client not found');
    const rows = await this.prisma.withTenant(
      ctx.tenantId,
      (tx) => tx.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT (NOT c.memory_wall OR EXISTS (
        SELECT 1 FROM client_memory_access a WHERE a.client_id = c.id AND a.user_id = ${ctx.userId}::uuid
      )) AS allowed FROM clients c WHERE c.id = ${clientId}::uuid AND c.tenant_id = ${ctx.tenantId}::uuid
    `,
    );
    if (!rows[0]?.allowed) throw new NotFoundException('Client not found');
  }
  async stage(ctx: TenantContext, id: string): Promise<NewsletterOutreachStage> {
    if (!uuid.test(id)) throw new NotFoundException('Staged newsletter not found');
    const rows = await this.prisma.withTenant(
      ctx.tenantId,
      (tx) => tx.$queryRaw<NewsletterOutreachStage[]>`
      SELECT id::text, document_id::text AS "documentId", revision, name, config, design
      FROM ws_newsletter_stage WHERE id = ${id}::uuid
        AND tenant_id = ${ctx.tenantId}::uuid AND owner_id = ${ctx.clerkUserId}
    `,
    );
    const stage = rows[0];
    if (!stage) throw new NotFoundException('Staged newsletter not found');
    for (const clientId of newsletterSourceClients(stage.design, stage.config.clientId))
      await this.assertClient(ctx, clientId);
    return stage;
  }
  private async record(ctx: TenantContext, id: string) {
    if (!uuid.test(id)) throw new NotFoundException('Newsletter outreach not found');
    const row = await this.engagement.getOutreachRecord(ctx, id);
    const metadata = row.metadata as Record<string, unknown> | null;
    const stageId = metadata?.newsletterStageId;
    if (row.type !== 'outbound_campaign' || typeof stageId !== 'string')
      throw new NotFoundException('Newsletter outreach not found');
    const stage = await this.stage(ctx, stageId);
    const rowClient = row.clientId;
    const stageClient = stage.config.clientId;
    const sameClient =
      (rowClient === null && stageClient === null) ||
      (typeof rowClient === 'string' &&
        uuid.test(rowClient) &&
        typeof stageClient === 'string' &&
        uuid.test(stageClient) &&
        rowClient.toLowerCase() === stageClient.toLowerCase());
    const hasRevision =
      metadata !== null &&
      metadata !== undefined &&
      Object.prototype.hasOwnProperty.call(metadata, 'newsletterRevision');
    const stageRevision = metadata?.newsletterRevision;
    if (
      !sameClient ||
      false
    )
      throw new NotFoundException('Newsletter outreach not found');
    await this.assertClient(ctx, row.clientId);
    return { row, stage };
  }
  private async mutation<T>(
    ctx: TenantContext,
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Verify ownership before reporting a conflicting operation, then keep a
    // campaign-scoped advisory lock while the existing services commit their
    // own transactions. No row lock crosses those service transactions.
    await this.record(ctx, id);
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        const locks = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`newsletter-operation:${ctx.tenantId}:${id}`}, 0)) AS locked
      `;
        if (!locks[0]?.locked)
          throw new ConflictException(
            'This newsletter is updating in another tab. Try again after that operation finishes.',
          );
        return operation();
      },
      { timeoutMs: 300000 },
    );
  }
  async open(ctx: TenantContext, stageId: string) {
    const stage = await this.stage(ctx, stageId);
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // One stage lock covers the lookup and creation, including a StrictMode
      // double request or two tabs opening the same saved handoff.
      await tx.$queryRaw`SELECT id FROM ws_newsletter_stage WHERE id = ${stageId}::uuid AND tenant_id = ${ctx.tenantId}::uuid AND owner_id = ${ctx.clerkUserId} FOR UPDATE`;
      const existing = await tx.outreachRecord.findFirst({
        where: {
          tenantId: ctx.tenantId,
          createdByUserId: ctx.userId,
          deletedAt: null,
          status: 'draft',
          metadata: { path: ['newsletterStageId'], equals: stageId },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      return (
        existing ??
        tx.outreachRecord.create({
          data: {
            tenantId: ctx.tenantId,
            createdByUserId: ctx.userId,
            type: 'outbound_campaign',
            clientId: stage.config.clientId,
            status: 'draft',
            title: stage.name,
            subject: stage.config.subject,
            recipients: [],
            recipientCount: 0,
            lastStep: 1,
            metadata: {
              direction: 'to-clients',
              contextPool: [],
              newsletterStageId: stage.id,
              newsletterRevision: stage.revision,
            },
          },
        })
      );
    });
    return this.get(ctx, row.id);
  }
  async get(ctx: TenantContext, id: string) {
    const { row, stage } = await this.record(ctx, id);
    const draftRows = await this.drafts.listForOutreach(ctx, id);
    const metadata = row.metadata as Record<string, unknown> | null;
    const preparedIds = Array.isArray(metadata?.newsletterVersionIds)
      ? (metadata.newsletterVersionIds as string[])
      : [];
    const accesses = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.newsletterRecipientAccess.findMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          outreachRecordId: id,
          draftVersionId: { in: preparedIds },
        },
        select: { draftVersionId: true, email: true },
      }),
    );
    const tests =
      preparedIds.length && typeof metadata?.newsletterSenderId === 'string'
        ? await this.prisma.withTenant(ctx.tenantId, (tx) =>
            tx.outreachSendIntent.findMany({
              where: {
                tenantId: ctx.tenantId,
                userId: ctx.userId,
                outreachRecordId: id,
                senderConnectionId: metadata.newsletterSenderId as string,
                testMode: true,
                deliveries: { some: { draftVersionId: { in: preparedIds } } },
              },
              orderBy: { createdAt: 'desc' },
              select: {
                id: true,
                requestKey: true,
                senderConnectionId: true,
                deliveries: { select: { draftVersionId: true } },
              },
            }),
          )
        : [];
    return {
      id: row.id,
      status: row.status,
      name: stage.name,
      stage,
      targets: metadata?.newsletterTargets ?? [],
      senderConnectionId: metadata?.newsletterSenderId ?? null,
      subject: row.subject ?? stage.config.subject,
      versions: preparedIds.flatMap((versionId) => {
        const version = draftRows.find((d) => d.current?.id === versionId)?.current;
        return version
          ? [
              {
                ...version,
                recipientEmail: accesses.find((a) => a.draftVersionId === versionId)?.email ?? '',
              },
            ]
          : [];
      }),
      intentId: metadata?.newsletterIntentId ?? null,
      excluded: metadata?.newsletterExcluded ?? [],
      tests: tests.flatMap((test) =>
        test.deliveries
          .filter((delivery) => preparedIds.includes(delivery.draftVersionId))
          .map((delivery) => ({
            id: test.id,
            requestKey: test.requestKey,
            senderConnectionId: test.senderConnectionId,
            versionId: delivery.draftVersionId,
          })),
      ),
    };
  }
  async prepare(ctx: TenantContext, id: string, input: NewsletterPrepareInput) {
    return this.mutation(ctx, id, () => this.prepareCurrent(ctx, id, input));
  }
  private async prepareCurrent(ctx: TenantContext, id: string, input: NewsletterPrepareInput) {
    const { row, stage } = await this.record(ctx, id);
    if (row.status !== 'draft')
      throw new ConflictException('This newsletter has already been sent.');
    const pending = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachSendIntent.count({
        where: {
          tenantId: ctx.tenantId,
          outreachRecordId: id,
          testMode: false,
          status: { in: ['queued', 'running'] },
        },
      }),
    );
    if (pending) throw new ConflictException('This newsletter is already queued for delivery.');
    if (!input.subject.trim() || /[\r\n]/.test(input.subject))
      throw new BadRequestException('Add a subject without line breaks.');
    if (!stage.config.company.trim() || !stage.config.mailingAddress.trim())
      throw new BadRequestException(
        'Add your firm name and mailing address in Workspace before staging.',
      );
    await this.engagement.findCampaignSendConnection(ctx, input.senderConnectionId);
    const recipients = normalizeNewsletterDestinations(input.recipients);
    if (!recipients.length || recipients.length > 500)
      throw new BadRequestException('Select between 1 and 500 destinations.');
    for (const clientId of new Set(recipients.map((r) => r.clientId).filter(Boolean)))
      await this.assertClient(ctx, clientId);
    const excluded: string[] = [];
    const versions = [];
    const config = { ...stage.config, subject: input.subject.trim() };
    for (const r of recipients) {
      const memberEmails = [
        ...(r.groupMembers?.map((m) => m.email) ?? [r.email]),
        ...(r.cc ?? []),
        ...(r.bcc ?? []),
      ];
      const blocked = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.newsletterSubscription.findMany({
          where: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            email: { in: memberEmails },
            unsubscribedAt: { not: null },
          },
          select: { email: true },
        }),
      );
      if (blocked.length) {
        excluded.push(...blocked.map((b) => b.email));
        continue;
      }
      // Each delivery has a separate capability. No private Workspace or client
      // routes are exposed to recipients, and no archive is published on preview.
      const token = randomBytes(32).toString('hex');
      const base = `${this.publicBase()}/${token}`;
      const names = (r.name ?? '').split(/\s+/);
      const mergeRecipient: NewsletterRecipient = {
        id: r.email,
        email: r.groupMembers ? '' : r.email,
        firstName: r.groupMembers ? 'Readers' : (names[0] ?? ''),
        lastName: r.groupMembers ? '' : names.slice(1).join(' '),
        company: r.company ?? '',
        phone: r.phone ?? '',
        birthday: '',
        address: '',
        client: r.clientId ?? '',
        tags: [],
        subscribed: true,
      };
      const html = renderNewsletterDesign(stage.design, config, {
        recipient: mergeRecipient,
        liveMergeTags: true,
        publicUrl: process.env.WEB_PUBLIC_URL || 'https://app.capiro.ai',
        sanitizeHtml: sanitizeNewsletterFragment,
        archiveUrl: `${base}/archive`,
        unsubscribeUrl: `${base}/unsubscribe`,
        preferencesUrl: `${base}/preferences`,
        surveyUrl: (blockId, answer) =>
          `${base}/survey?block=${encodeURIComponent(blockId)}&answer=${encodeURIComponent(answer)}`,
      });
      if (/\*\|[^|]+\|\*/.test(html))
        throw new BadRequestException(
          'Resolve unsupported merge tags in Workspace before sending.',
        );
      const access = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.newsletterRecipientAccess.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            stageId: stage.id,
            outreachRecordId: id,
            token,
            email: r.email,
            html,
          },
        }),
      );
      const key = `${r.groupMembers ? 'group' : 'newsletter'}:${access.id}`;
      const version = await this.drafts.importNewsletterVersion(ctx, {
        outreachRecordId: id,
        generationKey: key,
        recipientKey: key,
        audienceKind: r.groupMembers ? 'group' : 'individual',
        recipientSnapshot: r as unknown as Record<string, unknown>,
        subject: config.subject,
        body: html,
        newsletterStageId: stage.id,
      });
      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.newsletterRecipientAccess.update({
          where: { id: access.id, tenantId: ctx.tenantId },
          data: { draftVersionId: version.id },
        }),
      );
      versions.push({ ...version, recipientEmail: r.email });
    }
    await this.engagement.updateOutreachRecord(ctx, id, {
      subject: config.subject,
      recipients: recipients as OutreachRecipientInput[],
      lastStep: 2,
      metadata: {
        ...((row.metadata as Record<string, unknown>) ?? {}),
        newsletterTargets: input.targets,
        newsletterSenderId: input.senderConnectionId,
        newsletterVersionIds: versions.map((v) => v.id),
        newsletterExcluded: excluded,
      },
    });
    return { versions, excluded };
  }
  async send(ctx: TenantContext, id: string, input: NewsletterSendInput, testMode = false) {
    return this.mutation(ctx, id, () => this.sendCurrent(ctx, id, input, testMode));
  }
  private async sendCurrent(
    ctx: TenantContext,
    id: string,
    input: NewsletterSendInput,
    testMode: boolean,
  ) {
    this.runtime.assertExternalAction(testMode ? 'outreach_test_send' : 'outreach_send', {
      testMode,
    });
    const { row } = await this.record(ctx, id);
    const metadata = row.metadata as Record<string, unknown> | null;
    const preparedIds = Array.isArray(metadata?.newsletterVersionIds)
      ? (metadata.newsletterVersionIds as string[])
      : [];
    const existing = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachSendIntent.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, requestKey: input.requestKey },
        select: {
          id: true,
          outreachRecordId: true,
          senderConnectionId: true,
          testMode: true,
          deliveries: { select: { draftVersionId: true } },
        },
      }),
    );
    if (existing) {
      if (
        existing.outreachRecordId !== id ||
        existing.senderConnectionId !== input.senderConnectionId ||
        existing.testMode !== testMode ||
        existing.deliveries
          .map((d) => d.draftVersionId)
          .sort()
          .join() !== [...input.versionIds].sort().join()
      )
        throw new ConflictException(
          'This send request key was already used for different content.',
        );
      return { intentId: existing.id, deduped: true };
    }
    if (
      !input.versionIds.length ||
      new Set(input.versionIds).size !== input.versionIds.length ||
      input.versionIds.some((v) => !preparedIds.includes(v)) ||
      (!testMode && input.versionIds.length !== preparedIds.length) ||
      (testMode && input.versionIds.length !== 1)
    )
      throw new ConflictException('Review the current newsletter destinations before sending.');
    if (metadata?.newsletterSenderId !== input.senderConnectionId)
      throw new ConflictException(
        'Preview the newsletter again after changing the sending mailbox.',
      );
    const result = await this.sendIntents.createIntent(ctx, {
      runtimeAction: testMode ? 'outreach_test_send' : 'outreach_send',
      testMode,
      outreachRecordId: id,
      requestKey: input.requestKey,
      senderConnectionId: input.senderConnectionId,
      draftVersionIds: input.versionIds,
      appendSignature: false,
    });
    if (!testMode)
      await this.engagement.updateOutreachRecord(ctx, id, {
        metadata: { ...(metadata ?? {}), newsletterIntentId: result.intentId },
        lastStep: 3,
      });
    return result;
  }
  private async publicAccess(token: string) {
    if (!/^[a-f\d]{64}$/.test(token)) throw new NotFoundException('Newsletter link not found');
    // Capability lookup intentionally needs no session; all later operations are
    // tenant-scoped. A capability reveals only one actually staged delivery.
    const row = await this.prisma.withSystem((tx) =>
      tx.newsletterRecipientAccess.findUnique({ where: { token } }),
    );
    if (!row?.draftVersionId) throw new NotFoundException('Newsletter link not found');
    const draftVersionId = row.draftVersionId;
    const published = await this.prisma.withTenant(row.tenantId, (tx) =>
      tx.outreachDelivery.count({
        where: {
          tenantId: row.tenantId,
          draftVersionId,
          status: { in: ['pending', 'sending', 'sent', 'unknown'] },
          sendIntent: { testMode: false },
        },
      }),
    );
    if (!published) throw new NotFoundException('Newsletter link not found');
    return row;
  }
  async publicArchive(token: string) {
    return (await this.publicAccess(token)).html;
  }
  async preferences(token: string, unsubscribe = false) {
    const row = await this.publicAccess(token);
    if (unsubscribe)
      await this.prisma.withTenant(row.tenantId, (tx) =>
        tx.newsletterSubscription.upsert({
          where: {
            tenantId_userId_email: { tenantId: row.tenantId, userId: row.userId, email: row.email },
          },
          create: {
            tenantId: row.tenantId,
            userId: row.userId,
            email: row.email,
            unsubscribedAt: new Date(),
          },
          update: { unsubscribedAt: new Date() },
        }),
      );
    return newsletterPublicPage(
      unsubscribe ? 'You have been unsubscribed' : 'Newsletter preferences',
      unsubscribe
        ? '<p>You will no longer receive newsletters from this sender.</p>'
        : '<p>You can stop receiving newsletters from this sender.</p><form method="post"><button type="submit">Unsubscribe</button></form>',
    );
  }
  async survey(token: string, blockId: string, answer: string, submit = false) {
    const row = await this.publicAccess(token);
    const stages = await this.prisma.withTenant(
      row.tenantId,
      (tx) => tx.$queryRaw<Array<{ design: NewsletterDesign }>>`
      SELECT design FROM ws_newsletter_stage WHERE id = ${row.stageId}::uuid AND tenant_id = ${row.tenantId}::uuid
    `,
    );
    const block = stages[0] && findNewsletterBlock(stages[0].design, blockId);
    if (!block || block.kind !== 'survey' || !block.options.includes(answer))
      throw new NotFoundException('Survey answer not found');
    if (submit)
      await this.prisma.withTenant(row.tenantId, (tx) =>
        tx.newsletterRecipientAccess.update({
          where: { id: row.id, tenantId: row.tenantId },
          data: {
            surveyAnswers: { ...(row.surveyAnswers as Prisma.JsonObject), [blockId]: answer },
          },
        }),
      );
    return newsletterPublicPage(
      submit ? 'Thank you for your feedback' : block.question,
      submit
        ? '<p>Your response was saved.</p>'
        : `<p>${newsletterEscape(answer)}</p><form method="post"><button type="submit">Submit response</button></form>`,
    );
  }
}
export function newsletterPublicPage(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${newsletterEscape(title)}</title></head><body style="font-family:Arial,sans-serif;max-width:640px;margin:64px auto;padding:24px"><h1>${newsletterEscape(title)}</h1>${body}</body></html>`;
}
export function normalizeNewsletterDestinations(
  rows: NewsletterDestination[],
): NewsletterDestination[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    if (r.groupMembers?.length)
      throw new BadRequestException(
        'Newsletter destinations must be individual recipients. Expand groups into individual copies.',
      );
    const normalized = r.email.trim().toLowerCase();
    if (!email.test(normalized) || /[\r\n]/.test(normalized))
      throw new BadRequestException('Every destination needs a valid email address.');
    const copies = (values: string[] = []) =>
      [...new Set(values.map((v) => v.trim().toLowerCase()))].map((v) => {
        if (!email.test(v)) throw new BadRequestException('Cc and Bcc addresses must be valid.');
        return v;
      });
    const groupMembers = r.groupMembers?.map((m) => ({
      email: copies([m.email])[0]!,
      name: m.name?.slice(0, 200),
    }));
    const key = groupMembers
      ? `group:${groupMembers
          .map((m) => m.email)
          .sort()
          .join(',')}`
      : normalized;
    if (seen.has(key))
      throw new BadRequestException('Remove duplicate destinations before sending.');
    seen.add(key);
    return {
      email: normalized,
      name: r.name?.slice(0, 200),
      clientId: r.clientId,
      directoryContactId: r.directoryContactId,
      company: r.company?.slice(0, 200),
      phone: r.phone?.slice(0, 100),
      cc: copies(r.cc),
      bcc: copies(r.bcc),
      ...(groupMembers?.length ? { groupMembers } : {}),
    };
  });
}
