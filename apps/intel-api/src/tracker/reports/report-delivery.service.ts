import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { canEditFolder } from '../folders/folder-tracker.service.js';
import { isWithinQuietHours } from '../../intel-alert/intel-alert.types.js';
import type { Prisma, LegiWatchDelivery } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { IntelEmailService } from '../../intel-alert/intel-email.service.js';
import {
  REPORT_DELIVERY_FEATURE,
  TRACKER_OWNER_FEATURE,
} from '../../feature-flags/feature-flag.service.js';
import { ReportService } from './report.service.js';
import { ReportRecipientsService, type RecipientSnapshot } from './recipients.service.js';
import {
  digest,
  escapeHtml,
  json,
  object,
  renderReport,
  selectionHash,
  text,
  type ReportDocument,
} from './report-domain.js';

export interface ReportComposition {
  runId: string;
  contentHash: string;
  subject: string;
  introduction: string;
  recipients: RecipientSnapshot[];
  html: string;
  plainText: string;
  envelopePolicy: 'isolated_recipients';
}
@Injectable()
export class ReportDeliveryService {
  constructor(
    readonly reports: ReportService,
    readonly recipients: ReportRecipientsService,
    readonly email: IntelEmailService,
  ) {}
  async preview(ctx: WorkspaceTenantContext, runId: string, input: unknown) {
    const run = await this.reports.run(ctx, runId),
      body = object(input);
    if (run.audience !== 'external') throw new BadRequestException('EXTERNAL_REPORT_REQUIRED');
    const subject = text(body.subject, 200);
    if (/[\r\n]/.test(subject)) throw new BadRequestException('SUBJECT_MUST_BE_ONE_LINE');
    const introduction =
      typeof body.introduction === 'string' && body.introduction.length <= 20000
        ? body.introduction
        : '';
    const recipients = await this.reports.folders.withActor(ctx, (tx) =>
      this.recipients.resolve(tx, ctx, body.selection),
    );
    if (!recipients.length) throw new BadRequestException('AT_LEAST_ONE_RECIPIENT_REQUIRED');
    const rendered = renderReport(run.snapshot as unknown as ReportDocument);
    const composition: ReportComposition = {
      runId,
      contentHash: run.contentHash,
      subject,
      introduction,
      recipients,
      html: rendered.html.replace(
        '<body>',
        `<body><p>${escapeHtml(introduction).replace(/\n/g, '<br>')}</p>`,
      ),
      plainText: `${introduction}\n\n${rendered.text}`,
      envelopePolicy: 'isolated_recipients',
    };
    return { composition, approvalHash: digest(composition), complete: run.complete };
  }
  async approve(ctx: WorkspaceTenantContext, runId: string, input: unknown) {
    await this.reports.authorize(ctx);
    if (!(await this.reports.flags.isEnabled(REPORT_DELIVERY_FEATURE, ctx.tenantId)))
      throw new ForbiddenException('REPORT_DELIVERY_DISABLED');
    const body = object(input),
      preview = await this.preview(ctx, runId, body);
    if (body.approvalHash !== preview.approvalHash)
      throw new ConflictException('COMPOSITION_CHANGED_REVIEW_AGAIN');
    if (!preview.complete) throw new BadRequestException('SOURCE_CHECK_INCOMPLETE');
    return this.enqueue(ctx, preview.composition, `manual:${runId}:${preview.approvalHash}`);
  }
  async enqueue(
    ctx: WorkspaceTenantContext,
    composition: ReportComposition,
    intentKey: string,
    subscription?: { id: string; version: number },
    transaction?: Prisma.TransactionClient,
  ) {
    const write = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + intentKey},0))`;
      const existing = await tx.legiWatchDelivery.findFirst({
        where: { tenantId: ctx.tenantId, intentKey },
      });
      if (existing) return { id: existing.id, state: 'already_queued' };
      const result = await tx.legiWatchDelivery.upsert({
        where: { tenantId_intentKey: { tenantId: ctx.tenantId, intentKey } },
        update: {},
        create: {
          tenantId: ctx.tenantId,
          intentKey,
          ownerClerkId: ctx.clerkUserId,
          runId: composition.runId,
          subscriptionId: subscription?.id,
          subscriptionVersion: subscription?.version,
          contentHash: composition.contentHash,
          composition: json(composition),
          recipients: {
            create: composition.recipients.map((r) => ({
              destinationHash: digest(r.email),
              recipient: json(r),
            })),
          },
        },
      });
      return { id: result.id, state: 'queued' };
    };
    return transaction ? write(transaction) : this.reports.folders.withActor(ctx, write);
  }
  async checkDispatch(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    delivery: LegiWatchDelivery,
    recipient: RecipientSnapshot,
    channel = 'email',
  ) {
    if (delivery.kind === 'bill_record')
      return this.checkRecordDispatch(tx, ctx, delivery, object(recipient), channel);
    if (!delivery.runId) throw new BadRequestException('REPORT_RUN_REQUIRED');
    const run = await tx.legiWatchReportRun.findFirst({
      where: { tenantId: ctx.tenantId, id: delivery.runId },
    });
    if (
      !run ||
      !run.complete ||
      run.audience !== 'external' ||
      run.contentHash !== delivery.contentHash
    )
      throw new ConflictException('APPROVED_CONTENT_UNAVAILABLE');
    const doc = run.snapshot as unknown as ReportDocument;
    await tx.$queryRaw`SELECT id FROM intel_legiwatch_report WHERE tenant_id=${ctx.tenantId} AND id=${run.reportId} FOR SHARE`;
    const report = await this.reports.get(tx, ctx, run.reportId);
    if (report.archived || report.version !== run.definitionVersion)
      throw new ConflictException('REPORT_CHANGED_REVIEW_AGAIN');
    // Share-lock source permissions and private objects until the send attempt
    // returns. Mutators serialize behind this authorized dispatch boundary.
    await tx.$queryRaw`SELECT id FROM intel_legiwatch_folder WHERE tenant_id=${ctx.tenantId} AND id=ANY(${report.folderIds}::text[]) FOR SHARE`;
    const assignments = await this.reports.assignments(tx, ctx, report);
    if (selectionHash(assignments) !== doc.selectionHash)
      throw new ConflictException('FOLDER_SCOPE_CHANGED');
    const billIds = [...new Set(doc.rows.map((r) => r.id))];
    const coverage = await this.reports.folders.source.reportCoverage(billIds);
    if (
      coverage.length !== billIds.length ||
      coverage.some(
        (b) => b.status !== 'success' || !b.checked || Date.now() - b.checked.getTime() > 86400000,
      )
    )
      throw new ConflictException('SOURCE_CHECK_INCOMPLETE');
    const current = new Map(assignments.map((a) => [a.id, a]));
    for (const row of doc.rows) {
      const a = current.get(row.assignmentId);
      if (
        !a ||
        a.version !== row.assignmentVersion ||
        a.folderVersion !== row.folderVersion ||
        a.archived
      )
        throw new ConflictException('FOLDER_SCOPE_CHANGED');
    }
    for (const id of report.folderIds) {
      const f = await this.reports.folders.folder(tx, ctx, id);
      if (
        !f.ownerClerkId ||
        !(await this.reports.folders.source.activeMember(ctx.tenantId, f.ownerClerkId))
      )
        throw new ForbiddenException('FOLDER_OWNER_UNRESOLVED');
    }
    if (delivery.subscriptionId) {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_report_subscription WHERE tenant_id=${ctx.tenantId} AND id=${delivery.subscriptionId} FOR SHARE`;
      const sub = await tx.legiWatchReportSubscription.findFirst({
        where: { tenantId: ctx.tenantId, id: delivery.subscriptionId },
      });
      if (
        !sub?.enabled ||
        sub.mode !== 'send' ||
        sub.version !== delivery.subscriptionVersion ||
        sub.ownerClerkId !== ctx.clerkUserId
      )
        throw new ConflictException('SUBSCRIPTION_CHANGED_OR_PAUSED');
    }
    const contactIds = recipient.contacts.map((c) => c.id),
      listIds = recipient.lists.map((l) => l.id);
    await tx.$queryRaw`SELECT id FROM intel_legiwatch_report_contact WHERE tenant_id=${ctx.tenantId} AND (id=ANY(${contactIds}::text[]) OR lower(email)=${recipient.email}) FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM intel_legiwatch_report_list WHERE tenant_id=${ctx.tenantId} AND id=ANY(${listIds}::text[]) FOR SHARE`;
    await this.recipients.recheck(tx, ctx, recipient);
  }
  async checkRecordDispatch(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    delivery: LegiWatchDelivery,
    recipient: Record<string, unknown>,
    channel: string,
  ): Promise<void> {
    if (
      !(await this.reports.flags.isEnabled(TRACKER_OWNER_FEATURE, ctx.tenantId)) ||
      !['true', '1', 'yes'].includes((process.env.TRACKER_ALERTS_ENABLED ?? '').toLowerCase())
    )
      throw new ForbiddenException('STAFF_ALERT_DELIVERY_DISABLED');
    const composition = object(delivery.composition),
      userId = String(recipient.userId);
    if (Array.isArray(composition.records)) {
      for (const record of composition.records)
        await this.checkRecordDispatch(
          tx,
          ctx,
          { ...delivery, composition: json(record) },
          recipient,
          channel,
        );
      return;
    }
    const sourceType = /^\d+-/.test(String(composition.billId)) ? 'bill' : 'state_bill';
    if (
      !(process.env.LEGIWATCH_RECORD_ALERT_SOURCE_TYPES ?? '')
        .split(',')
        .map((s) => s.trim())
        .includes(sourceType)
    )
      throw new ForbiddenException('RECORD_SOURCE_SCOPE_DISABLED');
    const destination = await this.reports.folders.source.staffDestination(ctx.tenantId, userId);
    if (
      !destination ||
      (channel === 'email' &&
        (!destination.email ||
          destination.email.toLowerCase() !== String(recipient.email ?? '').toLowerCase()))
    )
      throw new ConflictException('STAFF_DESTINATION_CHANGED');
    // Client-linked folders retain the existing staff/client email opt-in.
    // Client-less folders use the rule's explicit staff channel selection.
    if (channel === 'email' && typeof composition.clientId === 'string') {
      const pref = await tx.intelAlertPreference.findFirst({
        where: { tenantId: ctx.tenantId, clientId: composition.clientId, userId },
      });
      if (
        !pref?.emailEnabled ||
        pref.emailAddress?.toLowerCase() !== String(recipient.email).toLowerCase()
      )
        throw new ForbiddenException('CURRENT_CLIENT_EMAIL_PREFERENCE_REQUIRED');
      const jurisdiction =
        /^([A-Z]{2})-/.exec(String(composition.billId).toUpperCase())?.[1] ?? 'US';
      if (pref.jurisdictions.length && !pref.jurisdictions.includes(jurisdiction))
        throw new ForbiddenException('CLIENT_JURISDICTION_EXCLUDED');
      const compatibleCadence = composition.cadence === 'realtime' ? 'realtime' : 'daily';
      if (pref.emailCadence !== compatibleCadence)
        throw new ForbiddenException('CLIENT_CADENCE_REQUIRES_REVIEW');
      if (isWithinQuietHours(pref.quietHoursStart, pref.quietHoursEnd))
        throw new ConflictException('STAFF_QUIET_HOURS');
    }
    const refs = (Array.isArray(composition.ruleRefs) ? composition.ruleRefs : []).map(object);
    let eligible = false;
    for (const ref of refs) {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_record_rule WHERE tenant_id=${ctx.tenantId} AND id=${String(ref.id)} FOR SHARE`;
      const rule = await tx.legiWatchRecordRule.findFirst({
        where: {
          tenantId: ctx.tenantId,
          id: String(ref.id),
          state: 'active',
          version: Number(ref.version),
        },
      });
      if (
        !rule ||
        !(await this.reports.folders.source.activeMember(ctx.tenantId, rule.ownerClerkId, tx))
      )
        continue;
      const selected = (Array.isArray(rule.recipients) ? rule.recipients : [])
        .map(object)
        .find((r) => r.userId === userId);
      if (
        !selected ||
        (channel === 'email' && !selected.email) ||
        (channel === 'in_app' && !selected.inApp)
      )
        continue;
      const memberships = await tx.legiWatchFolderBill.findMany({
        where: {
          tenantId: ctx.tenantId,
          billId: String(composition.billId),
          folderId: {
            in: rule.folderIds.filter((id) =>
              (Array.isArray(ref.folderIds) ? ref.folderIds : []).includes(id),
            ),
          },
          folder: {
            archived: false,
            ownerClerkId: { not: null },
            clientId: typeof composition.clientId === 'string' ? composition.clientId : null,
          },
        },
        include: { folder: true },
      });
      for (const membership of memberships) {
        const folder = membership.folder;
        await tx.$queryRaw`SELECT id FROM intel_legiwatch_folder WHERE tenant_id=${ctx.tenantId} AND id=${folder.id} FOR SHARE`;
        const current = await tx.legiWatchFolder.findFirst({
          where: { tenantId: ctx.tenantId, id: folder.id },
        });
        if (
          current &&
          !current.archived &&
          current.ownerClerkId &&
          canEditFolder(current, rule.ownerClerkId) &&
          (await this.reports.folders.source.activeMember(ctx.tenantId, current.ownerClerkId, tx))
        )
          eligible = true;
      }
    }
    if (!eligible) throw new ForbiddenException('ALL_MATCHED_RULES_REVOKED');
    const [bill] = await this.reports.folders.source.reportBills([String(composition.billId)]);
    if (
      !bill ||
      bill.sourceCheckStatus !== 'success' ||
      !bill.sourceCheckedAt ||
      Date.now() - Date.parse(bill.sourceCheckedAt) > 86400000 ||
      !bill.coverage.actions ||
      !bill.coverage.amendments
    )
      throw new ConflictException('SOURCE_CHECK_INCOMPLETE');
  }
  /** End-of-day records use the same durable recipient queue and dispatcher.
   * Freeze a bounded digest only when due. Original event intents remain as
   * suppressed audit rows; late records form an explicit later supplement. */
  async bundleEndOfDay(tenantId: string, now: Date) {
    return this.reports.folders.prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':record-digest'},0))`;
      const rows = await tx.legiWatchDeliveryRecipient.findMany({
        where: {
          tenantId,
          state: 'queued',
          nextAttemptAt: { lte: now },
          delivery: {
            kind: 'bill_record',
            composition: { path: ['cadence'], equals: 'end_of_day' },
          },
        },
        include: { delivery: true },
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: 1000,
      });
      const groups = new Map<string, typeof rows>();
      const lengths = new Map<string, number>();
      const chunks = new Map<string, number>();
      for (const row of rows) {
        const packet = object(row.delivery.composition);
        const baseKey = digest([
          object(row.recipient).userId,
          row.channel,
          packet.clientId,
          packet.timezone,
          packet.localMinutes,
          packet.localDay,
        ]);
        let chunk = chunks.get(baseKey) ?? 0;
        let key = `${baseKey}:${chunk}`;
        const length = String(packet.title).length + String(packet.content).length + 4;
        // Inbox notifications are bounded; every record remains in a frozen
        // chunk, and no top-N selection silently drops later developments.
        if (
          groups.has(key) &&
          ((groups.get(key)?.length ?? 0) >= 50 ||
            (row.channel === 'in_app' && (lengths.get(key) ?? 0) + length > 9000))
        ) {
          chunks.set(baseKey, ++chunk);
          key = `${baseKey}:${chunk}`;
        }
        lengths.set(key, (lengths.get(key) ?? 0) + length);
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      for (const [key, group] of groups) {
        const first = group[0]!,
          records = group.map((r) => object(r.delivery.composition));
        const intentKey = `record-digest:${key}:${digest(group.map((r) => r.id).sort())}`;
        const title = `Published legislative records · ${records.length} developments`;
        const content = records.map((r) => `${r.title}\n${r.content}`).join('\n\n');
        const eventKey = digest(records.map((r) => r.eventKey).sort());
        await tx.legiWatchDelivery.upsert({
          where: { tenantId_intentKey: { tenantId, intentKey } },
          update: {},
          create: {
            tenantId,
            intentKey,
            kind: 'bill_record',
            ownerClerkId: first.delivery.ownerClerkId,
            contentHash: digest([title, content]),
            composition: json({
              title,
              content,
              html: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(content).replace(/\n/g, '<br>')}</p>`,
              records,
              eventKey,
              billId: records[0]!.billId,
              cadence: 'end_of_day_digest',
              policy: 'Due records; late publications appear in the next supplement',
            }),
            recipients: {
              create: [
                {
                  destinationHash: first.destinationHash,
                  channel: first.channel,
                  recipient: json(first.recipient),
                  nextAttemptAt: now,
                },
              ],
            },
          },
        });
        await tx.legiWatchDeliveryRecipient.updateMany({
          where: { tenantId, id: { in: group.map((r) => r.id) }, state: 'queued' },
          data: { state: 'suppressed', error: `Included in ${intentKey}` },
        });
      }
      return groups.size;
    });
  }
  async drain(tenantId: string, limit = 25, now = new Date(), kind = 'bill_report') {
    const prisma = this.reports.folders.prisma;
    // An older worker with no Phase 2 source allowlist must not claim and hold
    // records that belong to the explicitly configured report worker.
    if (
      kind === 'bill_record' &&
      (!(process.env.LEGIWATCH_RECORD_ALERT_SOURCE_TYPES ?? '').trim() ||
        !['true', '1', 'yes'].includes((process.env.TRACKER_ALERTS_ENABLED ?? '').toLowerCase()) ||
        !(await this.reports.flags.isEnabled(TRACKER_OWNER_FEATURE, tenantId)))
    )
      return { attempted: 0, held: 0 };
    if (kind === 'bill_record') await this.bundleEndOfDay(tenantId, now);
    // Expired attempts after dispatch began are uncertain. They never return to
    // the retry queue merely because a lease timed out.
    await prisma.withTenant(tenantId, (tx) =>
      tx.legiWatchDeliveryRecipient.updateMany({
        where: { tenantId, state: 'sending', leaseUntil: { lt: now } },
        data: { state: 'uncertain', error: 'DISPATCH_OUTCOME_UNCONFIRMED' },
      }),
    );
    const candidates = await prisma.withTenant(tenantId, (tx) =>
      tx.legiWatchDeliveryRecipient.findMany({
        where: {
          tenantId,
          delivery: {
            kind,
            ...(kind === 'bill_record'
              ? { NOT: { composition: { path: ['cadence'], equals: 'end_of_day' } } }
              : {}),
          },
          OR: [
            { state: { in: ['queued', 'retryable'] }, nextAttemptAt: { lte: now } },
            { state: 'claimed', leaseUntil: { lt: now }, dispatchStartedAt: null },
          ],
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: Math.min(100, Math.max(1, limit)),
        include: { delivery: true },
      }),
    );
    let attempted = 0,
      held = 0;
    for (const candidate of candidates) {
      if (
        candidate.delivery.kind === 'bill_report' &&
        !(await this.reports.flags.isEnabled(REPORT_DELIVERY_FEATURE, tenantId))
      )
        continue;
      const token = randomUUID();
      const claim = await prisma.withTenant(tenantId, (tx) =>
        tx.legiWatchDeliveryRecipient.updateMany({
          where: {
            tenantId,
            id: candidate.id,
            state: candidate.state,
            leaseToken: candidate.leaseToken,
            ...(candidate.state === 'claimed' ? { leaseUntil: { lt: now } } : {}),
          },
          data: {
            state: 'claimed',
            leaseToken: token,
            leaseUntil: new Date(now.getTime() + 120000),
            attempts: { increment: 1 },
          },
        }),
      );
      if (!claim.count) continue;
      let providerInvoked = false;
      const ctx: WorkspaceTenantContext = {
        tenantId,
        clerkUserId: candidate.delivery.ownerClerkId,
        role: null,
      };
      try {
        await this.reports.authorize(ctx);
        await this.reports.folders.withActor(ctx, (tx) =>
          this.checkDispatch(
            tx,
            ctx,
            candidate.delivery,
            candidate.recipient as unknown as RecipientSnapshot,
            candidate.channel,
          ),
        );
        const started = await prisma.withTenant(tenantId, (tx) =>
          tx.legiWatchDeliveryRecipient.updateMany({
            where: {
              tenantId,
              id: candidate.id,
              state: 'claimed',
              leaseToken: token,
              leaseUntil: { gt: new Date() },
            },
            data: { state: 'sending', dispatchStartedAt: new Date() },
          }),
        );
        if (!started.count) continue;
        attempted++;
        await this.reports.folders.withActor(
          ctx,
          async (tx) => {
            const locked = await tx.$queryRaw<
              Array<{ id: string }>
            >`SELECT id FROM intel_legiwatch_delivery_recipient WHERE tenant_id=${tenantId} AND id=${candidate.id} AND lease_token=${token} AND state='sending' AND lease_until>now() FOR UPDATE`;
            if (!locked.length) return;
            if (
              candidate.delivery.kind === 'bill_report' &&
              !(await this.reports.flags.isEnabled(REPORT_DELIVERY_FEATURE, tenantId))
            )
              throw new ForbiddenException('REPORT_DELIVERY_DISABLED');
            const recipient = candidate.recipient as unknown as RecipientSnapshot;
            await this.checkDispatch(tx, ctx, candidate.delivery, recipient, candidate.channel);
            const composition = candidate.delivery.composition as unknown as ReportComposition;
            let result;
            if (candidate.delivery.kind === 'bill_record') {
              const packet = object(candidate.delivery.composition),
                staff = object(candidate.recipient);
              if (candidate.channel === 'in_app') {
                const secret = process.env.INTERNAL_SERVICE_SECRET;
                if (!secret) throw new BadRequestException('INBOX_ADAPTER_NOT_CONFIGURED');
                providerInvoked = true;
                const response = await fetch(
                  `${(process.env.API_BASE_URL ?? 'https://app.capiro.ai').replace(/\/+$/, '')}/api/internal/legiwatch/bill-record-notification`,
                  {
                    method: 'POST',
                    headers: {
                      'content-type': 'application/json',
                      'x-internal-service-secret': secret,
                    },
                    signal: AbortSignal.timeout(15000),
                    body: JSON.stringify({
                      tenantId,
                      userId: staff.userId,
                      billId: packet.billId,
                      eventKey: `${packet.eventKey}:${packet.cadence}`,
                      title: packet.title,
                      body:
                        String(packet.content).length <= 10000
                          ? packet.content
                          : `${String(packet.content).slice(0, 9000)}\n\nExcerpt — open the original published record for its full text. Bill: ${(process.env.REPORT_APP_ORIGIN ?? 'https://os.capiro.ai').replace(/\/+$/, '')}/bills/${encodeURIComponent(String(packet.billId))}`,
                    }),
                  },
                );
                // API inbox insert has a durable idempotency key, so a known
                // rejection can retry without creating a second inbox event.
                result = response.ok
                  ? { outcome: 'accepted' as const, messageId: `inbox:${packet.eventKey}` }
                  : { outcome: 'retryable' as const, error: `INBOX_HTTP_${response.status}` };
              } else {
                providerInvoked = true;
                result = await this.email.sendReport(
                  String(staff.email),
                  'to',
                  String(packet.title),
                  String(packet.html),
                  String(packet.content),
                );
              }
            } else {
              providerInvoked = true;
              result = await this.email.sendReport(
                recipient.email,
                recipient.role,
                composition.subject,
                composition.html,
                composition.plainText,
              );
            }
            const state =
              result.outcome === 'accepted'
                ? 'provider_accepted'
                : result.outcome === 'retryable' && candidate.attempts >= 4
                  ? 'terminal'
                  : result.outcome;
            await tx.legiWatchDeliveryRecipient.updateMany({
              where: { tenantId, id: candidate.id, leaseToken: token, state: 'sending' },
              data: {
                state,
                providerId: result.messageId,
                acceptedAt: result.outcome === 'accepted' ? new Date() : null,
                error: result.error,
                nextAttemptAt: new Date(
                  Date.now() + Math.min(3600000, 60000 * 2 ** candidate.attempts),
                ),
                leaseToken: null,
                leaseUntil: null,
                ...(result.outcome === 'retryable' ? { dispatchStartedAt: null } : {}),
              },
            });
          },
          { timeoutMs: 60000 },
        );
      } catch (error) {
        held++;
        // A provider call whose result could not be committed is uncertain.
        // A validation failure observed before invocation is a safe hold.
        await prisma.withTenant(tenantId, async (tx) => {
          const row = await tx.legiWatchDeliveryRecipient.findFirst({
            where: { tenantId, id: candidate.id, leaseToken: token },
          });
          if (!row) return;
          await tx.legiWatchDeliveryRecipient.updateMany({
            where: { tenantId, id: row.id, leaseToken: token },
            data: {
              state: providerInvoked
                ? 'uncertain'
                : error instanceof Error && error.message === 'STAFF_QUIET_HOURS'
                  ? 'retryable'
                  : 'held',
              ...(!providerInvoked
                ? {
                    dispatchStartedAt: null,
                    leaseToken: null,
                    leaseUntil: null,
                    attempts: { decrement: 1 },
                    nextAttemptAt: new Date(Date.now() + 300000),
                  }
                : {}),
              error: providerInvoked
                ? 'DISPATCH_OUTCOME_UNCONFIRMED'
                : error instanceof Error
                  ? error.message
                  : 'AUTHORIZATION_HOLD',
            },
          });
        });
      }
    }
    return { attempted, held };
  }
  async history(ctx: WorkspaceTenantContext, runId: string) {
    await this.reports.run(ctx, runId);
    // Exact BCC and private-list provenance is limited to the approving owner.
    return this.reports.folders.withActor(ctx, (tx) =>
      tx.legiWatchDelivery.findMany({
        where: { tenantId: ctx.tenantId, runId, ownerClerkId: ctx.clerkUserId },
        include: { recipients: true },
        orderBy: { approvedAt: 'desc' },
      }),
    );
  }
  async retryHeld(ctx: WorkspaceTenantContext, id: string, input: unknown) {
    await this.reports.authorize(ctx);
    const body = object(input),
      reason = text(body.reason, 500);
    return this.reports.folders.withActor(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_delivery_recipient WHERE tenant_id=${ctx.tenantId} AND id=${id} FOR UPDATE`;
      const row = await tx.legiWatchDeliveryRecipient.findFirst({
        where: {
          tenantId: ctx.tenantId,
          id,
          state: 'held',
          delivery: { kind: 'bill_report', ownerClerkId: ctx.clerkUserId },
        },
        include: { delivery: true },
      });
      if (!row) throw new NotFoundException('HELD_REPORT_DELIVERY_NOT_FOUND');
      if (body.contentHash !== row.delivery.contentHash)
        throw new ConflictException('REVIEWED_CONTENT_CHANGED');
      if (!(await this.reports.flags.isEnabled(REPORT_DELIVERY_FEATURE, ctx.tenantId)))
        throw new ForbiddenException('REPORT_DELIVERY_DISABLED');
      await this.checkDispatch(
        tx,
        ctx,
        row.delivery,
        row.recipient as unknown as RecipientSnapshot,
        row.channel,
      );
      return tx.legiWatchDeliveryRecipient.updateMany({
        where: { tenantId: ctx.tenantId, id, state: 'held' },
        data: {
          state: 'queued',
          leaseToken: null,
          leaseUntil: null,
          dispatchStartedAt: null,
          nextAttemptAt: new Date(),
          error: `Reviewed retry by ${ctx.clerkUserId}: ${reason}`,
        },
      });
    });
  }
  async reconcile(ctx: WorkspaceTenantContext, id: string, input: unknown) {
    await this.reports.authorize(ctx);
    const b = object(input),
      reason = text(b.reason, 500);
    if (!['provider_accepted', 'confirmed_not_sent'].includes(String(b.outcome)))
      throw new BadRequestException('EXPLICIT_RECONCILIATION_REQUIRED');
    return this.reports.folders.withActor(ctx, async (tx) => {
      const row = await tx.legiWatchDeliveryRecipient.findFirst({
        where: {
          tenantId: ctx.tenantId,
          id,
          state: 'uncertain',
          delivery: { ownerClerkId: ctx.clerkUserId },
        },
      });
      if (!row) throw new NotFoundException('UNCERTAIN_DELIVERY_NOT_FOUND');
      return tx.legiWatchDeliveryRecipient.updateMany({
        where: { tenantId: ctx.tenantId, id, state: 'uncertain' },
        data: {
          state: b.outcome === 'provider_accepted' ? 'provider_accepted' : 'queued',
          error: `Reconciled by ${ctx.clerkUserId}: ${reason}`,
          providerId: b.outcome === 'provider_accepted' ? text(b.providerId) : null,
          dispatchStartedAt: null,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: new Date(),
          acceptedAt: b.outcome === 'provider_accepted' ? new Date() : null,
        },
      });
    });
  }
}
