import { evidenceDigest } from './editorial-domain.js';
import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  BRIEFING_TEMPLATES,
  PHASE8_ALERT_FAMILIES,
  briefingOccurrence,
  validateBriefingSchedule,
  PHASE8_FEATURES,
  type BriefingTemplate,
  type BriefingSchedule,
} from '@capiro/shared';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import { Phase8EvidenceService, phase8Scope, type SourceRow } from './evidence.service.js';
import { assertEditorialAccess } from './editorial-access.js';
import { object, digest, json, settings } from '../reports/report-domain.js';
import { requestKey, checkedVersion } from '../keywords/keyword-rule.service.js';
import { ReportRecipientsService } from '../reports/recipients.service.js';
import { ReportDeliveryService } from '../reports/report-delivery.service.js';
import { REPORT_DELIVERY_FEATURE } from '../../feature-flags/feature-flag.service.js';

@Injectable()
export class EditorialService {
  constructor(
    readonly evidence: Phase8EvidenceService,
    readonly recipients: ReportRecipientsService,
    readonly delivery: ReportDeliveryService,
  ) {}
  async save(ctx: WorkspaceTenantContext, input: unknown) {
    const id = await this.evidence.run(ctx, input, 'editorial', async (tx, b, scope) => {
      const key = requestKey(b.requestKey),
        template = String(b.template) as BriefingTemplate,
        cutoff = new Date(String(b.cutoff)),
        analysis = String(b.analysis ?? ''),
        title = String(b.title ?? BRIEFING_TEMPLATES[template] ?? '');
      if (
        !BRIEFING_TEMPLATES[template] ||
        !title ||
        title.length > 200 ||
        analysis.length > 30000 ||
        !Number.isFinite(cutoff.getTime()) ||
        cutoff.getTime() > Date.now() + 1000 ||
        !Array.isArray(b.sources) ||
        !b.sources.length ||
        b.sources.length > 50 ||
        !Array.isArray(b.citations) ||
        !b.citations.length ||
        b.citations.length > 150
      )
        throw new BadRequestException('BOUNDED_CITED_BRIEFING_REQUIRED');
      const timezone = String(b.timezone ?? '');
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(cutoff);
      } catch {
        throw new BadRequestException('TIMEZONE_REQUIRED');
      }
      const inputHash = evidenceDigest(b);
      if (Array.isArray(b.expectedProjectTracking)) {
        if (b.expectedProjectTracking.length > 100)
          throw new BadRequestException('BOUNDED_PROJECT_SCOPE_REQUIRED');
        for (const item of b.expectedProjectTracking) {
          const pin = object(item);
          const rows = await tx.$queryRaw<
            Array<{ version: number; removed: boolean }>
          >`SELECT version,removed FROM intel_legiwatch_evidence_tracking WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND folder_id=${scope.folderId} AND kind='budget' AND id=${String(pin.id)} FOR SHARE`;
          if (!rows[0] || rows[0].removed || rows[0].version !== pin.version)
            throw new ConflictException('SELECTED_PROJECT_TRACKING_CHANGED');
        }
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':editorial:' + key},0))`;
      const prior = await tx.$queryRaw<
        Array<{ id: string; input_hash: string }>
      >`SELECT id,input_hash FROM intel_legiwatch_editorial_selection WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND request_key=${key}`;
      if (prior[0]) {
        if (prior[0].input_hash !== inputHash)
          throw new ConflictException('BRIEFING_REQUEST_CHANGED');
        return prior[0].id;
      }
      const sources: Array<
        SourceRow & { kind: string; trackingId?: string; trackingVersion?: number }
      > = [];
      for (const item of b.sources) {
        const ref = object(item),
          kind = String(ref.kind),
          source = await this.evidence.exact(tx, kind, String(ref.id));
        if (source.revision !== ref.revision)
          throw new ConflictException('EXACT_SOURCE_REVISION_REQUIRED');
        if (Date.parse(source.observedAt) > cutoff.getTime())
          throw new BadRequestException('SOURCE_AFTER_KNOWLEDGE_CUTOFF');
        const tracking = scope.folderId
          ? await tx.$queryRaw<
              Array<{ id: string; version: number; removed: boolean }>
            >`SELECT id,version,removed FROM intel_legiwatch_evidence_tracking WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND folder_id=${scope.folderId} AND kind=${kind} AND source_id=${source.id}`
          : [];
        if (tracking[0]?.removed) throw new ConflictException('SOURCE_MANUALLY_REMOVED');
        const pins: Record<string, unknown> = {};
        if (ref.monitorId) {
          const monitor = await this.evidence.monitor(tx, ctx, String(ref.monitorId));
          await this.evidence.context(tx, ctx, phase8Scope(monitor.config));
          if (monitor.state !== 'active' || monitor.version !== ref.monitorVersion)
            throw new ConflictException('SELECTED_MONITOR_CHANGED');
          pins.monitorId = monitor.id;
          pins.monitorVersion = monitor.version;
        }
        if (kind === 'research' && scope.folderId) {
          const assignments = await tx.legiWatchFolderBill.findMany({
            where: {
              tenantId: ctx.tenantId,
              folderId: scope.folderId,
              billId: String(source.billId),
            },
          });
          if (assignments[0]) {
            pins.billAssignmentId = assignments[0].id;
            pins.billAssignmentVersion = assignments[0].version;
          }
        }
        if (kind === 'budget' && scope.folderId) {
          const tracked = await tx.$queryRaw<
            Array<{ id: string; version: number }>
          >`SELECT DISTINCT t.id,t.version FROM intel_legiwatch_evidence_tracking t JOIN florida_budget_amount a ON a.project_id=t.source_id WHERE t.tenant_id=${ctx.tenantId} AND t.owner_clerk_id=${ctx.clerkUserId} AND t.folder_id=${scope.folderId} AND t.kind='budget' AND NOT t.removed AND a.document_id=${source.id}`;
          pins.projectTracking = tracked;
        }
        sources.push({
          ...source,
          kind,
          ...pins,
          ...(tracking[0]
            ? { trackingId: tracking[0].id, trackingVersion: tracking[0].version }
            : {}),
        });
      }
      const citations: Array<Record<string, unknown>> = b.citations.map((item) => {
        const c = object(item),
          s = sources.find((s) => s.id === c.id && s.revision === c.revision && s.kind === c.kind);
        let sourceText = s?.text;
        const sections = Array.isArray(s?.sections) ? s.sections.map(object) : [];
        if (sections.length)
          sourceText = String(sections.find((x) => x.locator === c.locator)?.text ?? '');
        if (
          !s ||
          typeof c.quote !== 'string' ||
          !c.quote ||
          c.quote.length > 5000 ||
          !Number.isInteger(c.start) ||
          !Number.isInteger(c.end) ||
          Number(c.start) < 0 ||
          Number(c.end) <= Number(c.start) ||
          sourceText?.slice(Number(c.start), Number(c.end)) !== c.quote
        )
          throw new BadRequestException('CITATION_DOES_NOT_MATCH_EXACT_SOURCE');
        return { ...c, sourceUrl: s.sourceUrl, authority: s.authority };
      });
      for (const s of sources)
        if (!citations.some((c) => c.id === s.id && c.kind === s.kind))
          throw new BadRequestException('EACH_SELECTED_SOURCE_REQUIRES_CITATION');
      const contextVersion = await this.evidence.research.contextVersion(tx, ctx, scope),
        id = randomUUID();
      const gaps = sources
        .filter((s) => !s.complete)
        .map((s) => ({
          id: s.id,
          reason:
            s.kind === 'news' ? 'Available article fields only' : 'Incomplete source extraction',
        }));
      if (Array.isArray(b.coverageGaps))
        for (const gap of b.coverageGaps.slice(0, 50))
          gaps.push({ id: 'coverage', reason: String(gap).slice(0, 500) });
      const payload = {
        scope,
        title,
        template,
        templateVersion: 'capiro-editorial-v1',
        analysis,
        citations,
        sources: sources.map(({ text, body, sections, ...s }) => s),
        cutoff: cutoff.toISOString(),
        timezone,
        contextVersion,
        gaps,
        generationMode:
          b.generationMode === 'source_list'
            ? 'source_list'
            : b.generationMode === 'generated_analysis'
              ? 'generated_analysis'
              : 'authored_analysis',
        promptVersion: typeof b.promptVersion === 'string' ? b.promptVersion : null,
        authorId: ctx.clerkUserId,
        generatedAt: new Date().toISOString(),
      };
      await tx.$executeRaw`INSERT INTO intel_legiwatch_editorial_selection(id,tenant_id,owner_clerk_id,folder_id,client_id,request_key,input_hash,payload) VALUES(${id},${ctx.tenantId},${ctx.clerkUserId},${scope.folderId},${scope.clientId},${key},${inputHash},${JSON.stringify(payload)}::jsonb)`;
      return id;
    });
    return this.workspace(ctx, id);
  }
  async source(ctx: WorkspaceTenantContext, id: string) {
    return this.evidence.run(ctx, {}, 'editorial', async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ input_hash: string; payload: Record<string, unknown> }>
      >`SELECT input_hash,payload FROM intel_legiwatch_editorial_selection WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
      const row = rows[0];
      if (!row) throw new NotFoundException('BRIEFING_SELECTION_NOT_FOUND');
      const scope = phase8Scope(object(row.payload.scope));
      await this.evidence.context(tx, ctx, scope);
      const current = await this.evidence.research.contextVersion(tx, ctx, scope);
      let stale = current !== row.payload.contextVersion;
      try {
        await assertEditorialAccess(
          tx,
          ctx,
          {
            editorialReview: {
              selectionId: id,
              ownerId: ctx.clerkUserId,
              sourceHash: row.input_hash,
            },
          },
          (folderId) => this.evidence.reports.folders.folder(tx, ctx, folderId),
          true,
        );
      } catch (e) {
        if (e instanceof ConflictException) stale = true;
        else throw e;
      }
      return {
        actionId: id,
        stale,
        prefill: {
          draft: { docTitle: String(row.payload.title) },
          context: { ...row.payload, snapshotId: id, contentHash: row.input_hash } as Record<
            string,
            unknown
          >,
          sources: row.payload.sources as unknown[],
        },
      };
    });
  }
  async workspace(ctx: WorkspaceTenantContext, id: string) {
    await this.source(ctx, id);
    const base = process.env.WORKSPACE_BASE_URL,
      secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!base || !secret)
      return { selectionId: id, state: 'saved', draftState: 'workspace_not_configured' };
    const response = await fetch(
      base.replace(/\/+$/, '') + '/workspace-api/internal/legiwatch/editorial',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-service-secret': secret },
        body: JSON.stringify({ tenantId: ctx.tenantId, ownerId: ctx.clerkUserId, actionId: id }),
        signal: AbortSignal.timeout(25000),
        redirect: 'error',
      },
    );
    if (!response.ok)
      throw new ServiceUnavailableException({
        code: 'BRIEFING_DRAFT_HELD_RETRY_SAME_REQUEST',
        selectionId: id,
      });
    return { selectionId: id, draft: await response.json() };
  }
  async preview(ctx: WorkspaceTenantContext, input: unknown) {
    const b = object(input),
      id = String(b.selectionId),
      source = await this.source(ctx, id);
    if (source.stale) throw new ConflictException('BRIEFING_SOURCE_STALE');
    const scope = phase8Scope(object(source.prefill.context.scope)),
      report = await this.evidence.reports.folders.withActor(ctx, async (tx) => {
        const r = await this.evidence.reports.get(tx, ctx, String(b.reportId), true);
        if (!scope.folderId || r.folderIds.length !== 1 || r.folderIds[0] !== scope.folderId)
          throw new BadRequestException('EXPLICIT_BRIEFING_REPORT_SCOPE_REQUIRED');
        return r;
      });
    if (!['internal', 'external'].includes(String(b.audience)))
      throw new BadRequestException('EXPLICIT_AUDIENCE_REQUIRED');
    const base = process.env.WORKSPACE_BASE_URL,
      secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!base || !secret) throw new ServiceUnavailableException('WORKSPACE_NOT_CONFIGURED');
    const response = await fetch(
      `${base.replace(/\/+$/, '')}/workspace-api/internal/legiwatch/editorial/${encodeURIComponent(id)}/output?${new URLSearchParams({ tenantId: ctx.tenantId, ownerId: ctx.clerkUserId })}`,
      {
        headers: { 'x-internal-service-secret': secret },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    );
    if (!response.ok) {
      const failure = object(await response.json().catch(() => ({})));
      if (failure.message === 'EDITORIAL_MEDIA_REQUIRES_DOCUMENT_EXPORT')
        throw new BadRequestException(
          'This edition contains inserted images. Export it from Workspace, or remove the images before reviewing a report.',
        );
      throw new ServiceUnavailableException('EDITED_BRIEFING_UNAVAILABLE');
    }
    const output = object(await response.json());
    if (
      output.selectionId !== id ||
      typeof output.text !== 'string' ||
      !output.text ||
      output.text.length > 200000 ||
      typeof output.html !== 'string' ||
      !output.html ||
      output.html.length > 1_000_000 ||
      output.rendererVersion !== 'workspace-editorial-html-v1' ||
      !/^[a-f0-9]{64}$/.test(String(output.outputHash))
    )
      throw new BadRequestException('EXACT_EDITED_OUTPUT_REQUIRED');
    const audience = String(b.audience),
      review = {
        selectionId: id,
        ownerId: ctx.clerkUserId,
        sourceHash: source.prefill.context.contentHash,
        contextVersion: source.prefill.context.contextVersion,
        outputHash: output.outputHash,
        draftId: output.draftId,
        outputSnapshot: output.snapshot,
        sources: source.prefill.sources,
        scope,
        cutoff: source.prefill.context.cutoff,
        template: source.prefill.context.template,
        gaps: source.prefill.context.gaps,
        gapDistributionAccepted: b.acceptSourceGaps === true,
        generationMode: source.prefill.context.generationMode,
      };
    if (
      audience === 'external' &&
      Array.isArray(review.gaps) &&
      review.gaps.length &&
      b.acceptSourceGaps !== true
    )
      throw new BadRequestException('REVIEW_SOURCE_GAPS_FOR_DISTRIBUTION');
    const rendered = {
      html: output.html,
      text: output.text,
    };
    return {
      reportId: report.id,
      definitionVersion: report.version,
      audience,
      review,
      rendered,
      approvalHash: digest({
        reportId: report.id,
        version: report.version,
        audience,
        review,
        rendered,
      }),
      deliveryState:
        audience === 'internal' ? 'internal_review_only' : 'requires_distribution_approval',
    };
  }
  async approve(ctx: WorkspaceTenantContext, input: unknown) {
    const b = object(input),
      preview = await this.preview(ctx, input);
    if (b.approvalHash !== preview.approvalHash)
      throw new ConflictException('BRIEFING_PREVIEW_CHANGED');
    return this.evidence.run(ctx, {}, 'editorial', async (tx) => {
      const report = await this.evidence.reports.get(tx, ctx, preview.reportId, true);
      if (report.version !== preview.definitionVersion)
        throw new ConflictException('REPORT_CHANGED');
      const key = 'editorial-review:' + preview.approvalHash;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + key},0))`;
      const prior = await tx.legiWatchReportRun.findUnique({
        where: { tenantId_generationKey: { tenantId: ctx.tenantId, generationKey: key } },
      });
      if (prior) return { runId: prior.id, replayed: true };
      const snapshot = {
        mode: 'editorial_brief',
        name: String(object(preview.review.outputSnapshot).title ?? ''),
        reportId: report.id,
        definitionVersion: report.version,
        audience: preview.audience,
        rows: [],
        complete: true,
        issues: [],
        settings: settings({}),
        selectionHash: 'editorial',
        editorialReview: preview.review,
        cutoff: preview.review.cutoff,
      };
      const run = await tx.legiWatchReportRun.create({
        data: {
          tenantId: ctx.tenantId,
          reportId: report.id,
          definitionVersion: report.version,
          createdBy: ctx.clerkUserId,
          audience: preview.audience,
          cutoff: String(preview.review.cutoff),
          snapshot: json(snapshot),
          rendered: json(preview.rendered),
          contentHash: digest({ snapshot, rendered: preview.rendered }),
          complete: true,
          generationKey: key,
        },
      });
      return { runId: run.id, replayed: false, deliveryState: preview.deliveryState };
    });
  }
  async configurations(ctx: WorkspaceTenantContext) {
    const configurations = await this.evidence.run(ctx, {}, 'editorial', async (tx) => {
      const rows = await tx.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT * FROM intel_legiwatch_editorial_config WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} ORDER BY source_key`;
      const allowed = [];
      for (const row of rows) {
        try {
          await this.evidence.context(tx, ctx, phase8Scope(object(row.config)));
          const editions = await tx.$queryRaw<Array<{ selection_id: string }>>`
            SELECT selection_id FROM intel_legiwatch_editorial_occurrence
            WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}
              AND config_id=${String(row.id)} AND selection_id IS NOT NULL
            ORDER BY created_at DESC,id DESC LIMIT 1`;
          allowed.push({
            ...row,
            approvalHash: digest(row.config),
            latestSelectionId: editions[0]?.selection_id ?? null,
          });
        } catch (e) {
          if (!(e instanceof NotFoundException || e instanceof ForbiddenException)) throw e;
        }
      }
      return allowed;
    });
    const lookup = await this.lookupDrafts(
      ctx,
      configurations.map((r) => r.latestSelectionId).filter((id): id is string => !!id),
    );
    return {
      configurations: configurations.map((r) => ({
        ...r,
        latestEdition: lookup.drafts.find((d) => d.selectionId === r.latestSelectionId) ?? null,
      })),
      draftLookupState: lookup.state,
    };
  }
  private async lookupDrafts(ctx: WorkspaceTenantContext, selectionIds: string[]) {
    const drafts: Array<{
      selectionId: string;
      draftId: string;
      title: string;
      updatedAt?: string;
    }> = [];
    if (!selectionIds.length) return { state: 'available', drafts };
    const base = process.env.WORKSPACE_BASE_URL,
      secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!base || !secret) return { state: 'unavailable', drafts };
    try {
      const response = await fetch(
        `${base.replace(/\/+$/, '')}/workspace-api/internal/legiwatch/editorial/lookup`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-service-secret': secret },
          body: JSON.stringify({ tenantId: ctx.tenantId, ownerId: ctx.clerkUserId, selectionIds }),
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        },
      );
      if (!response.ok) return { state: 'unavailable', drafts };
      const result = object(await response.json());
      for (const raw of Array.isArray(result.drafts) ? result.drafts : []) {
        const d = object(raw);
        if (
          selectionIds.includes(String(d.selectionId)) &&
          /^[a-f0-9-]{36}$/i.test(String(d.draftId)) &&
          typeof d.title === 'string'
        )
          drafts.push({
            selectionId: String(d.selectionId),
            draftId: String(d.draftId),
            title: d.title,
            updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : undefined,
          });
      }
      return { state: 'available', drafts };
    } catch {
      return { state: 'unavailable', drafts };
    }
  }
  async history(ctx: WorkspaceTenantContext, input: unknown, configurationId?: string) {
    const b = object(input),
      limit = Math.max(1, Math.min(50, Number(b.limit) || 20));
    if (!Number.isInteger(limit)) throw new BadRequestException('INVALID_HISTORY_LIMIT');
    let before: string | null = null,
      beforeId: string | null = null;
    if (b.cursor) {
      try {
        if (typeof b.cursor !== 'string' || b.cursor.length > 1000) throw Error();
        const c = object(JSON.parse(Buffer.from(String(b.cursor), 'base64url').toString()));
        if (typeof c.at !== 'string' || typeof c.id !== 'string') throw Error();
        // Preserve PostgreSQL sub-millisecond precision in the continuation.
        before = c.at;
        beforeId = c.id;
        if (!Number.isFinite(Date.parse(before)) || !beforeId || beforeId.length > 200)
          throw Error();
      } catch {
        throw new BadRequestException('INVALID_HISTORY_CURSOR');
      }
    }
    const page = await this.evidence.run(ctx, b, 'editorial', async (tx, _b, scope) => {
      if (configurationId) {
        const configs = await tx.$queryRaw<Array<{ config: Record<string, unknown> }>>`
          SELECT config FROM intel_legiwatch_editorial_config WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${configurationId}`;
        if (!configs[0]) throw new NotFoundException('CONFIGURATION_NOT_FOUND');
        await this.evidence.context(tx, ctx, phase8Scope(configs[0].config));
      }
      const rows = configurationId
        ? await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id,selection_id AS "selectionId",definition_version AS "definitionVersion",state,
          created_at AS "createdAt",created_at::text AS "cursorAt",occurrence_key AS "occurrenceKey",payload->>'reason' AS reason
        FROM intel_legiwatch_editorial_occurrence
        WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND config_id=${configurationId}
          AND (${before}::timestamptz IS NULL OR (created_at,id)<(${before}::timestamptz,${beforeId}))
        ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`
        : await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT s.id,s.id AS "selectionId",s.created_at AS "createdAt",s.created_at::text AS "cursorAt",s.payload->>'title' AS title,
          s.payload->>'template' AS template,s.payload->>'cutoff' AS cutoff,'prepared' AS state
        FROM intel_legiwatch_editorial_selection s
        WHERE s.tenant_id=${ctx.tenantId} AND s.owner_clerk_id=${ctx.clerkUserId}
          AND s.client_id IS NOT DISTINCT FROM ${scope.clientId} AND (${scope.folderId}::text IS NULL OR s.folder_id=${scope.folderId})
          AND (${before}::timestamptz IS NULL OR (s.created_at,s.id)<(${before}::timestamptz,${beforeId}))
        ORDER BY s.created_at DESC,s.id DESC LIMIT ${limit + 1}`;
      const scanned = rows.slice(0, limit),
        items: Array<Record<string, unknown>> = [];
      for (const row of scanned) {
        if (row.selectionId) {
          try {
            // Recheck the original scope; a moved/deleted folder must not leak edition metadata.
            const selection = await tx.$queryRaw<
              Array<{ payload: Record<string, unknown> }>
            >`SELECT payload FROM intel_legiwatch_editorial_selection WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${String(row.selectionId)}`;
            if (!selection[0]) continue;
            const selectionScope = phase8Scope(object(selection[0].payload.scope));
            await this.evidence.context(tx, ctx, selectionScope);
            Object.assign(row, selectionScope, {
              title: selection[0].payload.title,
              template: selection[0].payload.template,
              cutoff: selection[0].payload.cutoff,
            });
          } catch (e) {
            if (e instanceof NotFoundException || e instanceof ForbiddenException) continue;
            throw e;
          }
        }
        items.push(row);
      }
      const last = scanned[scanned.length - 1];
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({ at: last.cursorAt ?? last.createdAt, id: last.id }),
              ).toString('base64url')
            : null,
      };
    });
    const lookup = await this.lookupDrafts(
      ctx,
      page.items.map((r) => String(r.selectionId ?? '')).filter(Boolean),
    );
    return {
      ...page,
      items: page.items.map((r) => ({
        ...r,
        draft: lookup.drafts.find((d) => d.selectionId === r.selectionId) ?? null,
      })),
      draftLookupState: lookup.state,
    };
  }
  async configure(ctx: WorkspaceTenantContext, id: string, input: unknown) {
    return this.evidence.run(ctx, input, 'editorial', async (tx, b) => {
      const rows = await tx.$queryRaw<
        Array<{ source: Record<string, unknown>; config: Record<string, unknown>; version: number }>
      >`SELECT source,config,version FROM intel_legiwatch_editorial_config WHERE id=${id} AND tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}`;
      if (!rows[0]) throw new NotFoundException('CONFIGURATION_NOT_FOUND');
      await this.evidence.context(tx, ctx, phase8Scope(rows[0].config), true);
      const config = object(b.config),
        scope = phase8Scope(config);
      await this.evidence.context(tx, ctx, scope, true);
      const template = String(config.template) as BriefingTemplate;
      if (
        !BRIEFING_TEMPLATES[template] ||
        !scope.folderId ||
        !Array.isArray(config.monitorIds) ||
        config.monitorIds.length > 38
      )
        throw new BadRequestException('EXPLICIT_TEMPLATE_FOLDER_AND_MONITORS_REQUIRED');
      const schedule = validateBriefingSchedule(
        object(config.schedule) as unknown as BriefingSchedule,
      );
      for (const monitorId of config.monitorIds) {
        const monitor = await this.evidence.monitor(tx, ctx, String(monitorId));
        await this.evidence.context(tx, ctx, phase8Scope(monitor.config));
        if (monitor.config.clientId !== scope.clientId)
          throw new BadRequestException('MONITOR_CLIENT_SCOPE_MISMATCH');
      }
      const report = await this.evidence.reports.get(tx, ctx, String(config.reportId), true);
      if (report.folderIds.length !== 1 || report.folderIds[0] !== scope.folderId)
        throw new BadRequestException('REPORT_FOLDER_SCOPE_MISMATCH');
      const family = object(rows[0].source.family),
        categoryIds = Array.isArray(family.categories) ? family.categories.map(String) : [];
      const mapping = object(config.categoryMapping),
        entries = object(mapping.entries);
      if (
        categoryIds.length &&
        (mapping.namespace !== family.categoryNamespace || mapping.version !== 1)
      )
        throw new BadRequestException('EXACT_CATEGORY_NAMESPACE_REQUIRED');
      for (const id of categoryIds) {
        const entry = object(entries[id]);
        if (
          !['included', 'excluded', 'pending'].includes(String(entry.decision)) ||
          typeof entry.reason !== 'string' ||
          !entry.reason.trim()
        )
          throw new BadRequestException('EVERY_SOURCE_CATEGORY_REQUIRES_DECISION');
        if (config.prepareEnabled === true && entry.decision === 'pending')
          throw new BadRequestException('CATEGORY_MAPPING_PENDING');
      }
      const includedKinds = Array.isArray(config.includedKinds)
        ? config.includedKinds.map(String)
        : [];
      if (
        !includedKinds.length ||
        includedKinds.some((k) => !['news', 'budget', 'personnel', 'research'].includes(k))
      )
        throw new BadRequestException('EXPLICIT_SOURCE_KINDS_REQUIRED');
      const recipients =
        config.sendEnabled === true
          ? await this.recipients.resolve(tx, ctx, config.recipientSelection)
          : [];
      if (config.sendEnabled === true && (!recipients.length || schedule.mode !== 'send'))
        throw new BadRequestException('REVIEW_RECIPIENTS_AND_SEND_MODE');
      const normalized = {
        ...scope,
        template,
        schedule,
        reportId: report.id,
        reportVersion: report.version,
        monitorIds: config.monitorIds.map(String),
        subject: String(config.subject ?? BRIEFING_TEMPLATES[template]).slice(0, 200),
        recipients,
        prepareEnabled: config.prepareEnabled === true,
        sendEnabled: config.sendEnabled === true,
        categoryMapping: mapping,
        includedKinds,
        recipientSelection: config.recipientSelection ?? {},
        dictionaryScopeAccepted: config.dictionaryScopeAccepted === true,
        acceptAvailableFields: config.acceptAvailableFields === true,
      };
      if (/[\r\n]/.test(normalized.subject))
        throw new BadRequestException('SUBJECT_ONE_LINE_REQUIRED');
      const saved =
        await tx.$queryRaw`UPDATE intel_legiwatch_editorial_config SET config=${JSON.stringify(normalized)}::jsonb,version=version+1,state='paused',standing_approval=NULL,last_held_reason='Settings changed; review activation' WHERE id=${id} AND tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND version=${checkedVersion(b.expectedVersion)} RETURNING *`;
      if (!(saved as unknown[]).length) throw new ConflictException('CONFIGURATION_CHANGED');
      return saved;
    });
  }
  async activation(ctx: WorkspaceTenantContext, id: string, input: unknown) {
    return this.evidence.run(ctx, input, 'editorial', async (tx, b) => {
      const rows = await tx.$queryRaw<
        Array<{ source: Record<string, unknown>; config: Record<string, unknown>; version: number }>
      >`SELECT source,config,version FROM intel_legiwatch_editorial_config WHERE id=${id} AND tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}`;
      const row = rows[0];
      if (!row) throw new NotFoundException('CONFIGURATION_NOT_FOUND');
      await this.evidence.context(tx, ctx, phase8Scope(row.config), true);
      if (typeof b.enabled !== 'boolean' || row.version !== checkedVersion(b.expectedVersion))
        throw new ConflictException('EXACT_ACTIVATION_REQUIRED');
      const configHash = digest(row.config);
      if (b.enabled && (!row.config.prepareEnabled || !row.config.dictionaryScopeAccepted))
        throw new BadRequestException('REVIEW_PREPARATION_AND_DICTIONARY_SCOPE');
      if (b.enabled && row.config.sendEnabled) {
        if (!(await this.evidence.reports.flags.isEnabled(REPORT_DELIVERY_FEATURE, ctx.tenantId)))
          throw new ForbiddenException('REPORT_DELIVERY_DISABLED');
        if (b.approvalHash !== configHash)
          throw new ConflictException('EXACT_STANDING_APPROVAL_REQUIRED');
        for (const r of row.config.recipients as Parameters<
          ReportRecipientsService['recheck']
        >[2][])
          await this.recipients.recheck(tx, ctx, r);
      }
      await tx.$executeRaw`UPDATE intel_legiwatch_editorial_config SET state=${b.enabled ? 'active' : 'paused'},standing_approval=${JSON.stringify(b.enabled && row.config.sendEnabled ? { configHash, version: row.version, actor: ctx.clerkUserId, approvedAt: new Date().toISOString() } : null)}::jsonb,last_held_reason=NULL WHERE id=${id} AND version=${row.version}`;
      return {
        id,
        state: b.enabled ? 'active' : 'paused',
        version: row.version,
        approvalHash: configHash,
      };
    });
  }
}
