import { KeywordDeliveryService } from '../keywords/keyword-delivery.service.js';
import { KEYWORD_DELIVERY_FEATURE } from '../keywords/keyword-rule.service.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
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
  AGENDA_ALERTS_FEATURE,
} from '../../feature-flags/feature-flag.service.js';
import { ReportService } from './report.service.js';
import { ReportRecipientsService, type RecipientSnapshot } from './recipients.service.js';
import {
  HearingPublicationService,
  publicationFeature,
  publicationSms,
  type HearingSmsRecipient,
} from '../../hearing/hearing-publication.service.js';
import { SmsService } from '../sms/sms.service.js';
import {
  HearingRecordDeliveryService,
  recordDeliveryKind,
} from '../../hearing/hearing-record-delivery.service.js';
import { RECORD_DELIVERY_FEATURE } from '../../feature-flags/feature-flag.service.js';
import { publicationMarkdown } from '../../hearing/publication-domain.js';
import {
  selectedRecordBriefs,
  renderReportWithBriefs,
  type SelectedRecordBrief,
} from './record-report-composition.js';
import {
  digest,
  escapeHtml,
  json,
  object,
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
  recordBriefs?: SelectedRecordBrief[];
}
@Injectable()
export class ReportDeliveryService {
  constructor(
    readonly reports: ReportService,
    readonly recipients: ReportRecipientsService,
    readonly email: IntelEmailService,
    @Optional() readonly hearing?: HearingPublicationService,
    @Optional() readonly sms?: SmsService,
    @Optional() readonly recordBriefs?: HearingRecordDeliveryService,
    @Optional() readonly keywords?: KeywordDeliveryService,
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
    const refs = selectedRecordBriefs(body.recordBriefs);
    if (refs.length && !this.recordBriefs)
      throw new ForbiddenException('RECORD_DELIVERY_ADAPTER_UNAVAILABLE');
    const included = refs.length
      ? await this.recordBriefs!.reportBriefs(ctx, run.reportId, refs)
      : [];
    const rendered = included.length
      ? renderReportWithBriefs(run.snapshot as unknown as ReportDocument, included)
      : run.rendered;
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
      ...(refs.length ? { recordBriefs: refs } : {}),
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
    if (delivery.kind === 'bill_keyword') {
      if (!this.keywords) throw new ForbiddenException('KEYWORD_DELIVERY_ADAPTER_UNAVAILABLE');
      return this.keywords.checkDispatch(tx, ctx, delivery, object(recipient), channel);
    }
    if (recordDeliveryKind(delivery.kind)) {
      if (!this.recordBriefs) throw new ForbiddenException('RECORD_DELIVERY_ADAPTER_UNAVAILABLE');
      return this.recordBriefs.checkDispatch(tx, ctx, delivery, recipient, channel);
    }
    if (delivery.kind === 'live_update' || delivery.kind === 'hearing_recap') {
      if (!this.hearing) throw new ForbiddenException('HEARING_DELIVERY_ADAPTER_UNAVAILABLE');
      await tx.$executeRaw`SELECT set_config('app.hearing_actor',${ctx.clerkUserId},true)`;
      return this.hearing.checkDispatch(tx, ctx, delivery, recipient, channel);
    }
    if (delivery.kind === 'bill_record' || delivery.kind === 'agenda')
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
    const refs = selectedRecordBriefs(object(delivery.composition).recordBriefs);
    if (refs.length) {
      if (!this.recordBriefs) throw new ForbiddenException('RECORD_DELIVERY_ADAPTER_UNAVAILABLE');
      const included = await this.recordBriefs.reportBriefs(ctx, run.reportId, refs);
      for (const brief of included)
        await this.recordBriefs.checkDispatch(
          tx,
          ctx,
          {
            ...delivery,
            kind: brief.kind,
            contentHash: brief.contentHash,
            composition: json({
              schema: 'legiwatch.record-delivery.v1',
              ...brief,
              approvalHash: digest(delivery.composition),
              smsText: null,
            }),
          },
          recipient,
          channel,
        );
      const rendered = renderReportWithBriefs(doc, included),
        composition = object(delivery.composition),
        intro = String(composition.introduction ?? '');
      if (
        composition.plainText !== `${intro}\n\n${rendered.text}` ||
        composition.html !==
          rendered.html.replace(
            '<body>',
            `<body><p>${escapeHtml(intro).replace(/\n/g, '<br>')}</p>`,
          )
      )
        throw new ConflictException('RECORD_REPORT_COMPOSITION_CHANGED');
    }
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
    if (delivery.kind === 'agenda') {
      if (
        !(await this.reports.flags.isEnabled(AGENDA_ALERTS_FEATURE, ctx.tenantId)) ||
        process.env.LEGIWATCH_AGENDA_ALERTS_ENABLED !== 'true'
      )
        throw new ForbiddenException('AGENDA_DELIVERY_DISABLED');
      const packet = object(delivery.composition);
      if (!Array.isArray(packet.records) && !packet.singleBillCheck) {
        const billIds = Array.isArray(packet.billIds)
          ? packet.billIds.filter((id): id is string => typeof id === 'string')
          : [];
        if (!billIds.length) throw new ForbiddenException('AGENDA_BILL_SCOPE_UNAVAILABLE');
        // Authorize EVERY rendered bill. A partly revoked packet is held in its
        // entirety, never delivered with old mixed-scope content.
        const scopeItems = (Array.isArray(packet.scopeItems) ? packet.scopeItems : []).map(object);
        if (billIds.some((id) => !scopeItems.some((s) => s.billId === id)))
          throw new ForbiddenException('AGENDA_SCOPE_EVIDENCE_UNAVAILABLE');
        for (const scopeItem of scopeItems) {
          const refs = (Array.isArray(packet.ruleRefs) ? packet.ruleRefs : [])
            .map(object)
            .filter((ref) =>
              (Array.isArray(ref.memberships) ? ref.memberships : []).some(
                (m) =>
                  object(m).billId === scopeItem.billId &&
                  object(m).folderId === scopeItem.folderId,
              ),
            )
            .map((ref) => ({ ...ref, folderIds: [scopeItem.folderId] }));
          await this.checkRecordDispatch(
            tx,
            ctx,
            {
              ...delivery,
              composition: json({
                ...packet,
                billId: scopeItem.billId,
                ruleRefs: refs,
                singleBillCheck: true,
              }),
            },
            recipient,
            channel,
          );
        }
        return;
      }
    }
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
      delivery.kind !== 'agenda' &&
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
          family: delivery.kind === 'agenda' ? 'agenda' : 'bill_record',
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
    if (delivery.kind === 'agenda') {
      const events = await tx.$queryRawUnsafe<
        Array<{ checkState: string; checkedAt: Date | null }>
      >(
        `SELECT calendar_check_state AS "checkState",calendar_checked_at AS "checkedAt" FROM committee_hearing WHERE id=$1 AND visibility='public'`,
        String(composition.hearingId),
      );
      if (
        !events[0] ||
        events[0].checkState !== 'complete' ||
        !events[0].checkedAt ||
        Date.now() - events[0].checkedAt.getTime() > 86400000
      )
        throw new ConflictException('CALENDAR_SOURCE_CHECK_INCOMPLETE');
      return;
    }
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
  async bundleEndOfDay(tenantId: string, now: Date, kind = 'bill_record') {
    return this.reports.folders.prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':' + kind + '-digest'},0))`;
      const rows = await tx.legiWatchDeliveryRecipient.findMany({
        where: {
          tenantId,
          state: 'queued',
          nextAttemptAt: { lte: now },
          delivery: {
            kind,
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
          ...(kind === 'bill_keyword' ? [row.delivery.ownerClerkId] : []),
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
        const intentKey = `${kind}-digest:${key}:${digest(group.map((r) => r.id).sort())}`;
        const title = `${kind === 'agenda' ? 'Calendar agenda updates' : kind === 'bill_keyword' ? 'Keyword matches' : 'Published legislative records'} · ${records.length} developments`;
        const content = records.map((r) => `${r.title}\n${r.content}`).join('\n\n');
        const eventKey = digest(records.map((r) => r.eventKey).sort());
        await tx.legiWatchDelivery.upsert({
          where: { tenantId_intentKey: { tenantId, intentKey } },
          update: {},
          create: {
            tenantId,
            intentKey,
            kind,
            ownerClerkId: first.delivery.ownerClerkId,
            contentHash: digest([title, content]),
            composition: json({
              title,
              content,
              html: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(content).replace(/\n/g, '<br>')}</p>`,
              records,
              eventKey,
              billId: records[0]!.billId,
              ...(kind === 'agenda' ? { hearingId: records[0]!.hearingId } : {}),
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
    if (
      kind === 'bill_keyword' &&
      (!this.keywords ||
        process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED !== 'true' ||
        !(await this.reports.flags.isEnabled(KEYWORD_DELIVERY_FEATURE, tenantId)))
    )
      return { attempted: 0, held: 0 };
    if (
      recordDeliveryKind(kind) &&
      (!this.recordBriefs ||
        !(await this.reports.flags.isEnabled(RECORD_DELIVERY_FEATURE, tenantId)) ||
        ![
          'LEGIWATCH_RECORD_EMAIL_ENABLED',
          'LEGIWATCH_RECORD_SMS_ENABLED',
          'LEGIWATCH_RECORD_INBOX_ENABLED',
        ].some((key) => process.env[key] === 'true'))
    )
      return { attempted: 0, held: 0 };
    if (
      (kind === 'live_update' || kind === 'hearing_recap') &&
      (!this.hearing ||
        (process.env.LEGIWATCH_HEARING_EMAIL_ENABLED !== 'true' &&
          process.env.LEGIWATCH_HEARING_SMS_ENABLED !== 'true' &&
          process.env.LEGIWATCH_HEARING_INBOX_ENABLED !== 'true') ||
        !(await this.reports.flags.isEnabled(publicationFeature(kind), tenantId)))
    )
      return { attempted: 0, held: 0 };
    if (
      kind === 'agenda' &&
      (process.env.LEGIWATCH_AGENDA_ALERTS_ENABLED !== 'true' ||
        !(await this.reports.flags.isEnabled(AGENDA_ALERTS_FEATURE, tenantId)))
    )
      return { attempted: 0, held: 0 };
    // An older worker with no Phase 2 source allowlist must not claim and hold
    // records that belong to the explicitly configured report worker.
    if (
      kind === 'bill_record' &&
      (!(process.env.LEGIWATCH_RECORD_ALERT_SOURCE_TYPES ?? '').trim() ||
        !['true', '1', 'yes'].includes((process.env.TRACKER_ALERTS_ENABLED ?? '').toLowerCase()) ||
        !(await this.reports.flags.isEnabled(TRACKER_OWNER_FEATURE, tenantId)))
    )
      return { attempted: 0, held: 0 };
    if (['bill_record', 'agenda', 'bill_keyword'].includes(kind))
      await this.bundleEndOfDay(tenantId, now, kind);
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
            ...(['bill_record', 'agenda', 'bill_keyword'].includes(kind)
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
        await this.reports.authorize(
          ctx,
          recordDeliveryKind(candidate.delivery.kind)
            ? RECORD_DELIVERY_FEATURE
            : candidate.delivery.kind === 'bill_keyword'
              ? KEYWORD_DELIVERY_FEATURE
              : candidate.delivery.kind === 'agenda'
                ? AGENDA_ALERTS_FEATURE
                : ['live_update', 'hearing_recap'].includes(candidate.delivery.kind)
                  ? publicationFeature(candidate.delivery.kind)
                  : undefined,
        );
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
            if (recordDeliveryKind(candidate.delivery.kind)) {
              const packet = object(candidate.delivery.composition),
                doc = await this.recordBriefs!.workflow.approvedDocument(
                  ctx,
                  String(packet.eventId),
                  String(packet.briefId),
                  candidate.delivery.contentHash,
                );
              if (candidate.channel === 'in_app') {
                const secret = process.env.INTERNAL_SERVICE_SECRET;
                if (!secret) throw new BadRequestException('INBOX_ADAPTER_NOT_CONFIGURED');
                providerInvoked = true;
                const response = await fetch(
                  `${(process.env.API_BASE_URL ?? 'https://app.capiro.ai').replace(/\/+$/, '')}/api/internal/legiwatch/record-brief-notification`,
                  {
                    method: 'POST',
                    headers: {
                      'content-type': 'application/json',
                      'x-internal-service-secret': secret,
                    },
                    signal: AbortSignal.timeout(15000),
                    body: JSON.stringify({
                      tenantId,
                      userId: ctx.clerkUserId,
                      eventId: doc.eventId,
                      briefId: doc.briefId,
                      contentHash: doc.contentHash,
                      kind: candidate.delivery.kind,
                      title: doc.title,
                      body:
                        doc.markdown.length > 10000
                          ? doc.markdown.slice(0, 9000) +
                            '\n\nExcerpt — open the reviewed brief for complete evidence.'
                          : doc.markdown,
                    }),
                  },
                );
                const ack = response.ok
                  ? ((await response.json()) as { suppressed?: boolean })
                  : null;
                result =
                  response.ok && !ack?.suppressed
                    ? { outcome: 'accepted' as const, messageId: 'record-inbox:' + doc.briefId }
                    : {
                        outcome: 'terminal' as const,
                        error: response.ok
                          ? 'INBOX_ACCESS_SUPPRESSED'
                          : 'INBOX_HTTP_' + response.status,
                      };
              } else if (candidate.channel === 'sms') {
                if (!this.sms) throw new BadRequestException('SMS_ADAPTER_UNAVAILABLE');
                providerInvoked = true;
                const sent = await this.sms.send(
                  (recipient as HearingSmsRecipient).phone,
                  String(packet.smsText),
                );
                result = {
                  outcome: sent.sent
                    ? ('accepted' as const)
                    : sent.uncertain
                      ? ('uncertain' as const)
                      : ('terminal' as const),
                  messageId: sent.providerMessageId,
                  error: sent.error,
                };
              } else {
                providerInvoked = true;
                result = await this.email.sendReport(
                  recipient.email,
                  recipient.role,
                  doc.title,
                  `<html><body><pre style="white-space:pre-wrap">${escapeHtml(doc.markdown)}</pre></body></html>`,
                  doc.markdown,
                );
              }
            } else if (
              candidate.delivery.kind === 'live_update' ||
              candidate.delivery.kind === 'hearing_recap'
            ) {
              const approved = await this.hearing!.get(
                tx,
                ctx,
                String(object(candidate.delivery.composition).publicationId),
              );
              const plainText = publicationMarkdown(approved.payload);
              if (candidate.channel === 'in_app') {
                const secret = process.env.INTERNAL_SERVICE_SECRET;
                if (!secret) throw new BadRequestException('INBOX_ADAPTER_NOT_CONFIGURED');
                providerInvoked = true;
                const response = await fetch(
                  `${(process.env.API_BASE_URL ?? 'https://app.capiro.ai').replace(/\/+$/, '')}/api/internal/legiwatch/hearing-publication-notification`,
                  {
                    method: 'POST',
                    headers: {
                      'content-type': 'application/json',
                      'x-internal-service-secret': secret,
                    },
                    signal: AbortSignal.timeout(15000),
                    body: JSON.stringify({
                      tenantId,
                      userId: ctx.clerkUserId,
                      publicationId: approved.row.id,
                      contentHash: approved.row.contentHash,
                      title: approved.payload.label + ': ' + approved.payload.title,
                      body:
                        plainText.length <= 10000
                          ? plainText
                          : plainText.slice(0, 9000) +
                            '\n\nExcerpt — open the approved version for all claims and evidence.',
                    }),
                  },
                );
                const acknowledgement = response.ok
                  ? ((await response.json()) as { suppressed?: boolean })
                  : null;
                result =
                  response.ok && !acknowledgement?.suppressed
                    ? { outcome: 'accepted' as const, messageId: 'inbox:' + approved.row.id }
                    : {
                        outcome: 'terminal' as const,
                        error: response.ok
                          ? 'INBOX_ACCESS_SUPPRESSED'
                          : 'INBOX_HTTP_' + response.status,
                      };
              } else if (candidate.channel === 'sms') {
                if (!this.sms) throw new BadRequestException('SMS_ADAPTER_UNAVAILABLE');
                const message = publicationSms(approved.payload);
                if (object(candidate.delivery.composition).smsText !== message)
                  throw new ConflictException('APPROVED_SMS_CONTENT_CHANGED');
                providerInvoked = true;
                const sent = await this.sms.send((recipient as HearingSmsRecipient).phone, message);
                result = {
                  outcome: sent.sent
                    ? ('accepted' as const)
                    : sent.uncertain
                      ? ('uncertain' as const)
                      : ('terminal' as const),
                  messageId: sent.providerMessageId,
                  error: sent.error,
                };
              } else {
                providerInvoked = true;
                result = await this.email.sendReport(
                  recipient.email,
                  recipient.role,
                  approved.payload.label + ': ' + approved.payload.title,
                  `<html><body><pre style="white-space:pre-wrap">${escapeHtml(plainText)}</pre></body></html>`,
                  plainText,
                );
              }
            } else if (
              candidate.delivery.kind === 'bill_record' ||
              candidate.delivery.kind === 'agenda' ||
              candidate.delivery.kind === 'bill_keyword'
            ) {
              const packet = object(candidate.delivery.composition),
                staff = object(candidate.recipient);
              if (candidate.channel === 'in_app') {
                const secret = process.env.INTERNAL_SERVICE_SECRET;
                if (!secret) throw new BadRequestException('INBOX_ADAPTER_NOT_CONFIGURED');
                providerInvoked = true;
                const response = await fetch(
                  `${(process.env.API_BASE_URL ?? 'https://app.capiro.ai').replace(/\/+$/, '')}/api/internal/legiwatch/${candidate.delivery.kind === 'agenda' ? 'agenda-notification' : candidate.delivery.kind === 'bill_keyword' ? 'keyword-notification' : 'bill-record-notification'}`,
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
                      ...(candidate.delivery.kind === 'agenda'
                        ? { hearingId: packet.hearingId }
                        : { billId: packet.billId }),
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
                if (candidate.delivery.kind === 'bill_keyword' && response.ok) {
                  const ack = object(await response.json());
                  if (ack.suppressed === true)
                    result = {
                      outcome: 'terminal' as const,
                      error: 'INBOX_SUBSCRIPTION_REVOKED',
                      messageId: undefined,
                    };
                  else if (typeof ack.created !== 'number')
                    throw new Error('INBOX_ACKNOWLEDGEMENT_UNCONFIRMED');
                }
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
          delivery: {
            kind: { in: ['bill_report', 'record_brief', 'record_correction', 'bill_keyword'] },
            ownerClerkId: ctx.clerkUserId,
          },
        },
        include: { delivery: true },
      });
      if (!row) throw new NotFoundException('HELD_REPORT_DELIVERY_NOT_FOUND');
      if (body.contentHash !== row.delivery.contentHash)
        throw new ConflictException('REVIEWED_CONTENT_CHANGED');
      if (
        !(await this.reports.flags.isEnabled(
          recordDeliveryKind(row.delivery.kind)
            ? RECORD_DELIVERY_FEATURE
            : row.delivery.kind === 'bill_keyword'
              ? KEYWORD_DELIVERY_FEATURE
              : REPORT_DELIVERY_FEATURE,
          ctx.tenantId,
        ))
      )
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
