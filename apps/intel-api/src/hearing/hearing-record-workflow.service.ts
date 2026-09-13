import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { ReportService } from '../tracker/reports/report.service.js';
import { digest, object, text } from '../tracker/reports/report-domain.js';
import {
  PUBLISHED_RECORDS_FEATURE,
  RECORD_BRIEFS_FEATURE,
} from '../feature-flags/feature-flag.service.js';
import { HearingRecordsRepository } from '../sourcedata/hearing-records.repository.js';
import { HearingCryptoService, type EncryptedText } from './hearing-crypto.service.js';
import { HearingPublicationService } from './hearing-publication.service.js';
import {
  assessRecordClaim,
  sourcePassage,
  validateRecordClaims,
  type RecordClaim,
  type PublishedRecord,
  type RecordAssessment,
  type RecordSourceSelection,
} from './published-record-domain.js';
import { OrchestratorClient } from './orchestrator.client.js';
import { ClientBriefContextClient } from './client-brief-context.client.js';
import type { PublishedRecordToolInput, PublishedRecordToolResult } from '@capiro/meriv2-core';
type SourceObservation = {
  sessionId: string;
  publicationId: string;
  hash: string;
  clientId: string | null;
};
type Correction = {
  priorKind: 'brief' | 'publication';
  priorId: string;
  sessionId?: string;
  priorHash: string;
  priorCreatedAt: string;
  items: Array<{
    priorClaimId: string;
    priorText: string;
    classification: 'wrong_then' | 'later_change' | 'still_supported' | 'uncertain';
    claimIds: string[];
    rationale: string;
  }>;
};
type RunPayload = {
  schema: 'legiwatch.record-reconciliation.v1';
  event: Awaited<ReturnType<HearingRecordsRepository['event']>>;
  records: PublishedRecord[];
  sourceHash: string;
  claims: RecordClaim[];
  originalClaims: RecordClaim[];
  observation: SourceObservation | null;
  cutoff: string;
  coverage: unknown[];
  sourceSelections: RecordSourceSelection[];
};
type RunRow = { id: string; input_hash: string; payload: unknown; created_at: Date };
type WorkLease = { id: string; token: string; resultId: string | null };
@Injectable()
export class HearingRecordWorkflowService {
  constructor(
    readonly reports: ReportService,
    readonly source: HearingRecordsRepository,
    readonly crypto: HearingCryptoService,
    readonly publications: HearingPublicationService,
    readonly orchestrator: OrchestratorClient,
    readonly clientContext: ClientBriefContextClient,
  ) {}
  async authorize(ctx: WorkspaceTenantContext, feature = PUBLISHED_RECORDS_FEATURE) {
    await this.reports.authorize(ctx, feature);
  }
  actor<T>(ctx: WorkspaceTenantContext, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.reports.folders.withActor(ctx, fn);
  }
  encode(value: unknown) {
    return JSON.stringify(this.crypto.encrypt(JSON.stringify(value)));
  }
  decode<T>(value: unknown): T {
    return JSON.parse(this.crypto.decrypt(value as EncryptedText));
  }
  async sourceBoundary(tx: Prisma.TransactionClient, ctx: WorkspaceTenantContext, eventId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('legiwatch-published-record-commit-v1',0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.clerkUserId + ':record-event:' + eventId},0))`;
  }
  async lockContext(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    clientId: string | null,
    folders: Array<{ id: string; version: number; clientId: string | null }> = [],
  ) {
    const members = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT u.id::text AS id FROM tenant_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.tenant_id=${ctx.tenantId}::uuid AND u.clerk_user_id=${ctx.clerkUserId} AND m.status::text='active' FOR SHARE OF m`;
    if (!members[0]) throw new ForbiddenException('ACTIVE_MEMBERSHIP_REQUIRED');
    await tx.$executeRaw`SELECT set_config('app.current_user',${members[0].id},true)`;
    if (clientId) {
      const clients = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT c.id FROM clients c WHERE c.id=${clientId}::uuid AND c.tenant_id=${ctx.tenantId}::uuid
        AND c.status::text<>'archived' AND (NOT c.memory_wall OR EXISTS(SELECT 1 FROM client_memory_access a WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=${members[0].id}::uuid)) FOR SHARE`;
      if (!clients[0]) throw new NotFoundException('BRIEF_CLIENT_UNAVAILABLE');
      await tx.$queryRaw`SELECT id FROM client_memory_access WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid AND user_id=${members[0].id}::uuid FOR SHARE`;
    }
    for (const ref of folders) {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_folder WHERE tenant_id=${ctx.tenantId} AND id=${ref.id} FOR SHARE`;
      const f = await this.reports.folders.folder(tx, ctx, ref.id);
      if (f.archived || f.version !== ref.version || f.clientId !== ref.clientId)
        throw new ConflictException('BRIEF_CONTEXT_CHANGED');
    }
  }
  async claimJob(
    ctx: WorkspaceTenantContext,
    eventId: string,
    kind: string,
    inputHash: string,
    input: unknown,
  ): Promise<WorkLease> {
    return this.actor(ctx, async (tx) => {
      await tx.$executeRaw`INSERT INTO intel_hearing_record_job(id,tenant_id,owner_clerk_id,event_id,kind,input_hash,payload)
        VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${eventId},${kind},${inputHash},${this.encode(input)}::jsonb) ON CONFLICT DO NOTHING`;
      const rows = await tx.$queryRaw<
        Array<{ id: string; state: string; result_id: string | null }>
      >`SELECT id,state,result_id FROM intel_hearing_record_job
        WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND kind=${kind} AND input_hash=${inputHash} FOR UPDATE`;
      const row = rows[0]!,
        token = randomUUID();
      if (row.state === 'complete') return { id: row.id, token, resultId: row.result_id };
      const claimed =
        await tx.$executeRaw`UPDATE intel_hearing_record_job SET state='running',lease_token=${token},lease_until=clock_timestamp()+interval '3 minutes',attempts=attempts+1,updated_at=now()
        WHERE id=${row.id} AND next_attempt_at<=clock_timestamp() AND (state IN ('pending','failed') OR (state='running' AND lease_until<clock_timestamp()))`;
      if (claimed !== 1)
        throw new ConflictException({ code: 'RECORD_JOB_PENDING_OR_BACKOFF', jobId: row.id });
      return { id: row.id, token, resultId: null };
    });
  }
  async renewJob(ctx: WorkspaceTenantContext, lease: WorkLease) {
    const n = await this.actor(
      ctx,
      (
        tx,
      ) => tx.$executeRaw`UPDATE intel_hearing_record_job SET lease_until=clock_timestamp()+interval '3 minutes',updated_at=now()
      WHERE id=${lease.id} AND state='running' AND lease_token=${lease.token} AND lease_until>clock_timestamp()`,
    );
    if (n !== 1) throw new ConflictException('RECORD_WORK_LEASE_EXPIRED');
  }
  async completeJob(tx: Prisma.TransactionClient, lease: WorkLease, resultId: string) {
    const n =
      await tx.$executeRaw`UPDATE intel_hearing_record_job SET state='complete',result_id=${resultId},lease_until=NULL,error_code=NULL,updated_at=now()
      WHERE id=${lease.id} AND state='running' AND lease_token=${lease.token} AND lease_until>clock_timestamp()`;
    if (n !== 1) throw new ConflictException('RECORD_WORK_LEASE_EXPIRED');
  }
  async failJob(ctx: WorkspaceTenantContext, lease: WorkLease) {
    await this.actor(
      ctx,
      (
        tx,
      ) => tx.$executeRaw`UPDATE intel_hearing_record_job SET state='failed',lease_until=NULL,error_code='RECORD_GENERATION_REQUIRES_RETRY',
      next_attempt_at=now()+least(interval '1 day',interval '3 minutes'*power(2,least(attempts,8))),updated_at=now()
      WHERE id=${lease.id} AND lease_token=${lease.token} AND state='running'`,
    );
  }
  async maintain(ctx: WorkspaceTenantContext) {
    await this.authorize(ctx);
    let completed = 0,
      failed = 0;
    const jobs = await this.actor(
      ctx,
      (tx) => tx.$queryRaw<
        Array<{ id: string; event_id: string; kind: string; payload: unknown }>
      >`SELECT id,event_id,kind,payload FROM intel_hearing_record_job
      WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND attempts<5 AND next_attempt_at<=now()
        AND (state IN ('pending','failed') OR (state='running' AND lease_until<now())) ORDER BY next_attempt_at,id LIMIT 2`,
    );
    for (const job of jobs) {
      try {
        const payload = this.decode<{ input: unknown; runId?: string }>(job.payload);
        if (job.kind === 'brief')
          await this.generateBrief(ctx, job.event_id, payload.runId!, payload.input);
        else await this.reconcile(ctx, job.event_id, payload.input);
        completed++;
      } catch {
        failed++;
      }
    }
    const latest = await this.actor(ctx, async (tx) => {
      await tx.$executeRaw`INSERT INTO intel_hearing_record_scan_cursor(tenant_id,owner_clerk_id)
        VALUES(${ctx.tenantId},${ctx.clerkUserId}) ON CONFLICT DO NOTHING`;
      const cursor = await tx.$queryRaw<Array<{ last_event_id: string }>>`SELECT last_event_id FROM intel_hearing_record_scan_cursor
        WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} FOR UPDATE`;
      const rows = await tx.$queryRaw<
        Array<{ id: string; event_id: string; payload: unknown }>
      >`WITH latest AS (SELECT DISTINCT ON(event_id) id,event_id,payload FROM intel_hearing_record_run
      WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND created_at>now()-interval '30 days' ORDER BY event_id,created_at DESC,id DESC)
      SELECT * FROM latest ORDER BY (event_id<=${cursor[0]!.last_event_id}),event_id LIMIT 5`;
      await tx.$executeRaw`UPDATE intel_hearing_record_scan_cursor SET last_event_id=${rows.at(-1)?.event_id ?? ''},updated_at=clock_timestamp()
        WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}`;
      return rows;
    });
    for (const row of latest) {
      try {
        const prior = this.decode<RunPayload>(row.payload),
          records = await this.source.snapshot(row.event_id, prior.sourceSelections),
          event = await this.source.event(row.event_id);
        if (
          prior.sourceHash === digest([event, records.map((r) => [r.id, r.hash, r.evidence.sourceObservationId??null, r.evidence.currentSourceVersion??null])]) ||
          records.some((r) => Date.now() - Date.parse(String(r.evidence.sourceLastChangedAt??r.observedAt)) < 120000)
        )
          continue;
        // Debounce committed public updates. The frozen old run remains readable;
        // generating the replacement never grants approval or enqueues messages.
        await this.reconcile(ctx, row.event_id, {
          sourceSelections: prior.sourceSelections,
          ...(prior.observation
            ? {
                sessionId: prior.observation.sessionId,
                publicationId: prior.observation.publicationId,
              }
            : { claims: prior.claims }),
        });
        completed++;
      } catch {
        failed++;
      }
    }
    return { completed, failed };
  }
  async history(ctx: WorkspaceTenantContext, eventId: string, offset = 0) {
    await this.authorize(ctx);
    await this.source.event(eventId);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new BadRequestException('INVALID_HISTORY_PAGE');
    const page = await this.actor(ctx, async (tx) => ({
      runs: await tx.$queryRaw<
        Array<{ id: string; inputHash: string; createdAt: Date }>
      >`SELECT id,input_hash AS "inputHash",created_at AS "createdAt" FROM intel_hearing_record_run
        WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND event_id=${eventId} ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ${offset}`,
      briefs: await tx.$queryRaw<
        Array<{
          id: string;
          seriesId: string;
          version: number;
          contentHash: string;
          supersedesId: string | null;
          createdAt: Date;
        }>
      >`SELECT id,series_id AS "seriesId",version,content_hash AS "contentHash",supersedes_id AS "supersedesId",created_at AS "createdAt"
        FROM intel_hearing_record_brief WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND event_id=${eventId} ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ${offset}`,
      jobs: await tx.$queryRaw<
        Array<{
          id: string;
          kind: string;
          state: string;
          resultId: string | null;
          nextAttemptAt: Date;
          attempts: number;
          errorCode: string | null;
        }>
      >`SELECT id,kind,state,result_id AS "resultId",next_attempt_at AS "nextAttemptAt",attempts,error_code AS "errorCode"
        FROM intel_hearing_record_job WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND event_id=${eventId} ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ${offset}`,
      offset,
      pageSize: 50,
    }));
    return {
      ...page,
      runs: page.runs.slice(0, 50),
      briefs: page.briefs.slice(0, 50),
      jobs: page.jobs.slice(0, 50),
      next: [page.runs, page.briefs, page.jobs].some((rows) => rows.length > 50)
        ? offset + 50
        : null,
    };
  }
  async listRecords(ctx: WorkspaceTenantContext, eventId: string, offset = 0) {
    await this.authorize(ctx);
    const page = await this.source.page(eventId, offset);
    return {
      ...page,
      checks: await this.source.checks(eventId),
      scope:
        'Published records for exact agenda bills; bill context alone does not establish hearing occurrence.',
      missing: [
        'Hearing minutes and vote coverage depend on the publisher. Missing records do not establish that no action occurred.',
      ],
    };
  }
  async billContext(
    ctx: WorkspaceTenantContext,
    billId: string,
    clientId?: string,
    folderId?: string,
  ) {
    await this.authorize(ctx);
    if (clientId) await this.actor(ctx, (tx) => this.lockContext(tx, ctx, clientId));
    if (folderId)
      await this.actor(ctx, async (tx) => {
        const f = await this.reports.folders.folder(tx, ctx, folderId);
        if (f.archived || f.clientId !== (clientId ?? null))
          throw new ForbiddenException('FOLDER_CLIENT_SCOPE_MISMATCH');
      });
    const events = await this.source.prisma.$queryRaw<
      Array<{ id: string; title: string }>
    >`SELECT DISTINCT h.id,h.title FROM committee_hearing h JOIN legislative_agenda_item a ON a.hearing_id=h.id
      WHERE h.visibility='public' AND a.active AND a.state_bill_key=${text(billId, 200)} ORDER BY h.id LIMIT 51`;
    const rows = await this.actor(
      ctx,
      (tx) => tx.$queryRaw<
        Array<{ id: string; event_id: string }>
      >`SELECT id,event_id FROM intel_hearing_record_brief WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}
      AND event_id=ANY(${events.slice(0, 50).map((e) => e.id)}::text[]) AND client_id IS NOT DISTINCT FROM ${clientId ?? null}::text ORDER BY created_at DESC,id DESC LIMIT 51`,
    );
    const briefs = [];
    for (const row of rows.slice(0, 50)) {
      try {
        const b = await this.brief(ctx, row.event_id, row.id);
        if (
          b.current &&
          b.approvedAt &&
          (!folderId || b.payload.folders.some((f) => f.id === folderId))
        )
          briefs.push({
            id: b.id,
            eventId: row.event_id,
            title: b.payload.title,
            version: b.version,
            contentHash: b.contentHash,
          });
      } catch {}
    }
    return {
      events: events.slice(0, 50),
      briefs,
      complete: events.length <= 50 && rows.length <= 50,
    };
  }
  async refreshRecords(ctx: WorkspaceTenantContext, eventId: string) {
    await this.authorize(ctx);
    await this.source.event(eventId);
    const secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!secret) throw new ConflictException('PUBLISHED_RECORD_REFRESH_OWNER_UNAVAILABLE');
    const response = await fetch(
      (process.env.API_BASE_URL ?? 'https://app.capiro.ai').replace(/\/+$/, '') +
        '/api/internal/legiwatch/published-record-refresh',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-service-secret': secret },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
        body: JSON.stringify({ tenantId: ctx.tenantId, actor: ctx.clerkUserId, eventId }),
      },
    );
    if (!response.ok) throw new ConflictException('PUBLISHED_RECORD_REFRESH_OWNER_UNAVAILABLE');
    return response.json();
  }
  async evidence(ctx: WorkspaceTenantContext, eventId: string, id: string, locator?: string) {
    await this.authorize(ctx);
    const record = await this.source.record(eventId, id);
    if (!record) throw new NotFoundException();
    const chunks = this.chunks([record], false);
    const passages = chunks.flat();
    if (locator) {
      const passage = sourcePassage(record, locator);
      if (passage === null) throw new NotFoundException('RECORD_LOCATOR_NOT_FOUND');
      return {
        record: {
          ...record,
          evidence: {
            ...record.evidence,
            sections: undefined,
            text: undefined,
            members: undefined,
          },
        },
        locators: passages.map((p) => ({ locator: p.locator, characters: p.text.length })),
        locator,
        text: passage,
      };
    }
    return {
      record: {
        ...record,
        evidence: { ...record.evidence, sections: undefined, text: undefined, members: undefined },
      },
      locators: passages.map((p) => ({ locator: p.locator, characters: p.text.length })),
      locator: passages[0]?.locator ?? null,
      text: passages[0]?.text ?? null,
    };
  }
  chunks(records: PublishedRecord[], bounded = true) {
    const items: PublishedRecordToolInput['records'] = [];
    for (const r of records) {
      const add = (locator: string) => {
        const value = sourcePassage(r, locator);
        if (value?.trim())
          items.push({
            id: r.id,
            hash: r.hash,
            locator,
            text: value,
            billId: r.billId,
            association: r.association,
            currentSourceVersion: r.evidence.currentSourceVersion === true,
            publishedDate: r.date,
            observedAt: r.observedAt,
            ...(r.kind === 'amendment' ? { amendmentDisposition: r.evidence.adopted === true ? 'adopted' as const : r.evidence.adopted === false ? 'not_marked_adopted' as const : 'unknown' as const } : {}),
          });
      };
      if (r.evidence.selectedPassages)
        for (const locator of Object.keys(object(r.evidence.selectedPassages))) add(locator);
      else if (r.kind === 'document')
        for (const section of Array.isArray(r.evidence.sections)
          ? r.evidence.sections.map(object)
          : []) {
          const text = String(section.text ?? '');
          if (text.length <= 20000) add(String(section.locator));
          else
            for (let start = 0; start < text.length; start += 12000)
              add(`${section.locator}#characters:${start}-${Math.min(start + 12000, text.length)}`);
        }
      else if (r.kind === 'official_transcript') {
        const value = String(r.evidence.text ?? '');
        for (let start = 0; start < value.length; start += 12000)
          add(`characters:${start}-${Math.min(start + 12000, value.length)}`);
      } else {
        add('record');
        if (r.kind === 'vote')
          for (const m of Array.isArray(r.evidence.members) ? r.evidence.members.map(object) : [])
            add(`member:${m.providerPersonId}`);
      }
    }
    const chunks: Array<PublishedRecordToolInput['records']> = [];
    let current: PublishedRecordToolInput['records'] = [],
      size = 0;
    for (const item of items) {
      if (item.text.length > 20000)
        throw new BadRequestException('SOURCE_SECTION_REQUIRES_SMALLER_LOCATORS');
      const n = JSON.stringify(item).length;
      if (current.length >= 200 || size + n > 170000) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(item);
      size += n;
    }
    if (current.length) chunks.push(current);
    if (bounded && chunks.length > 20)
      throw new BadRequestException('NARROW_DOCUMENT_SCOPE_REQUIRED');
    return chunks;
  }
  async generateBrief(ctx: WorkspaceTenantContext, eventId: string, runId: string, input: unknown) {
    await this.authorize(ctx, RECORD_BRIEFS_FEATURE);
    const body = object(input),
      run = await this.run(ctx, eventId, runId);
    if (!run.current) throw new ConflictException('SOURCE_CHANGED_START_NEW_RECONCILIATION');
    const selectedIds =
      body.claimIds == null
        ? null
        : Array.isArray(body.claimIds)
          ? body.claimIds.map((v) => text(v, 100))
          : [];
    if (
      selectedIds &&
      (!selectedIds.length ||
        selectedIds.length > 100 ||
        new Set(selectedIds).size !== selectedIds.length ||
        selectedIds.some((id) => !run.payload.claims.some((c) => c.id === id)))
    )
      throw new BadRequestException('BRIEF_REQUIRES_REVIEWED_CLAIM_SELECTION');
    const observations = selectedIds
      ? run.payload.claims.filter((c) => selectedIds.includes(c.id))
      : run.payload.claims;
    if (observations.length > 100)
      throw new BadRequestException('BRIEF_REQUIRES_REVIEWED_CLAIM_SELECTION');
    const clientId = body.clientId ? text(body.clientId, 100) : null;
    if (run.payload.observation && run.payload.observation.clientId !== clientId)
      throw new ForbiddenException('OBSERVATION_CLIENT_SCOPE_MISMATCH');
    if (clientId)
      await this.reports.folders.validateReferences(ctx, {
        name: 'Published-record brief',
        clientId,
      });
    await this.actor(ctx, (tx) => this.lockContext(tx, ctx, clientId));
    const folderIds = Array.isArray(body.folderIds) ? body.folderIds.map((v) => text(v, 100)) : [];
    if (folderIds.length > 20) throw new BadRequestException('MAX_20_PUBLICATION_FOLDERS');
    const folders = await this.actor(ctx, async (tx) => {
      const out = [];
      for (const id of folderIds) {
        const f = await this.reports.folders.folder(tx, ctx, id);
        if (f.archived || f.clientId !== clientId)
          throw new BadRequestException('CLIENT_FOLDER_SCOPE_MISMATCH');
        out.push({ id: f.id, version: f.version, clientId: f.clientId, name: f.name });
      }
      return out;
    });
    const context = clientId
      ? await this.clientContext.fetch({ tenantId: ctx.tenantId, clientId, hearingId: eventId })
      : null;
    const generationHash = digest([
      run.inputHash,
      clientId,
      folders,
      context,
      selectedIds,
      'published-record-brief-v1',
    ]);
    const existing = await this.actor(
      ctx,
      (tx) =>
        tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM intel_hearing_record_brief WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND event_id=${eventId} AND payload->>'generationHash'=${generationHash} LIMIT 1`,
    );
    if (existing[0]) return this.brief(ctx, eventId, existing[0].id);
    const lease = await this.claimJob(ctx, eventId, 'brief', generationHash, { runId, input });
    if (lease.resultId) return this.brief(ctx, eventId, lease.resultId);
    try {
      const chunks = this.chunks(run.payload.records);
      if (!chunks.length) throw new BadRequestException('PUBLISHED_CONTENT_UNAVAILABLE');
      const generated: PublishedRecordToolResult['claims'] = [];
      for (let i = 0; i < chunks.length; i++) {
        const result = await this.orchestrator.publishedRecords(
          ctx.tenantId,
          ctx.clerkUserId,
          {
            mode: 'brief',
            eventId,
            title: run.payload.event.title,
            sourceSnapshotHash: run.payload.sourceHash,
            records: chunks[i]!,
            observations: observations.map((c) => ({ id: c.id, text: c.text })),
            maxClaims: Math.max(1, Math.floor(100 / chunks.length)),
            clientContext: JSON.stringify({ context, folders }),
            coverage: `Source chunk ${i + 1} of ${chunks.length}. ${JSON.stringify(run.payload.coverage).slice(0, 6000)}`,
          },
          clientId ?? undefined,
        );
        generated.push(...result.claims.map((c) => ({ ...c, id: `${i + 1}:${c.id}` })));
        await this.renewJob(ctx, lease);
      }
      if (generated.length > 100)
        throw new BadRequestException('BRIEF_REQUIRES_REVIEWED_CLAIM_SELECTION');
      validateRecordClaims(generated, run.payload.records, true);
      const payload = {
        schema: 'legiwatch.published-record-brief.v1',
        label: 'Brief based on published records',
        author: 'Capiro',
        title: `Capiro hearing brief — ${run.payload.event.title}`.slice(0, 200),
        eventId,
        runId,
        clientId,
        folders,
        sourceHash: run.payload.sourceHash,
        cutoff: run.payload.cutoff,
        claims: generated,
        records: run.payload.records,
        observation: run.payload.observation,
        coverage: run.payload.coverage,
        selectedObservationIds: selectedIds,
        provenance: {
          promptVersion: 'published-record-brief-v1',
          clientContext: context ? 'applied' : clientId ? 'unavailable' : 'none',
        },
      };
      const contentHash = digest(payload),
        id = randomUUID();
      const contextKey = digest([clientId, folders.map((f) => f.id).sort()]);
      await this.actor(ctx, async (tx) => {
        await this.sourceBoundary(tx, ctx, eventId);
        await this.lockContext(tx, ctx, clientId, folders);
        if (!(await this.run(ctx, eventId, runId)).current)
          throw new ConflictException('SOURCE_CHANGED_DURING_GENERATION');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.clerkUserId + ':' + eventId + ':' + clientId},0))`;
        const previous = await tx.$queryRaw<
          Array<{ id: string; series_id: string; version: number }>
        >`SELECT id,series_id,version FROM intel_hearing_record_brief
        WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND event_id=${eventId} AND payload->>'contextKey'=${contextKey} ORDER BY created_at DESC,id DESC LIMIT 1`;
        const prior = previous[0],
          series = prior?.series_id ?? randomUUID();
        await tx.$executeRaw`INSERT INTO intel_hearing_record_brief(id,tenant_id,owner_clerk_id,event_id,run_id,series_id,version,supersedes_id,client_id,content_hash,payload)
        VALUES(${id},${ctx.tenantId},${ctx.clerkUserId},${eventId},${runId},${series},${(prior?.version ?? 0) + 1},${prior?.id ?? null},${clientId},${contentHash},
          ${JSON.stringify({ ...this.crypto.encrypt(JSON.stringify(payload)), generationHash, contextKey })}::jsonb)`;
        await this.completeJob(tx, lease, id);
      });
      return this.brief(ctx, eventId, id);
    } catch (error) {
      await this.failJob(ctx, lease);
      throw error;
    }
  }
  async brief(ctx: WorkspaceTenantContext, eventId: string, id: string) {
    await this.authorize(ctx, RECORD_BRIEFS_FEATURE);
    const row = await this.actor(
      ctx,
      async (tx) =>
        (
          await tx.$queryRaw<
            Array<{
              id: string;
              run_id: string;
              series_id: string;
              version: number;
              client_id: string | null;
              content_hash: string;
              payload: unknown;
              created_at: Date;
            }>
          >`
      SELECT * FROM intel_hearing_record_brief WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND event_id=${eventId} AND id=${id}`
        )[0],
    );
    if (!row) throw new NotFoundException();
    if (row.client_id)
      await this.reports.folders.validateReferences(ctx, {
        name: 'Published-record brief',
        clientId: row.client_id,
      });
    const payload = this.decode<{
      schema: string;
      title: string;
      sourceHash: string;
      clientId: string | null;
      claims: Array<RecordClaim & { section: string; outcome: string }>;
      records: PublishedRecord[];
      cutoff: string;
      selectedObservationIds?: string[];
      folders: Array<{ id: string; version: number; clientId: string | null }>;
      coverage: unknown[];
      observation?: SourceObservation | null;
      correction?: Correction;
    }>(row.payload);
    await this.actor(ctx, (tx) => this.lockContext(tx, ctx, row.client_id, payload.folders));
    if (digest(payload) !== row.content_hash)
      throw new ConflictException('BRIEF_CONTENT_INTEGRITY_FAILED');
    const run = await this.run(ctx, eventId, row.run_id);
    const state = await this.actor(ctx, async (tx) => {
      const latest = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM intel_hearing_record_brief WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND series_id=${row.series_id} ORDER BY version DESC LIMIT 1`;
      const reviews = await tx.$queryRaw<
        Array<{ created_at: Date }>
      >`SELECT created_at FROM intel_hearing_record_brief_review WHERE tenant_id=${ctx.tenantId} AND brief_id=${id} AND content_hash=${row.content_hash} AND source_hash=${payload.sourceHash} ORDER BY created_at DESC LIMIT 1`;
      return {
        current: run.current && latest[0]?.id === id,
        approvedAt: reviews[0]?.created_at ?? null,
      };
    });
    return {
      id,
      seriesId: row.series_id,
      version: row.version,
      createdAt: row.created_at,
      contentHash: row.content_hash,
      payload,
      ...state,
      status: !state.current ? 'superseded' : state.approvedAt ? 'reviewed' : 'draft',
    };
  }
  async correctionSource(ctx: WorkspaceTenantContext, eventId: string, input: unknown) {
    const b = object(input),
      priorId = text(b.priorId, 100);
    if (b.priorKind === 'brief') {
      const prior = await this.brief(ctx, eventId, priorId);
      return {
        priorId,
        priorKind: 'brief' as const,
        priorHash: prior.contentHash,
        priorCreatedAt: prior.createdAt.toISOString(),
        clientId: prior.payload.clientId,
        claims: prior.payload.claims,
      };
    }
    if (b.priorKind === 'publication') {
      const sessionId = text(b.sessionId, 100),
        prior = await this.publications.retainedVersion(ctx, sessionId, priorId);
      if (prior.payload.hearingId !== eventId)
        throw new BadRequestException('CORRECTION_EVENT_MISMATCH');
      return {
        priorId,
        priorKind: 'publication' as const,
        sessionId,
        priorHash: prior.contentHash,
        priorCreatedAt: prior.createdAt.toISOString(),
        clientId: prior.payload.clientId,
        claims: prior.payload.claims,
      };
    }
    throw new BadRequestException('EXACT_CORRECTION_SOURCE_REQUIRED');
  }
  async correction(
    ctx: WorkspaceTenantContext,
    eventId: string,
    previous: Awaited<ReturnType<HearingRecordWorkflowService['brief']>>,
    claims: RecordClaim[],
    input: unknown,
  ): Promise<Correction> {
    const b = object(input),
      prior = await this.correctionSource(ctx, eventId, b);
    if (
      prior.priorId === previous.id ||
      prior.clientId !== previous.payload.clientId ||
      Date.parse(prior.priorCreatedAt) > previous.createdAt.getTime() ||
      b.priorHash !== prior.priorHash ||
      b.attestChronology !== true
    )
      throw new BadRequestException('CORRECTION_VERSION_CLIENT_AND_CHRONOLOGY_REVIEW_REQUIRED');
    const items = (Array.isArray(b.items) ? b.items : []).map((value) => {
      const item = object(value),
        priorClaimId = text(item.priorClaimId, 100),
        claim = prior.claims.find((c) => c.id === priorClaimId);
      const classification = text(
          item.classification,
          30,
        ) as Correction['items'][number]['classification'],
        claimIds = Array.isArray(item.claimIds) ? item.claimIds.map((id) => text(id, 100)) : [];
      if (
        !claim ||
        !['wrong_then', 'later_change', 'still_supported', 'uncertain'].includes(classification) ||
        claimIds.some((id) => !claims.some((c) => c.id === id)) ||
        (!claimIds.length && classification !== 'uncertain')
      )
        throw new BadRequestException('CORRECTION_CLAIM_MAPPING_REQUIRED');
      return {
        priorClaimId,
        priorText: claim.text,
        classification,
        claimIds,
        rationale: text(item.rationale, 4000),
      };
    });
    if (
      !items.length ||
      items.length > 100 ||
      new Set(items.map((i) => i.priorClaimId)).size !== items.length
    )
      throw new BadRequestException('BOUNDED_UNIQUE_CORRECTION_CLAIMS_REQUIRED');
    return {
      priorKind: prior.priorKind,
      priorId: prior.priorId,
      priorHash: prior.priorHash,
      priorCreatedAt: prior.priorCreatedAt,
      ...('sessionId' in prior ? { sessionId: prior.sessionId } : {}),
      items,
    };
  }
  async lockObservation(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    observation?: SourceObservation | null,
    distribution = false,
  ) {
    if (!observation) return;
    const prior = await this.publications.retainedVersion(
      ctx,
      observation.sessionId,
      observation.publicationId,
    );
    await this.publications.lockRetainedObservation(
      tx,
      ctx,
      observation.sessionId,
      prior.createdAt,
      distribution,
    );
    if (!prior.evidenceCurrent || prior.contentHash !== observation.hash)
      throw new ConflictException('OBSERVATION_EVIDENCE_CHANGED');
    const ids = prior.payload.evidence.map((e) => e.segmentId);
    await tx.$queryRaw`SELECT id FROM intel_transcript_segment WHERE tenant_id=${ctx.tenantId} AND session_id=${observation.sessionId} AND id=ANY(${ids}::text[]) FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM public_hearing_transcript_segment WHERE id::text=ANY(${ids}::text[]) FOR SHARE`;
    if (
      !(
        await this.publications.retainedVersion(
          ctx,
          observation.sessionId,
          observation.publicationId,
        )
      ).evidenceCurrent
    )
      throw new ConflictException('OBSERVATION_EVIDENCE_CHANGED');
  }
  async approveBrief(ctx: WorkspaceTenantContext, eventId: string, id: string, input: unknown) {
    const brief = await this.brief(ctx, eventId, id),
      body = object(input);
    if (!brief.current || brief.contentHash !== body.contentHash || body.attestSupported !== true)
      throw new ConflictException('REVIEW_CURRENT_EXACT_BRIEF_REQUIRED');
    validateRecordClaims(brief.payload.claims, brief.payload.records);
    if (brief.payload.claims.some((c) => c.kind !== 'analysis' && c.outcome !== 'supported'))
      throw new BadRequestException('UNRESOLVED_ASSERTION_MUST_BE_REVIEWED_OR_OMITTED');
    if (
      brief.payload.claims.some(
        (c) =>
          c.kind !== 'analysis' &&
          c.scope === 'hearing_event' &&
          c.references.some(
            (ref) =>
              brief.payload.records.find((r) => r.id === ref.id)?.association !== 'explicit_event',
          ),
      )
    )
      throw new BadRequestException('HEARING_EVENT_ASSOCIATION_REQUIRED');
    await this.actor(ctx, async (tx) => {
      await this.sourceBoundary(tx, ctx, eventId);
      await this.lockContext(tx, ctx, brief.payload.clientId, brief.payload.folders);
      await this.lockObservation(tx, ctx, brief.payload.observation);
      if (!(await this.brief(ctx, eventId, id)).current)
        throw new ConflictException('BRIEF_CHANGED_DURING_REVIEW');
      await tx.$executeRaw`INSERT INTO intel_hearing_record_brief_review(id,tenant_id,owner_clerk_id,brief_id,content_hash,source_hash,payload)
      VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${id},${brief.contentHash},${brief.payload.sourceHash},${this.encode({ reviewer: ctx.clerkUserId, attestSupported: true })}::jsonb) ON CONFLICT DO NOTHING`;
    });
    return this.brief(ctx, eventId, id);
  }
  async editBrief(ctx: WorkspaceTenantContext, eventId: string, id: string, input: unknown) {
    const previous = await this.brief(ctx, eventId, id),
      body = object(input);
    if (previous.contentHash !== body.contentHash || !previous.current)
      throw new ConflictException('EDIT_CURRENT_EXACT_BRIEF_REQUIRED');
    const claims = Array.isArray(body.claims)
      ? (body.claims as Array<
          RecordClaim & { section: string; outcome: string; rationale: string }
        >)
      : [];
    validateRecordClaims(claims, previous.payload.records, true);
    for (const c of claims)
      if (
        !['developments', 'changes', 'implications', 'next_steps', 'missing'].includes(c.section) ||
        ![
          'supported',
          'partially_supported',
          'contradicted',
          'not_addressed',
          'pending_records',
          'needs_review',
          'capiro_analysis',
        ].includes(c.outcome) ||
        !c.rationale?.trim() ||
        c.rationale.length > 4000
      )
        throw new BadRequestException('CLAIM_SECTION_AND_REVIEW_RATIONALE_REQUIRED');
    const correction = body.correction
      ? await this.correction(ctx, eventId, previous, claims, body.correction)
      : previous.payload.correction;
    if (
      correction &&
      correction.items.some((i) => i.claimIds.some((id) => !claims.some((c) => c.id === id)))
    )
      throw new BadRequestException('CORRECTION_MAPPING_CHANGED_REVIEW_AGAIN');
    const rationale = text(body.rationale, 4000),
      payload = {
        ...previous.payload,
        claims,
        ...(correction ? { correction } : {}),
        edit: { actor: ctx.clerkUserId, rationale, previousId: id },
      },
      contentHash = digest(payload),
      newId = randomUUID();
    await this.actor(ctx, async (tx) => {
      await this.sourceBoundary(tx, ctx, eventId);
      await this.lockContext(tx, ctx, previous.payload.clientId, previous.payload.folders);
      const current = await this.brief(ctx, eventId, id);
      if (!current.current) throw new ConflictException('BRIEF_CHANGED_DURING_EDIT');
      const rows = await tx.$queryRaw<
        Array<{ run_id: string; payload: Record<string, unknown> }>
      >`SELECT run_id,payload FROM intel_hearing_record_brief WHERE id=${id} AND tenant_id=${ctx.tenantId}`;
      const original = rows[0]!;
      await tx.$executeRaw`INSERT INTO intel_hearing_record_brief(id,tenant_id,owner_clerk_id,event_id,run_id,series_id,version,supersedes_id,client_id,content_hash,payload)
        VALUES(${newId},${ctx.tenantId},${ctx.clerkUserId},${eventId},${original.run_id},${previous.seriesId},${previous.version + 1},${id},${previous.payload.clientId},${contentHash},
          ${JSON.stringify({ ...this.crypto.encrypt(JSON.stringify(payload)), contextKey: original.payload.contextKey })}::jsonb)`;
    });
    return this.brief(ctx, eventId, newId);
  }
  async approvedDocument(
    ctx: WorkspaceTenantContext,
    eventId: string,
    id: string,
    contentHash: string,
  ) {
    const brief = await this.brief(ctx, eventId, id);
    if (
      !brief.current ||
      !brief.approvedAt ||
      brief.contentHash !== contentHash ||
      Date.now() - brief.approvedAt.getTime() > 86400000
    )
      throw new ConflictException('CURRENT_APPROVED_BRIEF_REQUIRED');
    await this.actor(ctx, (tx) => this.lockObservation(tx, ctx, brief.payload.observation, true));
    const lines = [
      `# ${brief.payload.title}`,
      '',
      'Capiro analysis — Brief based on published records',
      `Evidence cutoff: ${brief.payload.cutoff}`,
      `Observation selection: ${brief.payload.selectedObservationIds?.join(', ') || 'No captured observations; published-record analysis only'}`,
      '',
    ];
    if (brief.payload.correction) {
      const c = brief.payload.correction;
      lines.push(
        '## Reviewed correction / follow-up',
        `Earlier version: ${c.priorKind} ${c.priorId} / ${c.priorHash} · ${c.priorCreatedAt}`,
      );
      const names = {
        wrong_then: 'Earlier statement was wrong at the time',
        later_change: 'Later legislative change',
        still_supported: 'Earlier statement remains supported',
        uncertain: 'Earlier statement remains uncertain',
      };
      for (const item of c.items)
        lines.push(
          `Previously reported (preserved account): ${item.priorText}`,
          `${names[item.classification]} — Staff assessment: ${item.rationale}`,
          `Current reviewed statements: ${item.claimIds.join(', ') || 'None; unresolved'}`,
        );
    }
    for (const section of ['developments', 'changes', 'implications', 'next_steps', 'missing']) {
      lines.push(`## ${section.replaceAll('_', ' ')}`);
      for (const c of brief.payload.claims.filter((c) => c.section === section)) {
        lines.push(`${c.kind === 'analysis' ? 'Capiro analysis: ' : ''}${c.text}`);
        for (const ref of c.references) {
          const record = brief.payload.records.find((r) => r.id === ref.id)!;
          lines.push(
            `Source: ${String(record.evidence.publisher ?? record.evidence.provider ?? 'Published record')} — ${ref.id} / ${ref.hash} / ${ref.locator} — ${String(record.evidence.url ?? 'No original link supplied')}`,
          );
        }
      }
      lines.push('');
    }
    const observation = brief.payload.observation;
    const retained = observation
      ? await this.publications.retainedVersion(
          ctx,
          observation.sessionId,
          observation.publicationId,
        )
      : null;
    const accessLocks = {
      folders: brief.payload.folders,
      observation: observation
        ? {
            sessionId: observation.sessionId,
            segmentIds: retained!.payload.evidence.map((e) => e.segmentId),
          }
        : null,
    };
    return {
      schema: 'legiwatch.approved-record-brief-document.v1',
      tenantId: ctx.tenantId,
      clientId: brief.payload.clientId,
      eventId,
      briefId: id,
      accessLocks,
      seriesId: brief.seriesId,
      version: brief.version,
      contentHash,
      sourceHash: brief.payload.sourceHash,
      title: brief.payload.title,
      approvedAt: brief.approvedAt.toISOString(),
      markdown: lines.join('\n\n'),
    };
  }
  async reconcile(ctx: WorkspaceTenantContext, eventId: string, input: unknown) {
    await this.authorize(ctx);
    const body = object(input),
      event = await this.source.event(eventId);
    const sourceSelections: RecordSourceSelection[] = (
      Array.isArray(body.sourceSelections) ? body.sourceSelections : []
    ).map((value) => {
      const s = object(value),
        identity = text(s.identity, 300),
        locators =
          s.locators == null
            ? null
            : Array.isArray(s.locators)
              ? s.locators.map((v) => text(v, 200))
              : [];
      if (locators && (!locators.length || locators.length > 100))
        throw new BadRequestException('BOUNDED_SOURCE_LOCATOR_SELECTION_REQUIRED');
      return { identity, locators };
    });
    if (
      sourceSelections.length > 100 ||
      new Set(sourceSelections.map((s) => s.identity)).size !== sourceSelections.length
    )
      throw new BadRequestException('BOUNDED_UNIQUE_SOURCE_SELECTION_REQUIRED');
    const records = await this.source.snapshot(eventId, sourceSelections);
    if (sourceSelections.some((s) => !records.some((r) => r.identity === s.identity)))
      throw new BadRequestException('SELECTED_SOURCE_UNAVAILABLE');
    let observation: SourceObservation | null = null;
    let claims: RecordClaim[] = [];
    if (body.publicationId) {
      const sessionId = text(body.sessionId, 100),
        publicationId = text(body.publicationId, 100);
      const original = await this.publications.retainedVersion(ctx, sessionId, publicationId);
      if (original.payload.hearingId !== eventId)
        throw new BadRequestException('OBSERVATION_EVENT_MISMATCH');
      if (!original.evidenceCurrent)
        throw new ConflictException('OBSERVATION_CORRECTED_SELECT_NEW_PUBLICATION');
      observation = {
        sessionId,
        publicationId,
        hash: original.contentHash,
        clientId: original.payload.clientId,
      };
      // Freeze every claim in the selected immutable publication, never the latest-100 widget.
      claims = original.payload.claims.map((c) => ({
        id: c.id,
        text: c.text,
        kind: c.kind === 'analysis' ? 'analysis' : 'fact',
        scope: 'hearing_event',
        billId: null,
        references: [],
      }));
    } else {
      claims = Array.isArray(body.claims) ? (body.claims as RecordClaim[]) : [];
      if (claims.length) validateRecordClaims(claims, records);
    }
    const originalClaims = claims.map((c) => ({ ...c }));
    const checks = await this.source.checks(eventId),
      sourceHash = digest([event, records.map((r) => [r.id, r.hash, r.evidence.sourceObservationId??null, r.evidence.currentSourceVersion??null])]);
    const fingerprint = digest([sourceHash, observation, claims, sourceSelections]);
    const lease = await this.claimJob(ctx, eventId, 'reconcile', fingerprint, { input });
    if (lease.resultId) return this.run(ctx, eventId, lease.resultId);
    try {
      const candidates = new Map<string, PublishedRecordToolResult['claims'][number]>();
      if (observation && claims.some((c) => c.kind !== 'analysis') && records.length) {
        const originals = claims;
        for (const chunk of this.chunks(records))
          for (let start = 0; start < originals.length; start += 25) {
            const observations = originals.slice(start, start + 25);
            const result = await this.orchestrator.publishedRecords(ctx.tenantId, ctx.clerkUserId, {
              mode: 'reconcile',
              eventId,
              title: event.title,
              sourceSnapshotHash: sourceHash,
              records: chunk,
              observations: observations.map((c) => ({ id: c.id, text: c.text })),
              coverage: JSON.stringify(checks).slice(0, 8000),
            });
            for (const candidate of result.claims) {
              if (
                !candidate.parentClaimId ||
                !observations.some((o) => o.id === candidate.parentClaimId)
              )
                throw new BadRequestException('ATOMIC_CLAIM_PARENT_REQUIRED');
              const key = digest([candidate.parentClaimId, candidate.text, candidate.kind]).slice(
                  0,
                  32,
                ),
                previous = candidates.get(key);
              if (previous) {
                const references = [
                  ...new Map(
                    [...previous.references, ...candidate.references].map((r) => [digest(r), r]),
                  ).values(),
                ];
                candidates.set(key, {
                  ...previous,
                  references,
                  outcome:
                    previous.outcome === candidate.outcome ? previous.outcome : 'needs_review',
                  rationale:
                    previous.outcome === candidate.outcome
                      ? previous.rationale
                      : 'Source chunks yield different interpretations; review all cited versions.',
                });
              } else candidates.set(key, { ...candidate, id: key });
            }
            await this.renewJob(ctx, lease);
          }
        // Every original observation remains represented, even when the provider
        // omits it. Omission cannot become an assessment of the missing claim.
        claims = [
          ...candidates.values(),
          ...originals.filter(
            (o) => ![...candidates.values()].some((c) => c.parentClaimId === o.id),
          ),
        ];
        validateRecordClaims(claims, records, true);
      }
      const payload: RunPayload = {
        schema: 'legiwatch.record-reconciliation.v1',
        event,
        records,
        claims,
        originalClaims,
        observation,
        sourceHash,
        sourceSelections,
        cutoff: new Date().toISOString(),
        coverage: checks,
      };
      const result = await this.actor(ctx, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.clerkUserId + ':' + eventId},0))`;
        const found = await tx.$queryRaw<
          RunRow[]
        >`SELECT * FROM intel_hearing_record_run WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND event_id=${eventId} AND input_hash=${fingerprint}`;
        if (found[0]) {
          await this.completeJob(tx, lease, found[0].id);
          return found[0].id;
        }
        const id = randomUUID();
        await tx.$executeRaw`INSERT INTO intel_hearing_record_run(id,tenant_id,owner_clerk_id,event_id,input_hash,payload)
        VALUES(${id},${ctx.tenantId},${ctx.clerkUserId},${eventId},${fingerprint},${this.encode(payload)}::jsonb)`;
        for (const claim of claims) {
          let assessment = assessRecordClaim(
            claim,
            records,
            checks.some((c) => c.state === 'failed') ? 'failed' : 'pending',
          );
          const candidate = candidates.get(claim.id);
          if (candidate && claim.kind !== 'analysis') {
            const unqualified =
              claim.scope === 'hearing_event' &&
              claim.references.some(
                (ref) => records.find((r) => r.id === ref.id)?.association !== 'explicit_event',
              );
            const unknownSource = checks.some((c) => c.state === 'failed' || c.state === 'pending');
            const outcome = unqualified
              ? 'needs_review'
              : candidate.outcome === 'not_addressed' && unknownSource
                ? 'pending_records'
                : candidate.outcome;
            assessment = {
              ...assessment,
              outcome,
              rationale: unqualified
                ? 'Hearing association requires review. ' + candidate.rationale
                : candidate.rationale,
              supported: candidate.supported,
              unresolved: candidate.unresolved,
              requiresReview: true,
              ruleVersion: 'meri-published-record-brief-v1',
            };
          }
          await tx.$executeRaw`INSERT INTO intel_hearing_record_assessment(id,tenant_id,owner_clerk_id,run_id,claim_id,claim_hash,outcome,payload)
          VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${id},${claim.id},${assessment.claimHash},${assessment.outcome},${this.encode(assessment)}::jsonb)`;
        }
        await this.completeJob(tx, lease, id);
        return id;
      });
      return this.run(ctx, eventId, result);
    } catch (error) {
      await this.failJob(ctx, lease);
      throw error;
    }
  }
  async run(ctx: WorkspaceTenantContext, eventId: string, id: string) {
    await this.authorize(ctx);
    const row = await this.actor(
      ctx,
      async (tx) =>
        (
          await tx.$queryRaw<
            RunRow[]
          >`SELECT * FROM intel_hearing_record_run WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND event_id=${eventId} AND id=${id}`
        )[0],
    );
    if (!row) throw new NotFoundException();
    const payload = this.decode<RunPayload>(row.payload);
    let observationCurrent = true;
    if (payload.observation) {
      const o = payload.observation;
      const current = await this.publications.retainedVersion(ctx, o.sessionId, o.publicationId);
      if (current.contentHash !== o.hash)
        throw new ConflictException('OBSERVATION_VERSION_CHANGED');
      observationCurrent = current.evidenceCurrent;
    }
    const assessments = await this.actor(
      ctx,
      (tx) =>
        tx.$queryRaw<
          Array<{ id: string; payload: unknown }>
        >`SELECT id,payload FROM intel_hearing_record_assessment WHERE run_id=${id} AND tenant_id=${ctx.tenantId} ORDER BY claim_id,id`,
    );
    const reviews = await this.actor(
      ctx,
      (tx) =>
        tx.$queryRaw<
          Array<{ id: string; assessment_id: string; payload: unknown; created_at: Date }>
        >`SELECT id,assessment_id,payload,created_at FROM intel_hearing_record_review WHERE run_id=${id} AND tenant_id=${ctx.tenantId} ORDER BY created_at,id`,
    );
    const currentRecords = await this.source.snapshot(eventId, payload.sourceSelections),
      event = await this.source.event(eventId);
    const current =
      observationCurrent &&
      payload.sourceHash === digest([event, currentRecords.map((r) => [r.id, r.hash, r.evidence.sourceObservationId??null, r.evidence.currentSourceVersion??null])]);
    return {
      id,
      inputHash: row.input_hash,
      payload,
      current,
      createdAt: row.created_at,
      assessments: assessments.map((a) => ({
        id: a.id,
        ...this.decode<RecordAssessment>(a.payload),
        reviews: reviews
          .filter((r) => r.assessment_id === a.id)
          .map((r) => ({
            id: r.id,
            createdAt: r.created_at,
                ...this.decode<{outcome:string;rationale:string;references:RecordClaim['references'];reviewer:string}>(r.payload),
          })),
      })),
    };
  }
  async review(
    ctx: WorkspaceTenantContext,
    eventId: string,
    runId: string,
    assessmentId: string,
    input: unknown,
  ) {
    const run = await this.run(ctx, eventId, runId),
      body = object(input),
      assessment = run.assessments.find((a) => a.id === assessmentId);
    if (!assessment) throw new NotFoundException();
    if (!run.current || body.claimHash !== assessment.claimHash || body.inputHash !== run.inputHash)
      throw new ConflictException('RECONCILIATION_CHANGED_REVIEW_AGAIN');
    const outcome = text(body.outcome, 32),
      rationale = text(body.rationale, 4000);
    if (
      ![
        'supported',
        'partially_supported',
        'contradicted',
        'not_addressed',
        'pending_records',
        'needs_review',
        'capiro_analysis',
      ].includes(outcome)
    )
      throw new BadRequestException('INVALID_ASSESSMENT');
    const references = Array.isArray(body.references) ? body.references : assessment.references;
    const claim = run.payload.claims.find((c) => c.id === assessment.claimId)!;
    if (['supported', 'partially_supported', 'contradicted'].includes(outcome)) {
      validateRecordClaims([{ ...claim, kind: 'fact', references }], run.payload.records);
      if (body.attestIdentity !== true)
        throw new BadRequestException('EXACT_SUBJECT_BODY_MOTION_VERSION_REVIEW_REQUIRED');
    }
    await this.actor(ctx, async (tx) => {
      await this.sourceBoundary(tx, ctx, eventId);
      await this.lockContext(tx, ctx, run.payload.observation?.clientId ?? null);
      await this.lockObservation(tx, ctx, run.payload.observation);
      if (!(await this.run(ctx, eventId, runId)).current)
        throw new ConflictException('RECONCILIATION_CHANGED_REVIEW_AGAIN');
      await tx.$executeRaw`INSERT INTO intel_hearing_record_review(id,tenant_id,owner_clerk_id,run_id,assessment_id,claim_hash,outcome,payload)
      VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${runId},${assessmentId},${assessment.claimHash},${outcome},
        ${this.encode({ outcome, rationale, references, reviewer: ctx.clerkUserId, attestIdentity: body.attestIdentity === true })}::jsonb)`;
    });
    return this.run(ctx, eventId, runId);
  }
  async runPage(ctx: WorkspaceTenantContext, eventId: string, id: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new BadRequestException('INVALID_ASSESSMENT_PAGE');
    const run = await this.run(ctx, eventId, id),
      assessments = run.assessments.slice(offset, offset + 50),
      claims = run.payload.claims.filter((c) => assessments.some((a) => a.claimId === c.id));
    return {
      ...run,
      payload: {
        ...run.payload,
        claims,
        originalClaims: (run.payload.originalClaims ?? []).filter((c) =>
          claims.some((a) => a.id === c.id || object(a).parentClaimId === c.id),
        ),
      },
      assessments,
      offset,
      totalAssessments: run.assessments.length,
      next: offset + 50 < run.assessments.length ? offset + 50 : null,
    };
  }
}
