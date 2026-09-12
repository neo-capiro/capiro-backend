import { ForbiddenException, Injectable } from '@nestjs/common';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { AGENDA_ALERTS_FEATURE } from '../../feature-flags/feature-flag.service.js';
import { RecordRuleService, type RuleRecipient } from '../reports/record-rule.service.js';
import { ReportService } from '../reports/report.service.js';
import { digest, escapeHtml, json, object } from '../reports/report-domain.js';
import { localOccurrence, localTime } from '../reports/report-schedule.js';
import { isFolderAdmin } from '../folders/folder-tracker.service.js';

type Transition = {
  id: string;
  hearingId: string;
  revision: number;
  before: unknown;
  after: unknown;
  changedFields: string[];
  sourceUrl: string;
  observedAt: Date;
};
export function renderedAgenda(
  event: Record<string, unknown>,
  billIds: string[],
  folderIds: string[],
) {
  const before = object(event.before),
    after = object(event.after),
    timing = object(after.time);
  const app = (process.env.REPORT_APP_ORIGIN ?? 'https://os.capiro.ai').replace(/\/+$/, '');
  const title = `Agenda update: ${String(after.title ?? before.title ?? 'Committee meeting')}`;
  const content = `${String(after.status ?? 'unknown')} · ${String(timing.date ?? 'Date unconfirmed')} · ${String(timing.rawTime ?? 'Time unconfirmed')}\n${String(after.location ?? 'Room unconfirmed')}\nChanges: ${(Array.isArray(event.changedFields) ? event.changedFields : []).join(', ')}\n${billIds.map((id) => `${id}: ${app}/bills/${encodeURIComponent(id)}`).join('\n')}\nPublished source: ${String(event.sourceUrl)}\nOpen event: ${app}/legiwatch/hearings/${encodeURIComponent(String(event.hearingId))}\nMatched folders:\n${folderIds.map((id) => `${app}/legiwatch?tab=bills&folder=${encodeURIComponent(id)}`).join('\n')}`;
  const value = (facts: Record<string, unknown>, key: string): string => {
    if (key === 'time') {
      const t = object(facts.time);
      return [t.date, t.rawTime ?? 'Time unconfirmed', t.timezone].filter(Boolean).join(' · ');
    }
    if (key === 'agenda')
      return (
        (Array.isArray(facts.agenda) ? facts.agenda : [])
          .map(object)
          .map((a) => String(a.title ?? object(a.bill).id ?? a.kind))
          .join('; ') || 'No agenda items published'
      );
    if (key === 'documents')
      return (
        (Array.isArray(facts.documents) ? facts.documents : [])
          .map(object)
          .map((d) => String(d.title ?? d.kind ?? 'Document'))
          .join('; ') || 'No documents published'
      );
    return facts[key] == null ? 'Not assigned' : String(facts[key]);
  };
  const fields = (Array.isArray(event.changedFields) ? event.changedFields : []).map(String);
  const changes = fields
    .map((key) => `${key}: ${value(before, key)} → ${value(after, key)}`)
    .join('\n');
  const rendered = content.replace(
    `Changes: ${fields.join(', ')}`,
    `${changes}\nCalendar revision: ${String(event.revision)}`,
  );
  return {
    title,
    content: rendered,
    html: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(rendered).replace(/\n/g, '<br>')}</p>`,
  };
}
export function agendaBillIds(before: unknown, after: unknown): string[] {
  return [
    ...new Set(
      [before, after].flatMap((value) => {
        const facts = object(value);
        return (Array.isArray(facts.agenda) ? facts.agenda : []).flatMap((a) => {
          const id = object(object(a).bill).id;
          return typeof id === 'string' ? [id] : [];
        });
      }),
    ),
  ];
}
@Injectable()
export class AgendaRuleService extends RecordRuleService {
  protected readonly family = 'agenda' as const;
  constructor(reports: ReportService) {
    super(reports);
  }
  async readiness(ctx: WorkspaceTenantContext, id: string) {
    const ready = await super.readiness(ctx, id);
    if (ready.assignments.some((a) => a.jurisdiction === 'FL')) {
      const coverage = await this.reports.folders.prisma.$queryRawUnsafe<
        Array<{ chamber: string; status: string; attemptedAt: Date }>
      >(
        `SELECT DISTINCT ON(chamber) chamber,status,attempted_at AS "attemptedAt" FROM legislative_calendar_coverage WHERE jurisdiction='FL' AND to_date>=CURRENT_DATE ORDER BY chamber,attempted_at DESC`,
      );
      if (
        ['house', 'senate'].some(
          (chamber) =>
            !coverage.some(
              (c) =>
                c.chamber === chamber &&
                c.status === 'complete' &&
                Date.now() - c.attemptedAt.getTime() < 86400000,
            ),
        )
      )
        ready.issues.push('Both Florida chambers require a complete current calendar source check');
    }
    ready.ready = !ready.issues.length;
    const transitions = await this.reports.folders.prisma.$queryRawUnsafe<Transition[]>(
      `SELECT id,hearing_id AS "hearingId",revision,"before","after",changed_fields AS "changedFields",source_url AS "sourceUrl",observed_at AS "observedAt"
       FROM legislative_calendar_transition ORDER BY observed_at DESC,id DESC LIMIT 100`,
    );
    ready.examples = transitions
      .filter((e) =>
        agendaBillIds(e.before, e.after).some((id) =>
          ready.assignments.some((a) => a.billId === id),
        ),
      )
      .slice(0, 5)
      .map((e) => ({
        key: e.id,
        billId: agendaBillIds(e.before, e.after)[0]!,
        number: String(object(e.after).title ?? 'Committee meeting'),
        kind: 'agenda',
        sourceIdentity: e.hearingId,
        revisionHash: String(e.revision),
        date: String(object(object(e.after).time).date ?? ''),
        text: renderedAgenda(e, [], []).content,
        order: 0,
        observedAt: e.observedAt.toISOString(),
        url: e.sourceUrl,
      }));
    return ready;
  }
  async staged(ctx: WorkspaceTenantContext) {
    await this.authorize(ctx);
    if (!isFolderAdmin(ctx)) throw new ForbiddenException('RULE_PROMOTION_REQUIRES_ADMIN');
    return this.reports.folders.withActor(ctx, async (tx) => {
      const rows = await tx.legiWatchStagedConfiguration.findMany({
        where: { tenantId: ctx.tenantId, kind: 'alert', state: { not: 'excluded' } },
        orderBy: { sourceId: 'asc' },
      });
      return rows
        .filter((r) => object(r.payload).family === 'Tagged Bill Agenda')
        .map((r) => ({
          id: r.id,
          sourceId: r.sourceId,
          sourceAccount: r.sourceAccount,
          version: r.version,
          payload: r.payload,
        }));
    });
  }
  async detect(tenantId: string, now = new Date()) {
    if (!(await this.reports.flags.isEnabled(AGENDA_ALERTS_FEATURE, tenantId)))
      return { rules: 0, matches: 0 };
    const prisma = this.reports.folders.prisma;
    const rules = await prisma.withTenant(tenantId, (tx) =>
      tx.legiWatchRecordRule.findMany({ where: { tenantId, family: 'agenda', state: 'active' } }),
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
      if (!ready.ready || !rule.activatedAt) continue;
      let cursor: { observedAt: Date; id: string } | null = null;
      // Durable transition ids are the event keys. Keyset pages cannot truncate
      // a busy window, and a process restart safely repeats already matched ids.
      for (;;) {
        const transitions: Transition[] = await prisma.$queryRawUnsafe<Transition[]>(
          `SELECT id,hearing_id AS "hearingId",revision,"before","after",
          changed_fields AS "changedFields",source_url AS "sourceUrl",observed_at AS "observedAt"
          FROM legislative_calendar_transition WHERE observed_at>$1 AND observed_at<=$2
          AND ($3::timestamptz IS NULL OR (observed_at,id)>($3::timestamptz,$4::uuid))
          ORDER BY observed_at,id LIMIT 250`,
          rule.activatedAt,
          now,
          cursor?.observedAt ?? null,
          cursor?.id ?? null,
        );
        if (!transitions.length) break;
        for (const event of transitions) {
          const affected = agendaBillIds(event.before, event.after);
          if (!ready.assignments.some((a) => affected.includes(a.billId))) continue;
          await prisma.withTenant(tenantId, async (tx) => {
            await tx.$queryRaw`SELECT id FROM intel_legiwatch_record_rule WHERE tenant_id=${tenantId} AND id=${rule.id} FOR UPDATE`;
            if (
              !(await tx.legiWatchRecordRule.findFirst({
                where: { tenantId, id: rule.id, version: rule.version, state: 'active' },
              }))
            )
              return;
            const baselines = await tx.legiWatchRuleBillBaseline.findMany({
              where: { tenantId, ruleId: rule.id },
            });
            const added = ready.assignments.filter(
              (a) => !baselines.some((b) => b.assignmentId === a.id),
            );
            if (added.length)
              await tx.legiWatchRuleBillBaseline.createMany({
                data: added.map((a) => ({
                  tenantId,
                  ruleId: rule.id,
                  assignmentId: a.id,
                  baselineAt: now,
                })),
                skipDuplicates: true,
              });
            const assignments = ready.assignments.filter(
              (a) =>
                affected.includes(a.billId) &&
                baselines.some((b) => b.assignmentId === a.id && event.observedAt > b.baselineAt),
            );
            if (!assignments.length) return;
            const result = await tx.legiWatchRecordMatch.createMany({
              data: [
                {
                  tenantId,
                  ruleId: rule.id,
                  ruleVersion: rule.version,
                  eventKey: event.id,
                  evidence: json({
                    ...event,
                    billIds: [...new Set(assignments.map((a) => a.billId))],
                    memberships: assignments.map((a) => ({
                      billId: a.billId,
                      folderId: a.folderId,
                    })),
                  }),
                  folderIds: [...new Set(assignments.map((a) => a.folderId))],
                  firstObservedAt: event.observedAt,
                },
              ],
              skipDuplicates: true,
            });
            matches += result.count;
          });
        }
        const last = transitions.at(-1)!;
        cursor = { observedAt: last.observedAt, id: last.id };
      }
    }
    return { rules: rules.length, matches };
  }
  async enqueue(tenantId: string, now = new Date()) {
    if (!(await this.reports.flags.isEnabled(AGENDA_ALERTS_FEATURE, tenantId)))
      return { processed: 0 };
    const prisma = this.reports.folders.prisma;
    const ruleIds = await prisma.withTenant(tenantId, (tx) =>
      tx.legiWatchRecordRule.findMany({
        where: { tenantId, family: 'agenda' },
        select: { id: true },
      }),
    );
    const matches = await prisma.withTenant(tenantId, (tx) =>
      tx.legiWatchRecordMatch.findMany({
        where: { tenantId, state: 'queued', ruleId: { in: ruleIds.map((r) => r.id) } },
        take: 500,
        orderBy: { firstObservedAt: 'asc' },
      }),
    );
    for (const match of matches)
      await prisma.withTenant(tenantId, async (tx) => {
        const rule = await tx.legiWatchRecordRule.findFirst({
          where: {
            tenantId,
            id: match.ruleId,
            version: match.ruleVersion,
            state: 'active',
            family: 'agenda',
          },
        });
        if (!rule) {
          await tx.legiWatchRecordMatch.update({
            where: { id: match.id },
            data: { state: 'canceled' },
          });
          return;
        }
        const event = object(match.evidence),
          after = object(event.after),
          before = object(event.before),
          memberships = (Array.isArray(event.memberships) ? event.memberships : []).map(object);
        const folders = await tx.legiWatchFolder.findMany({
          where: { tenantId, id: { in: match.folderIds } },
          select: { id: true, clientId: true },
        });
        const day = rule.timezone ? localTime(match.firstObservedAt, rule.timezone).date : '';
        const due =
          rule.cadence === 'end_of_day'
            ? localOccurrence(day, rule.localMinutes!, rule.timezone!)
            : now;
        for (const clientId of new Set(folders.map((f) => f.clientId)))
          for (const recipient of rule.recipients as unknown as RuleRecipient[])
            for (const channel of ['email', 'in_app'] as const) {
              if (channel === 'email' ? !recipient.email : !recipient.inApp) continue;
              const folderIds = folders.filter((f) => f.clientId === clientId).map((f) => f.id);
              const billIds = [
                ...new Set(
                  memberships
                    .filter((m) => folderIds.includes(String(m.folderId)))
                    .map((m) => String(m.billId)),
                ),
              ];
              if (!billIds.length) continue;
              const intentKey = `agenda:${digest([
                match.eventKey,
                recipient.userId,
                channel,
                clientId,
                rule.cadence,
                ...(rule.cadence === 'end_of_day' ? [day, rule.timezone, rule.localMinutes] : []),
              ])}`;
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':' + intentKey},0))`;
              const existing = await tx.legiWatchDelivery.findFirst({
                where: { tenantId, intentKey },
              });
              const scopedMemberships = memberships
                .filter((m) => folderIds.includes(String(m.folderId)))
                .map((m) => ({ billId: String(m.billId), folderId: String(m.folderId) }));
              const reference = {
                id: rule.id,
                version: rule.version,
                folderIds,
                billIds,
                memberships: scopedMemberships,
              };
              if (existing) {
                await tx.$queryRaw`SELECT id FROM intel_legiwatch_delivery WHERE tenant_id=${tenantId} AND id=${existing.id} FOR UPDATE`;
                const started = await tx.legiWatchDeliveryRecipient.count({
                  where: { tenantId, deliveryId: existing.id, state: { not: 'queued' } },
                });
                if (started) continue;
                const composition = object(existing.composition),
                  refs = Array.isArray(composition.ruleRefs) ? composition.ruleRefs : [];
                if (!refs.some((r) => object(r).id === rule.id)) {
                  const allBills = [
                    ...new Set([
                      ...(Array.isArray(composition.billIds)
                        ? composition.billIds.map(String)
                        : []),
                      ...billIds,
                    ]),
                  ];
                  const allFolders = [
                    ...new Set([
                      ...(Array.isArray(composition.folderIds)
                        ? composition.folderIds.map(String)
                        : []),
                      ...folderIds,
                    ]),
                  ];
                  const scopeItems = [
                    ...(Array.isArray(composition.scopeItems) ? composition.scopeItems : []),
                    ...scopedMemberships,
                  ];
                  const rendered = renderedAgenda(event, allBills, allFolders);
                  await tx.legiWatchDelivery.update({
                    where: { id: existing.id },
                    data: {
                      contentHash: digest([rendered.title, rendered.content]),
                      composition: json({
                        ...composition,
                        ...rendered,
                        billIds: allBills,
                        folderIds: allFolders,
                        scopeItems,
                        ruleRefs: [...refs, reference],
                      }),
                    },
                  });
                }
                continue;
              }
              const { title, content, html } = renderedAgenda(event, billIds, folderIds);
              const destination = await this.reports.folders.source.staffDestination(
                tenantId,
                recipient.userId,
              );
              await tx.legiWatchDelivery.create({
                data: {
                  tenantId,
                  intentKey,
                  kind: 'agenda',
                  ownerClerkId: rule.ownerClerkId,
                  contentHash: digest([title, content]),
                  composition: json({
                    kind: 'agenda',
                    hearingId: event.hearingId,
                    revision: event.revision,
                    eventKey: match.eventKey,
                    billIds,
                    folderIds,
                    scopeItems: scopedMemberships,
                    billId: billIds[0],
                    clientId,
                    title,
                    content,
                    html,
                    ruleRefs: [reference],
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
    return { processed: matches.length };
  }
}
