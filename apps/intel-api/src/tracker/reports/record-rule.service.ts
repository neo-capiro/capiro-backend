import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { isFolderAdmin, canEditFolder } from '../folders/folder-tracker.service.js';
import { ReportService } from './report.service.js';
import {
  digest,
  escapeHtml,
  ids,
  json,
  object,
  text,
  version,
  type ReportBill,
} from './report-domain.js';
import { localOccurrence, localTime, validateSchedule } from './report-schedule.js';

export interface RuleRecipient {
  sourceUserId?: string;
  userId: string;
  email: boolean;
  inApp: boolean;
}
export function capturedRule(raw: unknown) {
  const r = object(raw);
  if (r.family !== 'Bill Action and Amendments Filed Alert')
    throw new BadRequestException('ALERT_FAMILY_OUTSIDE_PHASE2');
  const frequency = Array.isArray(r.frequency) ? r.frequency : [];
  if (frequency.length !== 1 || !['Real time', 'End of day'].includes(String(frequency[0])))
    throw new BadRequestException('CAPTURED_CADENCE_REQUIRES_REVIEW');
  const folders = (Array.isArray(r.selected_targets) ? r.selected_targets : []).flatMap((t) => {
    const target = object(t);
    return target.type === 'folder' && Array.isArray(target.selected)
      ? target.selected.map((f) => String(object(f).id))
      : [];
  });
  return {
    name: text(r.name),
    sourceFolderIds: ids(folders),
    cadence: frequency[0] === 'Real time' ? 'realtime' : 'end_of_day',
  };
}

@Injectable()
export class RecordRuleService {
  constructor(readonly reports: ReportService) {}
  async list(ctx: WorkspaceTenantContext) {
    await this.reports.authorize(ctx);
    return this.reports.folders.withActor(ctx, (tx) =>
      tx.legiWatchRecordRule.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    );
  }
  async promote(ctx: WorkspaceTenantContext, stagedId: string, input: unknown) {
    await this.reports.authorize(ctx);
    const b = object(input);
    if (!isFolderAdmin(ctx)) throw new ForbiddenException('RULE_PROMOTION_REQUIRES_ADMIN');
    return this.reports.folders.withActor(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_staged_configuration WHERE tenant_id=${ctx.tenantId} AND id=${stagedId} FOR UPDATE`;
      const staged = await tx.legiWatchStagedConfiguration.findFirst({
        where: { tenantId: ctx.tenantId, id: stagedId, kind: 'alert', state: { not: 'excluded' } },
      });
      if (!staged) throw new NotFoundException('STAGED_RULE_NOT_FOUND');
      const previous = await tx.legiWatchPromotion.findFirst({
        where: { tenantId: ctx.tenantId, stagedId },
      });
      if (previous)
        return {
          id: previous.targetId,
          state: 'already_promoted',
          sourceChanged: previous.sourceHash !== digest(staged.payload),
        };
      const raw = object(staged.payload),
        normalized = capturedRule(raw),
        sourceKey = String(raw.audit_key);
      const otherCaptures = await tx.legiWatchPromotion.findMany({
        where: {
          tenantId: ctx.tenantId,
          sourceAccount: staged.sourceAccount,
          kind: 'alert',
          sourceId: { endsWith: `:${sourceKey}` },
        },
      });
      if (otherCaptures.length && !b.existingRuleId && b.confirmNewDefinition !== true)
        return {
          state: 'needs_review',
          reason: 'RECONCILE_NEW_CAPTURE_WITH_EXISTING_RULE',
          candidates: otherCaptures.map((p) => p.targetId),
        };
      if (b.existingRuleId) {
        const existing = await tx.legiWatchRecordRule.findFirst({
          where: {
            tenantId: ctx.tenantId,
            id: text(b.existingRuleId),
            ownerClerkId: ctx.clerkUserId,
          },
        });
        if (!existing) throw new NotFoundException('EXISTING_RULE_NOT_FOUND');
        await tx.legiWatchPromotion.create({
          data: {
            tenantId: ctx.tenantId,
            stagedId,
            sourceAccount: staged.sourceAccount,
            sourceId: staged.sourceId,
            sourceVersion: staged.version,
            sourceHash: digest(staged.payload),
            kind: 'alert',
            targetId: existing.id,
            reviewedBy: ctx.clerkUserId,
          },
        });
        return { id: existing.id, state: 'linked_existing_edits_preserved' };
      }
      const mappings = await tx.legiWatchSourceMapping.findMany({
        where: {
          tenantId: ctx.tenantId,
          sourceAccount: staged.sourceAccount,
          kind: 'folder',
          sourceId: { in: normalized.sourceFolderIds },
        },
      });
      const issues: string[] = normalized.sourceFolderIds
        .filter((id) => !mappings.some((m) => m.sourceId === id))
        .map((id) => `Unresolved folder ${id}`);
      if (!normalized.sourceFolderIds.length) issues.push('No folder targets selected');
      const channels = await tx.legiWatchStagedConfiguration.findMany({
        where: {
          tenantId: ctx.tenantId,
          sourceAccount: staged.sourceAccount,
          kind: 'alert_channel',
        },
      });
      const capture = staged.sourceId.slice(0, staged.sourceId.lastIndexOf(':'));
      const userMappings = object(b.userMappings),
        recipients: RuleRecipient[] = [];
      for (const c of channels.filter(
        (c) => c.sourceId.startsWith(`${capture}:`) && object(c.payload).alert_key === sourceKey,
      )) {
        const channel = object(c.payload);
        if (channel.email_selected !== true && channel.notification_selected !== true) continue;
        const sourceUserId = String(channel.user_id),
          userId = userMappings[sourceUserId];
        if (
          typeof userId !== 'string' ||
          !(await this.reports.folders.source.activeMember(ctx.tenantId, userId))
        ) {
          issues.push(`Unresolved staff member ${sourceUserId}`);
          continue;
        }
        recipients.push({
          sourceUserId,
          userId,
          email: channel.email_selected === true,
          inApp: channel.notification_selected === true,
        });
      }
      if (!recipients.length) issues.push('Current staff recipient mappings required');
      const rule = await tx.legiWatchRecordRule.create({
        data: {
          tenantId: ctx.tenantId,
          ownerClerkId: ctx.clerkUserId,
          name: normalized.name,
          folderIds: mappings.map((m) => m.targetId),
          recipients: json(recipients),
          cadence: normalized.cadence,
          issues: json(issues),
          state: 'needs_review',
        },
      });
      await tx.legiWatchPromotion.create({
        data: {
          tenantId: ctx.tenantId,
          stagedId,
          sourceAccount: staged.sourceAccount,
          sourceId: staged.sourceId,
          sourceVersion: staged.version,
          sourceHash: digest(staged.payload),
          kind: 'alert',
          targetId: rule.id,
          reviewedBy: ctx.clerkUserId,
        },
      });
      return rule;
    });
  }
  async save(ctx: WorkspaceTenantContext, id: string, input: unknown) {
    await this.reports.authorize(ctx);
    const b = object(input),
      folderIds = ids(b.folderIds);
    if (!Array.isArray(b.recipients) || b.recipients.length > 100)
      throw new BadRequestException('STAFF_RECIPIENTS_REQUIRED');
    const recipients = b.recipients.map((r) => {
      const x = object(r);
      return { userId: text(x.userId), email: x.email === true, inApp: x.inApp === true };
    });
    if (!['realtime', 'end_of_day'].includes(String(b.cadence)))
      throw new BadRequestException('RULE_CADENCE_REQUIRED');
    const schedule =
      b.cadence === 'end_of_day'
        ? validateSchedule(b.timezone, b.localMinutes)
        : { timezone: null, localMinutes: null };
    for (const r of recipients)
      if (!(await this.reports.folders.source.activeMember(ctx.tenantId, r.userId)))
        throw new BadRequestException('STAFF_MEMBERSHIP_REQUIRED');
    return this.reports.folders.withActor(ctx, async (tx) => {
      const rule = await tx.legiWatchRecordRule.findFirst({
        where: { tenantId: ctx.tenantId, id, ownerClerkId: ctx.clerkUserId },
      });
      if (!rule) throw new NotFoundException('RULE_NOT_FOUND');
      for (const folderId of folderIds) await this.reports.folders.folder(tx, ctx, folderId, true);
      const changed = await tx.legiWatchRecordRule.updateMany({
        where: { tenantId: ctx.tenantId, id, version: version(b.expectedVersion) },
        data: {
          name: text(b.name),
          folderIds,
          recipients: json(recipients),
          cadence: String(b.cadence),
          ...schedule,
          state: 'needs_review',
          version: { increment: 1 },
          issues: json([]),
        },
      });
      if (!changed.count) throw new ConflictException('RULE_CHANGED_RELOAD');
      return tx.legiWatchRecordRule.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id } });
    });
  }
  async readiness(ctx: WorkspaceTenantContext, id: string) {
    await this.reports.authorize(ctx);
    const data = await this.reports.folders.withActor(ctx, async (tx) => {
      const rule = await tx.legiWatchRecordRule.findFirst({
        where: { tenantId: ctx.tenantId, id },
      });
      if (!rule) throw new NotFoundException('RULE_NOT_FOUND');
      const folders = await Promise.all(
        rule.folderIds.map((id) => this.reports.folders.folder(tx, ctx, id)),
      );
      const assignments = await tx.legiWatchFolderBill.findMany({
        where: { tenantId: ctx.tenantId, folderId: { in: rule.folderIds } },
        take: 10001,
      });
      if (assignments.length > 10000) throw new BadRequestException('RULE_LIMIT_10000_ASSIGNMENTS');
      return { rule, folders, assignments };
    });
    const issues = Array.isArray(data.rule.issues) ? data.rule.issues.map(String) : [];
    if (!data.folders.length) issues.push('No folder targets selected');
    if (data.folders.some((f) => !canEditFolder(f, data.rule.ownerClerkId)))
      issues.push('Rule owner no longer has folder change access');
    if (data.folders.some((f) => f.archived || !f.ownerClerkId))
      issues.push('Archived or unresolved folder owner');
    for (const f of data.folders)
      if (
        f.ownerClerkId &&
        !(await this.reports.folders.source.activeMember(ctx.tenantId, f.ownerClerkId))
      )
        issues.push('Folder owner no longer active');
    if (!data.assignments.length) issues.push('No currently mapped bills');
    if (
      data.rule.cadence === 'end_of_day' &&
      (!data.rule.timezone || data.rule.localMinutes == null)
    )
      issues.push('Local end-of-day time required');
    const recipients = data.rule.recipients as unknown as RuleRecipient[];
    if (!recipients.some((r) => r.email || r.inApp)) issues.push('No recipients selected');
    for (const r of recipients)
      if (!(await this.reports.folders.source.activeMember(ctx.tenantId, r.userId)))
        issues.push('Staff recipient no longer active');
    for (const r of recipients.filter((r) => r.email)) {
      const destination = await this.reports.folders.source.staffDestination(
        ctx.tenantId,
        r.userId,
      );
      if (!destination?.email) issues.push('Selected staff email is unavailable');
      for (const clientId of [
        ...new Set(data.folders.flatMap((f) => (f.clientId ? [f.clientId] : []))),
      ]) {
        const pref = await this.reports.folders.withActor(ctx, (tx) =>
          tx.intelAlertPreference.findFirst({
            where: { tenantId: ctx.tenantId, clientId, userId: r.userId },
          }),
        );
        if (
          !pref?.emailEnabled ||
          pref.emailAddress?.toLowerCase() !== destination?.email?.toLowerCase()
        )
          issues.push('Current client email preference must match the selected staff address');
        if (pref && pref.emailCadence !== (data.rule.cadence === 'realtime' ? 'realtime' : 'daily'))
          issues.push('Client email cadence conflicts with the selected rule');
        if (
          pref?.jurisdictions.length &&
          data.folders.some(
            (f) => f.clientId === clientId && !pref.jurisdictions.includes(f.jurisdiction),
          )
        )
          issues.push('Client preference excludes a selected jurisdiction');
      }
    }
    const billIds = [...new Set(data.assignments.map((a) => a.billId))],
      bills: ReportBill[] = [];
    for (let i = 0; i < billIds.length; i += 250)
      bills.push(...(await this.reports.folders.source.reportBills(billIds.slice(i, i + 250))));
    if (billIds.some((id) => !bills.some((b) => b.id === id)))
      issues.push('Canonical bill mapping incomplete');
    if (
      bills.some(
        (b) =>
          b.sourceCheckStatus !== 'success' ||
          !b.sourceCheckedAt ||
          Date.now() - Date.parse(b.sourceCheckedAt) > 86400000 ||
          !b.coverage.actions ||
          !b.coverage.amendments,
      )
    )
      issues.push('Published action or amendment source coverage incomplete or stale');
    return {
      ...data,
      issues: [...new Set(issues)],
      ready: !issues.length,
      examples: bills
        .flatMap((b) => b.events.slice(-2).map((e) => ({ billId: b.id, number: b.number, ...e })))
        .slice(0, 5),
    };
  }
  async activation(ctx: WorkspaceTenantContext, id: string, input: unknown, now = new Date()) {
    const b = object(input),
      readiness = await this.readiness(ctx, id);
    if (readiness.rule.ownerClerkId !== ctx.clerkUserId)
      throw new ForbiddenException('RULE_OWNER_REQUIRED');
    if (b.enabled !== true && b.enabled !== false)
      throw new BadRequestException('ENABLE_OR_PAUSE_REQUIRED');
    if (b.enabled && !readiness.ready)
      throw new BadRequestException({ message: 'RULE_NEEDS_REVIEW', issues: readiness.issues });
    return this.reports.folders.withActor(ctx, async (tx) => {
      const updated = await tx.legiWatchRecordRule.updateMany({
        where: { tenantId: ctx.tenantId, id, version: version(b.expectedVersion) },
        data: {
          state: b.enabled ? 'active' : 'paused',
          version: { increment: 1 },
          activatedAt: b.enabled ? now : readiness.rule.activatedAt,
        },
      });
      if (!updated.count) throw new ConflictException('RULE_CHANGED_RELOAD');
      if (b.enabled)
        for (const a of readiness.assignments)
          await tx.legiWatchRuleBillBaseline.upsert({
            where: {
              tenantId_ruleId_assignmentId: {
                tenantId: ctx.tenantId,
                ruleId: id,
                assignmentId: a.id,
              },
            },
            create: { tenantId: ctx.tenantId, ruleId: id, assignmentId: a.id, baselineAt: now },
            update: { baselineAt: now },
          });
      return { state: b.enabled ? 'active' : 'paused', baselineAt: now };
    });
  }
  /** Invoked by the existing detector task. No provider poller, materiality
   * shortcuts, legacy tracker rows or fourteen-day dedup are involved.
   */
  async detect(tenantId: string, now = new Date()) {
    const prisma = this.reports.folders.prisma;
    const rules = await prisma.withTenant(tenantId, (tx) =>
      tx.legiWatchRecordRule.findMany({ where: { tenantId, state: 'active' } }),
    );
    let matches = 0;
    for (const rule of rules) {
      const ctx: WorkspaceTenantContext = { tenantId, clerkUserId: rule.ownerClerkId, role: null };
      let ready;
      try {
        ready = await this.readiness(ctx, rule.id);
      } catch {
        continue;
      }
      if (!ready.ready) continue;
      const billIds = [...new Set(ready.assignments.map((a) => a.billId))],
        bills: ReportBill[] = [];
      for (let i = 0; i < billIds.length; i += 250)
        bills.push(...(await this.reports.folders.source.reportBills(billIds.slice(i, i + 250))));
      await prisma.withTenant(tenantId, async (tx) => {
        await tx.$queryRaw`SELECT id FROM intel_legiwatch_record_rule WHERE tenant_id=${tenantId} AND id=${rule.id} FOR UPDATE`;
        const current = await tx.legiWatchRecordRule.findFirst({
          where: { tenantId, id: rule.id, version: rule.version, state: 'active' },
        });
        if (!current) return;
        const baselines = await tx.legiWatchRuleBillBaseline.findMany({
          where: { tenantId, ruleId: rule.id },
        });
        const newAssignments = ready.assignments.filter(
          (a) => !baselines.some((b) => b.assignmentId === a.id),
        );
        if (newAssignments.length)
          await tx.legiWatchRuleBillBaseline.createMany({
            data: newAssignments.map((a) => ({
              tenantId,
              ruleId: rule.id,
              assignmentId: a.id,
              baselineAt: now,
            })),
            skipDuplicates: true,
          });
        for (const bill of bills)
          for (const event of bill.events) {
            const folderIds = [
              ...new Set(
                ready.assignments
                  .filter(
                    (a) =>
                      a.billId === bill.id &&
                      baselines.some(
                        (b) =>
                          b.assignmentId === a.id && event.observedAt > b.baselineAt.toISOString(),
                      ),
                  )
                  .map((a) => a.folderId),
              ),
            ];
            if (!folderIds.length || event.observedAt > now.toISOString()) continue;
            const result = await tx.legiWatchRecordMatch.createMany({
              data: [
                {
                  tenantId,
                  ruleId: rule.id,
                  ruleVersion: rule.version,
                  eventKey: event.key,
                  evidence: json({
                    ...event,
                    billId: bill.id,
                    number: bill.number,
                    title: bill.title,
                    checkedAt: bill.sourceCheckedAt,
                  }),
                  folderIds,
                  firstObservedAt: new Date(event.observedAt),
                },
              ],
              skipDuplicates: true,
            });
            matches += result.count;
          }
      });
    }
    return { rules: rules.length, matches };
  }
  async enqueue(tenantId: string, now = new Date()) {
    const prisma = this.reports.folders.prisma;
    const matches = await prisma.withTenant(tenantId, (tx) =>
      tx.legiWatchRecordMatch.findMany({
        where: { tenantId, state: 'queued' },
        take: 1000,
        orderBy: { firstObservedAt: 'asc' },
      }),
    );
    for (const match of matches) {
      await prisma.withTenant(tenantId, async (tx) => {
        const rule = await tx.legiWatchRecordRule.findFirst({
          where: { tenantId, id: match.ruleId, state: 'active', version: match.ruleVersion },
        });
        if (!rule) {
          await tx.legiWatchRecordMatch.update({
            where: { id: match.id },
            data: { state: 'canceled' },
          });
          return;
        }
        const event = object(match.evidence),
          recipients = rule.recipients as unknown as RuleRecipient[];
        const day = rule.timezone ? localTime(match.firstObservedAt, rule.timezone).date : '';
        const due =
          rule.cadence === 'end_of_day'
            ? localOccurrence(day, rule.localMinutes!, rule.timezone!)
            : now;
        const matchedFolders = await tx.legiWatchFolder.findMany({
          where: { tenantId, id: { in: match.folderIds } },
          select: { id: true, clientId: true },
        });
        const scopes = [...new Set(matchedFolders.map((f) => f.clientId))];
        for (const clientId of scopes)
          for (const recipient of recipients)
            for (const channel of ['email', 'in_app'] as const) {
              const scopedFolderIds = matchedFolders
                .filter((f) => f.clientId === clientId)
                .map((f) => f.id);
              if (
                (channel === 'email' && !recipient.email) ||
                (channel === 'in_app' && !recipient.inApp)
              )
                continue;
              // Content contains published facts only, making overlap compatible.
              const intentKey = `record:${digest([match.eventKey, recipient.userId, channel, clientId, rule.cadence, day, rule.timezone, rule.localMinutes])}`;
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':' + intentKey},0))`;
              const existing = await tx.legiWatchDelivery.findFirst({
                where: { tenantId, intentKey },
              });
              if (existing) {
                const composition = object(existing.composition),
                  ruleRefs = Array.isArray(composition.ruleRefs) ? composition.ruleRefs : [];
                if (!ruleRefs.some((r) => object(r).id === rule.id))
                  await tx.legiWatchDelivery.update({
                    where: { id: existing.id },
                    data: {
                      composition: json({
                        ...composition,
                        ruleRefs: [
                          ...ruleRefs,
                          { id: rule.id, version: rule.version, folderIds: scopedFolderIds },
                        ],
                      }),
                    },
                  });
                continue;
              }
              const title = `${event.number}: ${event.kind === 'amendment' ? 'Published amendment' : 'Published action'}`;
              const appBase = (process.env.REPORT_APP_ORIGIN ?? 'https://os.capiro.ai').replace(
                /\/+$/,
                '',
              );
              const billLink = `${appBase}/bills/${encodeURIComponent(String(event.billId))}`;
              const folderLinks = scopedFolderIds
                .map((id) => `${appBase}/legiwatch?tab=bills&folder=${encodeURIComponent(id)}`)
                .join('\n');
              const content = `${event.date ?? 'Date unavailable'} — ${event.text}\nOriginal source: ${event.url ?? 'Unavailable'}\nBill in Capiro (authorized account required): ${billLink}\nMatched folders (authorized account required):\n${folderLinks}\nLast source check: ${event.checkedAt ?? 'Unknown'}`;
              const destination = await this.reports.folders.source.staffDestination(
                tenantId,
                recipient.userId,
              );
              await tx.legiWatchDelivery.create({
                data: {
                  tenantId,
                  intentKey,
                  kind: 'bill_record',
                  ownerClerkId: rule.ownerClerkId,
                  contentHash: digest([title, content]),
                  composition: json({
                    kind: 'bill_record',
                    eventKey: match.eventKey,
                    billId: event.billId,
                    clientId,
                    title,
                    content,
                    html: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(content).replace(/\n/g, '<br>')}</p>`,
                    ruleRefs: [{ id: rule.id, version: rule.version, folderIds: scopedFolderIds }],
                    cadence: rule.cadence,
                    timezone: rule.timezone,
                    localMinutes: rule.localMinutes,
                    localDay: day,
                  }),
                  recipients: {
                    create: [
                      {
                        destinationHash: digest(recipient.userId),
                        channel,
                        nextAttemptAt: due,
                        recipient: json({
                          userId: recipient.userId,
                          email: destination?.email ?? null,
                          role: 'to',
                        }),
                      },
                    ],
                  },
                },
              });
            }
        await tx.legiWatchRecordMatch.update({
          where: { id: match.id },
          data: { state: 'queued_delivery' },
        });
      });
    }
    return { processed: matches.length };
  }
}
