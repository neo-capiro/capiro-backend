import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Prisma, LegiWatchDelivery } from '../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { HearingRecordWorkflowService } from './hearing-record-workflow.service.js';
import {
  ReportRecipientsService,
  type RecipientSnapshot,
} from '../tracker/reports/recipients.service.js';
import {
  RECORD_DELIVERY_FEATURE,
  HEARING_SMS_FEATURE,
} from '../feature-flags/feature-flag.service.js';
import { digest, escapeHtml, json, object, text } from '../tracker/reports/report-domain.js';
import { type HearingSmsRecipient } from './hearing-publication.service.js';
import { smsSize } from '../tracker/sms/sms.service.js';
import {
  selectedRecordBriefs,
  developmentKey,
  type IncludedRecordBrief,
} from '../tracker/reports/record-report-composition.js';

export type RecordDeliveryPacket = {
  schema: 'legiwatch.record-delivery.v1';
  eventId: string;
  briefId: string;
  contentHash: string;
  sourceHash: string;
  approvalHash: string;
  smsText: string | null;
};
export const recordDeliveryKind = (kind: string) =>
  kind === 'record_brief' || kind === 'record_correction';
export const recordSms = (title: string, claims: Array<{ text: string }>) =>
  `Capiro brief based on published records: ${title}. ${claims.map((c) => c.text).join(' ')} Reply STOP to opt out.`;
@Injectable()
export class HearingRecordDeliveryService {
  constructor(
    readonly workflow: HearingRecordWorkflowService,
    readonly recipients: ReportRecipientsService,
  ) {}
  async reportBriefs(
    ctx: WorkspaceTenantContext,
    reportId: string,
    input: unknown,
  ): Promise<IncludedRecordBrief[]> {
    const refs = selectedRecordBriefs(input);
    if (!refs.length) return [];
    await this.workflow.authorize(ctx, RECORD_DELIVERY_FEATURE);
    const folders = await this.workflow.actor(ctx, async (tx) => {
      const report = await this.workflow.reports.get(tx, ctx, reportId),
        out = [];
      if (report.archived) throw new ConflictException('REPORT_CHANGED_REVIEW_AGAIN');
      for (const id of report.folderIds)
        out.push(await this.workflow.reports.folders.folder(tx, ctx, id));
      return out;
    });
    const out: IncludedRecordBrief[] = [];
    for (const ref of refs) {
      const brief = await this.workflow.brief(ctx, ref.eventId, ref.briefId),
        doc = await this.workflow.approvedDocument(ctx, ref.eventId, ref.briefId, ref.contentHash);
      if (
        brief.payload.sourceHash !== ref.sourceHash ||
        brief.version !== ref.version ||
        brief.approvedAt?.toISOString() !== ref.approvedAt
      )
        throw new ConflictException('SELECTED_BRIEF_CHANGED_REVIEW_AGAIN');
      if (
        !brief.payload.clientId ||
        !folders.length ||
        folders.some((f) => f.archived || f.clientId !== brief.payload.clientId) ||
        !brief.payload.folders.length ||
        brief.payload.folders.some(
          (f) => !folders.some((r) => r.id === f.id && r.version === f.version),
        )
      )
        throw new BadRequestException('BRIEF_REQUIRES_EXACT_REPORT_CLIENT_AND_FOLDER_SCOPE');
      out.push({
        ...ref,
        title: doc.title,
        markdown: doc.markdown,
        kind: brief.payload.correction ? 'record_correction' : 'record_brief',
        developmentKeys: brief.payload.claims
          .filter((c) => c.kind !== 'analysis' && c.outcome === 'supported')
          .flatMap((c) =>
            c.references.map((ref) => brief.payload.records.find((r) => r.id === ref.id)!),
          )
          .filter((r) => r.billId && ['action', 'amendment'].includes(r.kind))
          .map((r) => developmentKey(r.billId!, r.identity, r.hash)),
      });
    }
    return out;
  }
  async reportOptions(ctx: WorkspaceTenantContext, reportId: string, offset = 0) {
    await this.workflow.authorize(ctx, RECORD_DELIVERY_FEATURE);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new BadRequestException('INVALID_RECORD_PAGE');
    await this.workflow.actor(ctx, (tx) => this.workflow.reports.get(tx, ctx, reportId));
    const rows = await this.workflow.actor(
      ctx,
      (tx) => tx.$queryRaw<
        Array<{ id: string; event_id: string }>
      >`SELECT id,event_id FROM intel_hearing_record_brief
      WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ${offset}`,
    );
    const options = [];
    for (const row of rows.slice(0, 50)) {
      try {
        const b = await this.workflow.brief(ctx, row.event_id, row.id);
        if (!b.current || !b.approvedAt) continue;
        const selected = {
          eventId: row.event_id,
          briefId: b.id,
          contentHash: b.contentHash,
          sourceHash: b.payload.sourceHash,
          version: b.version,
          approvedAt: b.approvedAt.toISOString(),
        };
        await this.reportBriefs(ctx, reportId, [selected]);
        options.push({
          ...selected,
          title: b.payload.title,
          correction: Boolean(b.payload.correction),
        });
      } catch {
        /* A private or stale candidate is omitted without revealing it. */
      }
    }
    return { options, next: rows.length > 50 ? offset + 50 : null };
  }
  async priorAudience(ctx: WorkspaceTenantContext, eventId: string, briefId: string) {
    const brief = await this.workflow.brief(ctx, eventId, briefId),
      correction = object(object(brief.payload).correction);
    if (!correction.priorId) return [];
    return this.workflow.actor(ctx, (tx) =>
      tx.legiWatchDeliveryRecipient.findMany({
        where: {
          tenantId: ctx.tenantId,
          state: { in: ['provider_accepted', 'delivered', 'uncertain'] },
          delivery: {
            ownerClerkId: ctx.clerkUserId,
            OR: [
              { composition: { path: ['publicationId'], equals: String(correction.priorId) } },
              {
                composition: {
                  path: ['recordBriefs'],
                  array_contains: [{ briefId: String(correction.priorId) }],
                },
              },
              { composition: { path: ['briefId'], equals: String(correction.priorId) } },
            ],
          },
        },
        orderBy: { id: 'asc' },
      }),
    );
  }
  async history(ctx: WorkspaceTenantContext, eventId: string, briefId: string, offset = 0) {
    await this.workflow.brief(ctx, eventId, briefId);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new BadRequestException('INVALID_DELIVERY_PAGE');
    const rows = await this.workflow.actor(ctx, (tx) =>
      tx.legiWatchDeliveryRecipient.findMany({
        where: {
          tenantId: ctx.tenantId,
          delivery: {
            ownerClerkId: ctx.clerkUserId,
            OR: [
              { composition: { path: ['briefId'], equals: briefId } },
              { composition: { path: ['recordBriefs'], array_contains: [{ briefId }] } },
            ],
          },
        },
        orderBy: { id: 'asc' },
        skip: offset,
        take: 51,
      }),
    );
    return {
      items: rows
        .slice(0, 50)
        .map((r) => ({
          id: r.id,
          deliveryId: r.deliveryId,
          channel: r.channel,
          state: r.state,
          name: String(object(r.recipient).name ?? 'Recipient'),
          destination:
            r.channel === 'sms'
              ? '••• ' + String(object(r.recipient).phone ?? '').slice(-4)
              : String(object(r.recipient).email ?? ''),
          error: r.error,
        })),
      next: rows.length > 50 ? offset + 50 : null,
    };
  }
  async preview(ctx: WorkspaceTenantContext, eventId: string, id: string, input: unknown) {
    await this.workflow.authorize(ctx, RECORD_DELIVERY_FEATURE);
    const body = object(input),
      brief = await this.workflow.brief(ctx, eventId, id),
      doc = await this.workflow.approvedDocument(ctx, eventId, id, brief.contentHash);
    const channel = body.channel ?? 'email';
    if (!['email', 'in_app', 'sms'].includes(String(channel)))
      throw new BadRequestException('INVALID_RECORD_DELIVERY_CHANNEL');
    const prior = await this.priorAudience(ctx, eventId, id),
      correction = object(object(brief.payload).correction);
    const recipients = await this.workflow.actor(ctx, async (tx) =>
      channel === 'in_app'
        ? this.workflow.publications.inboxRecipients(tx, ctx)
        : channel === 'sms'
          ? this.workflow.publications.smsRecipients(
              tx,
              ctx,
              { clientId: brief.payload.clientId },
              Array.isArray(body.consentIds) ? body.consentIds.map((v) => text(v, 100)) : [],
              'hearing_records',
            )
          : this.recipients.resolve(tx, ctx, body.selection),
    );
    if (!recipients.length || recipients.length > 25)
      throw new BadRequestException('RECORD_PILOT_REQUIRES_1_TO_25_RECIPIENTS');
    if (
      correction.priorId &&
      recipients.some(
        (r) =>
          !prior.some(
            (p) =>
              p.channel === channel &&
              p.destinationHash ===
                digest(channel === 'sms' ? (r as HearingSmsRecipient).phone : r.email),
          ),
      )
    )
      throw new BadRequestException('CORRECTION_AUDIENCE_MUST_BE_AFFECTED_PRIOR_RECIPIENTS');
    const message = channel === 'sms' ? recordSms(brief.payload.title, brief.payload.claims) : null;
    if (message && smsSize(message).segments > 3)
      throw new BadRequestException('SMS_EXCEEDS_THREE_SEGMENTS_CREATE_SHORTER_REVIEWED_BRIEF');
    const composition = {
      schema: 'legiwatch.record-delivery-preview.v1',
      kind: correction.priorId ? 'record_correction' : 'record_brief',
      eventId,
      briefId: id,
      contentHash: brief.contentHash,
      sourceHash: brief.payload.sourceHash,
      subject: doc.title,
      plainText: doc.markdown,
      html: `<html><body><pre style="white-space:pre-wrap">${escapeHtml(doc.markdown)}</pre></body></html>`,
      channel,
      recipients,
      smsText: message,
    };
    return {
      composition,
      approvalHash: digest(composition),
      unreachable: prior
        .filter(
          (p) =>
            !recipients.some(
              (r) =>
                p.channel === channel &&
                p.destinationHash ===
                  digest(channel === 'sms' ? (r as HearingSmsRecipient).phone : r.email),
            ),
        )
        .map((p) => ({
          recipientId: p.id,
          channel: p.channel,
          state: p.state,
          reason: 'Not selected or no longer eligible; review current destination and consent.',
        })),
    };
  }
  async enqueue(ctx: WorkspaceTenantContext, eventId: string, id: string, input: unknown) {
    const body = object(input),
      preview = await this.preview(ctx, eventId, id, input);
    if (body.approvalHash !== preview.approvalHash)
      throw new ConflictException('AUDIENCE_OR_CONTENT_CHANGED_REVIEW_AGAIN');
    const p = preview.composition,
      packet: RecordDeliveryPacket = {
        schema: 'legiwatch.record-delivery.v1',
        eventId,
        briefId: id,
        contentHash: p.contentHash,
        sourceHash: p.sourceHash,
        approvalHash: preview.approvalHash,
        smsText: p.smsText,
      };
    return this.workflow.actor(ctx, async (tx) => {
      const intentKey = `record-brief:${id}:${preview.approvalHash}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + intentKey},0))`;
      const existing = await tx.legiWatchDelivery.findFirst({
        where: { tenantId: ctx.tenantId, intentKey },
      });
      if (existing) return { id: existing.id, state: 'already_queued' };
      for (const recipient of p.recipients)
        await this.checkDispatch(
          tx,
          ctx,
          {
            kind: p.kind,
            contentHash: p.contentHash,
            composition: json(packet),
            approvedAt: new Date(),
          } as LegiWatchDelivery,
          recipient,
          String(p.channel),
        );
      const row = await tx.legiWatchDelivery.create({
        data: {
          tenantId: ctx.tenantId,
          ownerClerkId: ctx.clerkUserId,
          kind: p.kind,
          intentKey,
          contentHash: p.contentHash,
          composition: json(packet),
          recipients: {
            create: p.recipients.map((r) => ({
              channel: String(p.channel),
              destinationHash: digest(
                p.channel === 'sms' ? (r as HearingSmsRecipient).phone : r.email,
              ),
              recipient: json(r),
            })),
          },
        },
      });
      return { id: row.id, state: 'queued' };
    });
  }
  async checkDispatch(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    delivery: LegiWatchDelivery,
    recipient: RecipientSnapshot,
    channel: string,
  ) {
    const p = object(delivery.composition);
    if (
      !recordDeliveryKind(delivery.kind) ||
      p.schema !== 'legiwatch.record-delivery.v1' ||
      typeof p.eventId !== 'string' ||
      typeof p.briefId !== 'string' ||
      p.contentHash !== delivery.contentHash ||
      !/^[a-f0-9]{64}$/.test(String(p.sourceHash)) ||
      !/^[a-f0-9]{64}$/.test(String(p.approvalHash))
    )
      throw new BadRequestException('RECORD_DELIVERY_CONTRACT_INVALID');
    await this.workflow.authorize(ctx, RECORD_DELIVERY_FEATURE);
    const runtime = await tx.$queryRaw<
      Array<{ enabled: boolean }>
    >`SELECT (enabled AND schedule_enabled) AS enabled FROM legiwatch_runtime_heartbeat WHERE job_key='hearing-delivery-worker' FOR SHARE`;
    if (!runtime[0]?.enabled) throw new ForbiddenException('RECORD_DELIVERY_RUNTIME_DISABLED');
    if (
      !['email', 'sms', 'in_app'].includes(channel) ||
      process.env[
        channel === 'email'
          ? 'LEGIWATCH_RECORD_EMAIL_ENABLED'
          : channel === 'sms'
            ? 'LEGIWATCH_RECORD_SMS_ENABLED'
            : 'LEGIWATCH_RECORD_INBOX_ENABLED'
      ] !== 'true'
    )
      throw new ForbiddenException('RECORD_DELIVERY_CHANNEL_DISABLED');
    if (Date.now() - delivery.approvedAt.getTime() > 86400000)
      throw new ConflictException('RECORD_DELIVERY_REVIEW_EXPIRED');
    await this.workflow.sourceBoundary(tx, ctx, p.eventId);
    const brief = await this.workflow.brief(ctx, p.eventId, p.briefId),
      doc = await this.workflow.approvedDocument(ctx, p.eventId, p.briefId, delivery.contentHash);
    await this.workflow.lockContext(tx, ctx, brief.payload.clientId, brief.payload.folders);
    await this.workflow.lockObservation(tx, ctx, brief.payload.observation, true);
    if (brief.payload.sourceHash !== p.sourceHash)
      throw new ConflictException('RECORD_SOURCE_SNAPSHOT_CHANGED');
    const correction = object(object(brief.payload).correction);
    if ((delivery.kind === 'record_correction') !== Boolean(correction.priorId))
      throw new BadRequestException('CORRECTION_LINEAGE_REQUIRED');
    const citedBills = new Set(
      brief.payload.claims
        .flatMap((c) =>
          c.references.map((ref) => brief.payload.records.find((r) => r.id === ref.id)?.billId),
        )
        .filter(Boolean),
    );
    const packages = brief.payload.claims
      .flatMap((c) =>
        c.references.map((ref) => brief.payload.records.find((r) => r.id === ref.id)!),
      )
      .filter((r) => r.kind === 'official_transcript')
      .map((r) => r.identity);
    await tx.$queryRaw`SELECT id FROM state_bill WHERE id=ANY(${[...citedBills]}::text[]) FOR SHARE`;
    await tx.$queryRaw`SELECT package_id FROM official_hearing_transcript_check WHERE package_id=ANY(${packages}::text[]) FOR SHARE`;
    const checks = await this.workflow.source.checks(p.eventId);
    if (
      [...citedBills].some(
        (id) =>
          !checks.some(
            (c) =>
              c.billId === id &&
              ['success', 'partial'].includes(String(c.state)) &&
              Number.isFinite(Date.parse(String(c.checkedAt))) &&
              Date.now() - Date.parse(String(c.checkedAt)) <= 86400000,
          ),
      )
    )
      throw new ConflictException('PUBLISHED_RECORD_CHECK_REQUIRES_REFRESH');
    if (
      packages.some(
        (id) =>
          !checks.some(
            (c) =>
              c.packageId === id &&
              c.state === 'success' &&
              Number.isFinite(Date.parse(String(c.checkedAt))) &&
              Date.now() - Date.parse(String(c.checkedAt)) <= 86400000,
          ),
      )
    )
      throw new ConflictException('PUBLISHED_RECORD_CHECK_REQUIRES_REFRESH');
    for (const f of brief.payload.folders)
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_folder WHERE tenant_id=${ctx.tenantId} AND id=${f.id} FOR SHARE`;
    if (brief.payload.clientId)
      await tx.$queryRaw`SELECT id FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=${brief.payload.clientId}::uuid FOR SHARE`;
    if (channel === 'sms') {
      if (
        process.env.HEARING_SMS_READINESS_APPROVED !== 'true' ||
        !(await this.workflow.reports.flags.isEnabled(HEARING_SMS_FEATURE, ctx.tenantId))
      )
        throw new ForbiddenException('RECORD_SMS_NOT_QUALIFIED');
      await this.workflow.publications.recheckSms(
        tx,
        ctx,
        { clientId: brief.payload.clientId },
        recipient as HearingSmsRecipient,
        'hearing_records',
      );
      const message = recordSms(brief.payload.title, brief.payload.claims);
      if (message !== p.smsText || smsSize(message).segments > 3)
        throw new ConflictException('RECORD_SMS_CHANGED');
    } else if (channel === 'in_app') {
      if (object(recipient).userId !== ctx.clerkUserId)
        throw new ForbiddenException('RECORD_INBOX_OWNER_REQUIRED');
      await this.workflow.publications.inboxRecipients(tx, ctx);
    } else {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_report_contact WHERE tenant_id=${ctx.tenantId} AND (id=ANY(${recipient.contacts.map((c) => c.id)}::text[]) OR lower(email)=${recipient.email}) FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_report_list WHERE tenant_id=${ctx.tenantId} AND id=ANY(${recipient.lists.map((c) => c.id)}::text[]) FOR SHARE`;
      await this.recipients.recheck(tx, ctx, recipient);
    }
    if (correction.priorId) {
      const prior = await this.priorAudience(ctx, p.eventId, p.briefId);
      if (
        !prior.some(
          (r) =>
            r.channel === channel &&
            r.destinationHash ===
              digest(
                channel === 'sms' ? (recipient as HearingSmsRecipient).phone : recipient.email,
              ),
        )
      )
        throw new ForbiddenException('CORRECTION_RECIPIENT_NOT_PREVIOUSLY_AFFECTED');
    }
    // Re-read after permission row locks; mutators now serialize until dispatch returns.
    await this.workflow.brief(ctx, p.eventId, p.briefId);
    return doc;
  }
}
