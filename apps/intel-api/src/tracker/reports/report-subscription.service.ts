import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { REPORT_DELIVERY_FEATURE } from '../../feature-flags/feature-flag.service.js';
import { ReportService } from './report.service.js';
import { ReportRecipientsService, type RecipientSnapshot } from './recipients.service.js';
import { ReportDeliveryService, type ReportComposition } from './report-delivery.service.js';
import {
  digest,
  escapeHtml,
  json,
  object,
  text,
  version,
  type ReportDocument,
} from './report-domain.js';
import { localTime, nextOccurrence, validateSchedule } from './report-schedule.js';

@Injectable()
export class ReportSubscriptionService {
  constructor(
    readonly reports: ReportService,
    readonly recipients: ReportRecipientsService,
    readonly delivery: ReportDeliveryService,
  ) {}
  async list(ctx: WorkspaceTenantContext) {
    await this.reports.authorize(ctx);
    return this.reports.folders.withActor(ctx, (tx) =>
      tx.legiWatchReportSubscription.findMany({
        where: { tenantId: ctx.tenantId, ownerClerkId: ctx.clerkUserId },
        orderBy: { updatedAt: 'desc' },
      }),
    );
  }
  async save(ctx: WorkspaceTenantContext, input: unknown, id?: string, now = new Date()) {
    await this.reports.authorize(ctx);
    const b = object(input),
      schedule = validateSchedule(b.timezone, b.localMinutes);
    if (b.mode !== 'draft' && b.mode !== 'send')
      throw new BadRequestException('SCHEDULE_MODE_REQUIRED');
    const mode = b.mode,
      reportId = text(b.reportId),
      subject = text(b.subject, 200);
    if (/[\r\n]/.test(subject)) throw new BadRequestException('SUBJECT_MUST_BE_ONE_LINE');
    if (
      mode === 'send' &&
      !(await this.reports.flags.isEnabled(REPORT_DELIVERY_FEATURE, ctx.tenantId))
    )
      throw new ForbiddenException('REPORT_DELIVERY_DISABLED');
    return this.reports.folders.withActor(ctx, async (tx) => {
      const report = await this.reports.get(tx, ctx, reportId);
      const recipients = mode === 'send' ? await this.recipients.resolve(tx, ctx, b.selection) : [];
      if (mode === 'send' && !recipients.length)
        throw new BadRequestException('RECIPIENT_REVIEW_REQUIRED');
      const data = {
        reportId,
        reportVersion: report.version,
        ...schedule,
        mode,
        subject,
        introduction: typeof b.introduction === 'string' ? b.introduction.slice(0, 20000) : '',
        recipients: json(recipients),
        sendNoChange: b.sendNoChange === true,
        catchUp: b.catchUp === 'send' ? 'send' : 'draft',
      };
      if (!id)
        return tx.legiWatchReportSubscription.create({
          data: {
            ...data,
            tenantId: ctx.tenantId,
            ownerClerkId: ctx.clerkUserId,
            nextDueAt: nextOccurrence(now, schedule.timezone, schedule.localMinutes),
            enabled: false,
          },
        });
      const old = await tx.legiWatchReportSubscription.findFirst({
        where: { tenantId: ctx.tenantId, id, ownerClerkId: ctx.clerkUserId },
      });
      if (!old) throw new NotFoundException('SUBSCRIPTION_NOT_FOUND');
      const result = await tx.legiWatchReportSubscription.updateMany({
        where: { tenantId: ctx.tenantId, id, version: version(b.expectedVersion) },
        data: {
          ...data,
          enabled: false,
          version: { increment: 1 },
          nextDueAt: nextOccurrence(now, schedule.timezone, schedule.localMinutes),
        },
      });
      if (!result.count) throw new ConflictException('SUBSCRIPTION_CHANGED_RELOAD');
      return tx.legiWatchReportSubscription.findFirstOrThrow({
        where: { tenantId: ctx.tenantId, id },
      });
    });
  }
  async activation(ctx: WorkspaceTenantContext, id: string, input: unknown, now = new Date()) {
    await this.reports.authorize(ctx);
    const b = object(input);
    if (typeof b.enabled !== 'boolean') throw new BadRequestException('ENABLE_OR_PAUSE_REQUIRED');
    if (b.enabled) {
      const saved = await this.reports.folders.withActor(ctx, (tx) =>
        tx.legiWatchReportSubscription.findFirst({
          where: { tenantId: ctx.tenantId, id, ownerClerkId: ctx.clerkUserId },
        }),
      );
      if (!saved) throw new NotFoundException('SUBSCRIPTION_NOT_FOUND');
      if (saved.mode === 'send') {
        if (b.confirmSend !== true)
          throw new BadRequestException('EXPLICIT_AUTOMATIC_SEND_ACTIVATION_REQUIRED');
        if (!(await this.reports.flags.isEnabled(REPORT_DELIVERY_FEATURE, ctx.tenantId)))
          throw new ForbiddenException('REPORT_DELIVERY_DISABLED');
        // Establish complete canonical coverage before the send baseline.
        // Initial ingestion of historical records must not become a backlog
        // email just because its first-observed timestamp follows activation.
        const baseline = await this.reports.generate(
          ctx,
          saved.reportId,
          {
            expectedVersion: saved.reportVersion,
            cutoff: localTime(now, saved.timezone).date,
            audience: 'external',
          },
          now,
        );
        if (!baseline.complete) throw new BadRequestException('COMPLETE_SOURCE_BASELINE_REQUIRED');
      }
    }
    return this.reports.folders.withActor(ctx, async (tx) => {
      const sub = await tx.legiWatchReportSubscription.findFirst({
        where: { tenantId: ctx.tenantId, id, ownerClerkId: ctx.clerkUserId },
      });
      if (!sub) throw new NotFoundException('SUBSCRIPTION_NOT_FOUND');
      if (b.enabled) {
        if (sub.baselineAt && !['from_now', 'catch_up_draft'].includes(String(b.resumePolicy)))
          throw new BadRequestException('RESUME_POLICY_REQUIRED');
        const report = await this.reports.get(tx, ctx, sub.reportId);
        if (report.version !== sub.reportVersion)
          throw new ConflictException('REPORT_VERSION_REVIEW_REQUIRED');
        if (sub.mode === 'send') {
          if (b.confirmSend !== true)
            throw new BadRequestException('EXPLICIT_AUTOMATIC_SEND_ACTIVATION_REQUIRED');
          if (!(await this.reports.flags.isEnabled(REPORT_DELIVERY_FEATURE, ctx.tenantId)))
            throw new ForbiddenException('REPORT_DELIVERY_DISABLED');
          for (const r of sub.recipients as unknown as RecipientSnapshot[])
            await this.recipients.recheck(tx, ctx, r);
        }
      }
      const updated = await tx.legiWatchReportSubscription.updateMany({
        where: { tenantId: ctx.tenantId, id, version: version(b.expectedVersion) },
        data: {
          enabled: b.enabled === true,
          version: { increment: 1 },
          activatedBy: ctx.clerkUserId,
          ...(b.enabled
            ? {
                baselineAt: sub.baselineAt ?? now,
                checkpointAt: b.resumePolicy === 'catch_up_draft' ? (sub.checkpointAt ?? now) : now,
                catchUpDraftPending: b.resumePolicy === 'catch_up_draft',
                nextDueAt: nextOccurrence(now, sub.timezone, sub.localMinutes),
              }
            : {}),
        },
      });
      if (!updated.count) throw new ConflictException('SUBSCRIPTION_CHANGED_RELOAD');
      await tx.legiWatchReportOccurrence.updateMany({
        where: {
          tenantId: ctx.tenantId,
          subscriptionId: id,
          state: { in: ['queued', 'generating', 'retryable'] },
        },
        data: {
          state: 'canceled',
          error: 'SUBSCRIPTION_CONFIGURATION_CHANGED',
          leaseToken: null,
          leaseUntil: null,
        },
      });
      return tx.legiWatchReportSubscription.findFirstOrThrow({
        where: { tenantId: ctx.tenantId, id },
      });
    });
  }
  async runNow(ctx: WorkspaceTenantContext, id: string, input: unknown, now = new Date()) {
    await this.reports.authorize(ctx);
    const requestKey = text(object(input).requestKey, 100);
    const occurrence = await this.reports.folders.withActor(ctx, async (tx) => {
      const sub = await tx.legiWatchReportSubscription.findFirst({
        where: { tenantId: ctx.tenantId, id, ownerClerkId: ctx.clerkUserId },
      });
      if (!sub) throw new NotFoundException('SUBSCRIPTION_NOT_FOUND');
      return tx.legiWatchReportOccurrence.upsert({
        where: {
          tenantId_subscriptionId_occurrenceKey: {
            tenantId: ctx.tenantId,
            subscriptionId: id,
            occurrenceKey: `manual:${requestKey}`,
          },
        },
        update: {},
        create: {
          tenantId: ctx.tenantId,
          subscriptionId: id,
          subscriptionVersion: sub.version,
          occurrenceKey: `manual:${requestKey}`,
          intendedAt: now,
          windowStart: sub.checkpointAt ?? now,
          windowEnd: now,
          configuration: json({ ...sub, mode: 'draft', manual: true }),
        },
      });
    });
    await this.generateOccurrence(ctx.tenantId, occurrence.id, now);
    return { id: occurrence.id, mode: 'draft' };
  }
  async due(tenantId: string, limit = 25, now = new Date()) {
    const prisma = this.reports.folders.prisma;
    const due = await prisma.withTenant(tenantId, (tx) =>
      tx.legiWatchReportSubscription.findMany({
        where: { tenantId, enabled: true, nextDueAt: { lte: now } },
        orderBy: [{ nextDueAt: 'asc' }, { id: 'asc' }],
        take: Math.min(100, Math.max(1, limit)),
      }),
    );
    let created = 0;
    for (const candidate of due) {
      const ctx: WorkspaceTenantContext = {
        tenantId,
        clerkUserId: candidate.ownerClerkId,
        role: null,
      };
      try {
        await this.reports.authorize(ctx);
      } catch {
        continue;
      }
      await prisma.withTenant(tenantId, async (tx) => {
        await tx.$queryRaw`SELECT id FROM intel_legiwatch_report_subscription WHERE tenant_id=${tenantId} AND id=${candidate.id} FOR UPDATE`;
        const sub = await tx.legiWatchReportSubscription.findFirst({
          where: {
            tenantId,
            id: candidate.id,
            enabled: true,
            version: candidate.version,
            nextDueAt: { lte: now },
          },
        });
        if (!sub?.nextDueAt) return;
        // A stalled earlier occurrence must be reviewed or retried before a
        // later window can advance; otherwise both would cover the same facts.
        if (
          await tx.legiWatchReportOccurrence.count({
            where: {
              tenantId,
              subscriptionId: sub.id,
              state: { in: ['queued', 'generating', 'retryable', 'held'] },
              NOT: { occurrenceKey: { startsWith: 'manual:' } },
            },
          })
        )
          return;
        const occurrenceKey = `${localTime(sub.nextDueAt, sub.timezone).date}:${sub.localMinutes}`;
        const overdue =
          localTime(sub.nextDueAt, sub.timezone).date !== localTime(now, sub.timezone).date;
        await tx.legiWatchReportOccurrence.upsert({
          where: {
            tenantId_subscriptionId_occurrenceKey: {
              tenantId,
              subscriptionId: sub.id,
              occurrenceKey,
            },
          },
          update: {},
          create: {
            tenantId,
            subscriptionId: sub.id,
            subscriptionVersion: sub.version,
            occurrenceKey,
            intendedAt: sub.nextDueAt,
            windowStart: sub.checkpointAt ?? sub.baselineAt ?? now,
            windowEnd: overdue ? now : sub.nextDueAt,
            configuration: json({
              ...sub,
              mode:
                sub.catchUpDraftPending || (overdue && sub.catchUp !== 'send') ? 'draft' : sub.mode,
              overdue,
            }),
          },
        });
        await tx.legiWatchReportSubscription.update({
          where: { id: sub.id },
          data: {
            nextDueAt: nextOccurrence(now, sub.timezone, sub.localMinutes),
            catchUpDraftPending: false,
          },
        });
        created++;
      });
    }
    const pending = await prisma.withTenant(tenantId, (tx) =>
      tx.legiWatchReportOccurrence.findMany({
        where: {
          tenantId,
          OR: [
            { state: { in: ['queued', 'retryable'] } },
            { state: 'generating', leaseUntil: { lt: now } },
          ],
        },
        orderBy: { intendedAt: 'asc' },
        take: Math.min(100, Math.max(1, limit)),
      }),
    );
    for (const p of pending) await this.generateOccurrence(tenantId, p.id, now);
    return { created, processed: pending.length };
  }
  async generateOccurrence(tenantId: string, id: string, now: Date) {
    const prisma = this.reports.folders.prisma,
      token = randomUUID();
    const occurrence = await prisma.withTenant(tenantId, async (tx) => {
      await tx.legiWatchReportOccurrence.updateMany({
        where: {
          tenantId,
          id,
          attempts: { gte: 5 },
          OR: [{ state: 'retryable' }, { state: 'generating', leaseUntil: { lt: now } }],
        },
        data: {
          state: 'held',
          error: 'GENERATION_ATTEMPTS_EXHAUSTED',
          leaseToken: null,
          leaseUntil: null,
        },
      });
      const claimed = await tx.legiWatchReportOccurrence.updateMany({
        where: {
          tenantId,
          id,
          attempts: { lt: 5 },
          OR: [
            { state: { in: ['queued', 'retryable'] } },
            { state: 'generating', leaseUntil: { lt: now } },
          ],
        },
        data: {
          state: 'generating',
          leaseToken: token,
          leaseUntil: new Date(now.getTime() + 300000),
          attempts: { increment: 1 },
        },
      });
      return claimed.count
        ? tx.legiWatchReportOccurrence.findFirstOrThrow({ where: { tenantId, id } })
        : null;
    });
    if (!occurrence) return;
    const config = object(occurrence.configuration),
      ctx: WorkspaceTenantContext = {
        tenantId,
        clerkUserId: String(config.ownerClerkId),
        role: null,
      };
    try {
      await this.reports.authorize(ctx);
      const run = occurrence.runId
        ? await this.reports.run(ctx, occurrence.runId)
        : await this.reports.generate(
            ctx,
            String(config.reportId),
            {
              cutoff: localTime(occurrence.windowEnd, String(config.timezone)).date,
              expectedVersion: config.reportVersion,
              audience: 'external',
            },
            now,
            `occurrence:${id}:${String(config.retryRevision ?? 0)}`,
            { start: occurrence.windowStart, end: occurrence.windowEnd },
          );
      const doc = run.snapshot as unknown as ReportDocument;
      const changed = doc.observedEvents.some(
        (e) =>
          e.observedAt > occurrence.windowStart.toISOString() &&
          e.observedAt <= occurrence.windowEnd.toISOString(),
      );
      const state = !run.complete
        ? 'held'
        : !changed && config.sendNoChange !== true
          ? 'no_change'
          : 'draft';
      await this.reports.folders.withActor(ctx, async (tx) => {
        await tx.$queryRaw`SELECT id FROM intel_legiwatch_report_subscription WHERE tenant_id=${tenantId} AND id=${occurrence.subscriptionId} FOR UPDATE`;
        const sub = await tx.legiWatchReportSubscription.findFirst({
          where: { tenantId, id: occurrence.subscriptionId },
        });
        if (
          !sub ||
          sub.version !== occurrence.subscriptionVersion ||
          (!sub.enabled && config.manual !== true)
        )
          throw new ConflictException('SUBSCRIPTION_CHANGED_OR_PAUSED');
        const claim = await tx.legiWatchReportOccurrence.updateMany({
          where: {
            tenantId,
            id,
            state: 'generating',
            leaseToken: token,
            leaseUntil: { gt: new Date() },
          },
          data: {
            state,
            runId: run.id,
            error: state === 'held' ? 'SOURCE_CHECK_INCOMPLETE' : null,
          },
        });
        if (!claim.count) return;
        if (state === 'draft' && config.mode === 'send' && config.manual !== true) {
          if (!(await this.reports.flags.isEnabled(REPORT_DELIVERY_FEATURE, tenantId)))
            throw new ForbiddenException('REPORT_DELIVERY_DISABLED');
          const recipients = config.recipients as unknown as RecipientSnapshot[];
          for (const r of recipients) await this.recipients.recheck(tx, ctx, r);
          const rendered = run.rendered,
            introduction = String(config.introduction ?? '');
          const composition: ReportComposition = {
            runId: run.id,
            contentHash: run.contentHash,
            recipients,
            subject: String(config.subject),
            introduction,
            envelopePolicy: 'isolated_recipients',
            html: rendered.html.replace(
              '<body>',
              `<body><p>${escapeHtml(introduction).replace(/\n/g, '<br>')}</p>`,
            ),
            plainText: `${introduction}\n\n${rendered.text}`,
          };
          await this.delivery.enqueue(
            ctx,
            composition,
            `scheduled:${id}`,
            { id: occurrence.subscriptionId, version: occurrence.subscriptionVersion },
            tx,
          );
          await tx.legiWatchReportOccurrence.update({
            where: { id },
            data: { state: 'queued_delivery', leaseToken: null, leaseUntil: null },
          });
        }
        if (claim.count && state !== 'held' && config.manual !== true)
          await tx.legiWatchReportSubscription.updateMany({
            where: {
              tenantId,
              id: sub.id,
              version: sub.version,
              OR: [{ checkpointAt: null }, { checkpointAt: { lt: occurrence.windowEnd } }],
            },
            data: { checkpointAt: occurrence.windowEnd },
          });
      });
    } catch (error) {
      // Retry known pre-dispatch database failures on the next bounded worker
      // cycle. Authorization, validation and source holds need staff review.
      const retryable =
        ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034'].includes(
          String(object(error).code ?? ''),
        ) && occurrence.attempts < 5;
      await prisma.withTenant(tenantId, (tx) =>
        tx.legiWatchReportOccurrence.updateMany({
          where: { tenantId, id, leaseToken: token, state: { in: ['generating', 'draft'] } },
          data: {
            state: retryable ? 'retryable' : 'held',
            error: error instanceof Error ? error.message : 'GENERATION_FAILED',
          },
        }),
      );
    }
  }
  async history(ctx: WorkspaceTenantContext, id: string) {
    await this.reports.authorize(ctx);
    return this.reports.folders.withActor(ctx, async (tx) => {
      const sub = await tx.legiWatchReportSubscription.findFirst({
        where: { tenantId: ctx.tenantId, id, ownerClerkId: ctx.clerkUserId },
      });
      if (!sub) throw new NotFoundException('SUBSCRIPTION_NOT_FOUND');
      return tx.legiWatchReportOccurrence.findMany({
        where: { tenantId: ctx.tenantId, subscriptionId: id },
        orderBy: { intendedAt: 'desc' },
        take: 100,
      });
    });
  }
  async retry(ctx: WorkspaceTenantContext, id: string) {
    await this.reports.authorize(ctx);
    return this.reports.folders.withActor(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_report_occurrence WHERE tenant_id=${ctx.tenantId} AND id=${id} FOR UPDATE`;
      const occurrence = await tx.legiWatchReportOccurrence.findFirst({
        where: { tenantId: ctx.tenantId, id, state: 'held' },
      });
      if (!occurrence) throw new NotFoundException('HELD_OCCURRENCE_NOT_FOUND');
      const sub = await tx.legiWatchReportSubscription.findFirst({
        where: {
          tenantId: ctx.tenantId,
          id: occurrence.subscriptionId,
          ownerClerkId: ctx.clerkUserId,
          version: occurrence.subscriptionVersion,
        },
      });
      if (!sub) throw new ConflictException('SUBSCRIPTION_CHANGED_CREATE_NEW_DRAFT');
      const config = object(occurrence.configuration);
      return tx.legiWatchReportOccurrence.update({
        where: { id },
        data: {
          state: 'queued',
          attempts: 0,
          runId: null,
          leaseToken: null,
          leaseUntil: null,
          error: null,
          configuration: json({
            ...config,
            mode: 'draft',
            retryRevision: Number(config.retryRevision ?? 0) + 1,
          }),
        },
      });
    });
  }
}
