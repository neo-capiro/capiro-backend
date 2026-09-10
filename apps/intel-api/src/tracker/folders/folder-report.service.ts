import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { FolderImportService } from './folder-import.service.js';
import { FolderTrackerService } from './folder-tracker.service.js';

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** Preview only. No scheduler, delivery or public-share integration. */
@Injectable()
export class FolderReportService {
  constructor(
    private readonly folders: FolderTrackerService,
    private readonly imports: FolderImportService,
  ) {}

  async preview(ctx: WorkspaceTenantContext, runId: string, reportSourceId: string, asOf: string) {
    this.imports.assertAdmin(ctx);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
      !Number.isFinite(Date.parse(asOf)) ||
      new Date(asOf).toISOString().slice(0, 10) !== asOf
    )
      throw new BadRequestException('VALID_AS_OF_DATE_REQUIRED');
    const from = new Date(asOf);
    from.setUTCDate(from.getUTCDate() - 4);
    const fromDate = from.toISOString().slice(0, 10);
    return this.folders.withActor(ctx, async (tx) => {
      const report = await tx.legiWatchImportItem.findFirst({
        where: { tenantId: ctx.tenantId, runId, kind: 'report', sourceId: reportSourceId },
      });
      if (!report || report.status === 'excluded') throw new NotFoundException('REPORT_NOT_FOUND');
      const definition = record(record(report.payload).raw);
      if (
        definition.committee_references !== 'Off:' ||
        definition.actions !== 'Last 5 Days Actions:' ||
        definition.related_bills !== 'Off:' ||
        definition.show_summary !== true ||
        definition.order !== 'Last action date' ||
        definition.bill_link_access !== 'Only LobbyTools subscribers can view bill links' ||
        !Array.isArray(definition.other_checked_flags) ||
        definition.other_checked_flags.length
      ) {
        throw new BadRequestException('REPORT_SETTINGS_NOT_SUPPORTED_BY_PHASE1_PREVIEW');
      }
      const folderIds = Array.isArray(definition.folder_ids)
        ? definition.folder_ids.map(String)
        : [];
      if (!folderIds.length || folderIds.length > 25)
        throw new BadRequestException('REPORT_FOLDER_SELECTION_REQUIRED');
      const items = await tx.legiWatchImportItem.findMany({
        where: { tenantId: ctx.tenantId, runId, kind: 'assignment' },
        take: 10000,
      });
      const selected = items.filter((i) => {
        const raw = record(record(i.payload).raw);
        return folderIds.includes(String(raw.folder_id)) && raw.session === definition.session;
      });
      if (selected.length > 2000)
        throw new BadRequestException('REPORT_PREVIEW_LIMIT_2000_ASSIGNMENTS');
      const ids = [
        ...new Set(
          selected
            .map((i) => record(record(i.payload).resolved).billId)
            .filter((id): id is string => typeof id === 'string'),
        ),
      ];
      const bills = await this.folders.source.bills(ids);
      const source = ids.length
        ? await tx.$queryRaw<
            Array<{ id: string; summary: string | null; lastAction: Date | null }>
          >`
        SELECT b.id,b.description AS summary,(SELECT max(a.date) FROM state_bill_action a WHERE a.bill_key=b.id AND a.date<=${asOf}::date) AS "lastAction"
        FROM state_bill b WHERE b.id=ANY(${ids}::text[])`
        : [];
      const actions = ids.length
        ? await tx.$queryRaw<Array<{ billId: string; date: Date; text: string }>>`
        SELECT bill_key AS "billId",date,text FROM state_bill_action WHERE bill_key=ANY(${ids}::text[])
        AND date BETWEEN ${fromDate}::date AND ${asOf}::date ORDER BY date DESC,order_key DESC,id`
        : [];
      const exceptions: Array<{ sourceId: string; reason: string }> = [];
      const capturedCounts = Array.isArray(definition.captured_folder_counts)
        ? definition.captured_folder_counts.map(record)
        : [];
      let expectedAssignments = 0;
      for (const folderId of folderIds) {
        const captured = capturedCounts.find(
          (c) => c.folder_id === folderId && c.session === definition.session,
        );
        if (!captured || !Number.isSafeInteger(captured.count) || Number(captured.count) < 0) {
          exceptions.push({
            sourceId: folderId,
            reason: 'Captured folder/session count unavailable',
          });
          continue;
        }
        const expected = Number(captured.count);
        expectedAssignments += expected;
        const actual = selected.filter(
          (i) => record(record(i.payload).raw).folder_id === folderId,
        ).length;
        if (actual !== expected)
          exceptions.push({
            sourceId: folderId,
            reason: `Captured ${expected} assignments; import contains ${actual}`,
          });
      }
      const rows = selected
        .flatMap((item) => {
          const payload = record(item.payload),
            raw = record(payload.raw),
            resolved = record(payload.resolved);
          const b = bills.find((b) => b.id === resolved.billId);
          if (!b) {
            exceptions.push({
              sourceId: item.sourceId,
              reason: 'Canonical bill unresolved; preview is incomplete',
            });
            return [];
          }
          const extra = source.find((s) => s.id === b.id);
          if (!extra?.summary?.trim() || !extra.lastAction)
            exceptions.push({
              sourceId: item.sourceId,
              reason: 'Source summary or action history through the cutoff is unavailable',
            });
          // Report observations stay distinct from the editable folder comments.
          const comment =
            typeof raw.report_bill_comments === 'string' &&
            raw.report_bill_comments !== 'No comments.'
              ? raw.report_bill_comments
              : null;
          return [
            {
              id: b.id,
              number: b.number,
              title: b.title,
              sponsor: b.sponsor,
              currentPublicStatus: b.status,
              folderSourceId: String(raw.folder_id),
              folderName: String(raw.folder_name ?? ''),
              sourceUrl: b.sourceUrl,
              summary: extra?.summary ?? null,
              lastActionAt: extra?.lastAction?.toISOString().slice(0, 10) ?? null,
              actions: actions
                .filter((a) => a.billId === b.id)
                .map((a) => ({ date: a.date.toISOString().slice(0, 10), text: a.text })),
              reportCommentObservation: comment,
              reportCommentScope: raw.report_bill_comments_scope ?? null,
            },
          ];
        })
        .sort(
          (a, b) =>
            (b.lastActionAt ?? '').localeCompare(a.lastActionAt ?? '') ||
            a.number.localeCompare(b.number, undefined, { numeric: true }) ||
            a.id.localeCompare(b.id),
        );
      return {
        name: String(definition.name ?? 'Saved report'),
        reportSourceId,
        definition,
        asOf,
        fromDate,
        dateSemantics:
          'Legislative date-only values; inclusive five-calendar-day action window. No audit timestamp timezone is inferred.',
        linkAccess: 'Authenticated Capiro preview; original source links. No public report share.',
        expectedAssignments,
        rows,
        exceptions,
        complete: exceptions.length === 0 && rows.length === expectedAssignments,
        deliveryActivated: false,
        internalCommentsIncluded: false,
      };
    });
  }
}
