import {
  rejectAutomaticOfficialFact,
  restoreAutomaticOfficialFact,
  isAutomaticOfficialEvidence,
} from './profile-official-facts.js';
import { visibleFacilitySources } from './facility-source-access.js';
import { visibleCapabilityProvenance } from './portfolio/portfolio-source-access.js';
import { parseProfileSave } from './profile-build-validation.js';
import { manualCodeEvidence } from './profile-manual-field-evidence.js';
import { ProfileIdentityDiscoveryService } from './profile-identity-discovery.service.js';
import { BizDevDossierService } from '../business-development/bizdev-dossier.service.js';
export { parseProfileSave, type SaveProfileInput } from './profile-build-validation.js';
import { assertConflictCurrentFact, profileFactSource } from './profile-facts.js';
import { assertSharedProfileEvidence, visibleProfileFindings } from './profile-shared-evidence.js';
import { searchProfileBuildReferenceCatalog } from './profile-build-reference-catalog.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { isUUID } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { attachmentViewerWhere } from '../engagement/attachments/attachment-viewer-access.js';
import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';
import {
  buildClientProfileFillTaskPlan,
  type StartClientProfileFillWorkflowInput,
} from './client-profile-fill-workflow.service.js';
import { createResearchRun } from './client-profile-fill-run-create.js';
import { researchStartRequest, readResearchStart } from './client-profile-fill-start-request.js';
import {
  retryResearchTask,
  type ResearchRetryCommand,
} from './client-profile-fill-retry-command.js';
import { readReviewSnapshot, reviewHash } from './client-profile-fill-review-snapshot.js';
import {
  commitReviewedFindings,
  type ReviewCommand,
  type ReviewTransaction,
} from './client-profile-fill-review-store.js';
import { requireOwnerActor } from './client-ordered-owner.access.js';
import {
  requireProfileSubject,
  requireProfileEditor,
  subjectColumn,
  type ProfileSubject,
} from './profile-subject.js';
import {
  FACT_SELECT,
  findingFactKey,
  readProfileFacts,
  writeProfileFact,
  type ProfileFact,
} from './profile-facts.js';
import { ProfileProjectionService, MANUAL_FIELDS } from './profile-projection.service.js';
import {
  asRecord,
  asString,
  asStringArray,
  type ClientProfileFillSource,
} from './client-profile-fill.helpers.js';
import { researchWebsite } from './client-profile-fill-research-inputs.js';

const PROSPECT_SOURCES: ClientProfileFillSource[] = ['public_web', 'sam_gov', 'lda'];
const SECTIONS = ['locations', 'leadership', 'capabilities', 'advocacy', 'notes'] as const;
@Injectable()
export class ProfileBuildService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly completion: ClientProfileFillCompletionService,
    private readonly projection: ProfileProjectionService,
    private readonly dossier: BizDevDossierService,
    private readonly identityDiscovery: ProfileIdentityDiscoveryService,
  ) {}

  private async snapshot(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    subject: ProfileSubject,
  ) {
    const record =
      subject.kind === 'client'
        ? await tx.client.findFirst({ where: { id: subject.id, tenantId: ctx.tenantId } })
        : await tx.businessDevelopmentProspect.findFirst({
            where: { id: subject.id, tenantId: ctx.tenantId },
          });
    if (!record) throw new NotFoundException('Profile not found');
    const allFacts = await readProfileFacts(tx, ctx.tenantId, subject),
      facts: ProfileFact[] = [];
    for (const fact of allFacts) {
      try {
        await assertSharedProfileEvidence(
          tx,
          ctx.tenantId,
          subject,
          [...fact.evidence, ...(fact.attachmentId ? [{ attachmentId: fact.attachmentId }] : [])],
          ctx,
        );
        facts.push({ ...fact, autoAccepted: isAutomaticOfficialEvidence(fact.evidence) });
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
        if (fact.status === 'approved' || fact.status === 'superseded')
          facts.push({
            ...fact,
            sourceUrl: null,
            attachmentId: null,
            sourceUnavailable: true,
            evidence: [{ label: 'Original source is no longer shared' }],
          });
      }
    }
    if (subject.kind === 'client')
      for (const fact of facts) {
        const value = asRecord(fact.value);
        if (fact.fieldKey.startsWith('locations.'))
          fact.value = await visibleFacilitySources(tx, ctx, subject.id, {
            ...value,
            sourceEvidence: value.sourceEvidence,
            economicImpact: value.economicImpact,
          });
        if (fact.fieldKey.startsWith('capabilities.') && value.provenance !== undefined)
          fact.value = {
            ...value,
            provenance: await visibleCapabilityProvenance(
              tx,
              ctx,
              subject.id,
              value.provenance as Prisma.JsonValue,
            ),
          };
      }
    const current = facts.filter((f) => f.isCurrent);
    const fields: Record<string, unknown> = {};
    for (const key of MANUAL_FIELDS)
      if (key in record) fields[key] = (record as Record<string, unknown>)[key];
    if (subject.kind === 'prospect') fields.name = (record as { displayName: string }).displayName;
    for (const f of current) if (!f.fieldKey.includes('.')) fields[f.fieldKey] = f.value;
    const sections: Record<string, unknown[]> = {
      locations: [],
      leadership: [],
      capabilities: [],
      advocacy: [],
      notes: [],
      documents: [],
    };
    if (subject.kind === 'client') {
      const locations = await tx.clientFacility.findMany({
        where: { tenantId: ctx.tenantId, clientId: subject.id },
        orderBy: { createdAt: 'asc' },
      });
      sections.locations = await Promise.all(
        locations.map((row) => visibleFacilitySources(tx, ctx, subject.id, row)),
      );
      sections.leadership = await tx.clientPerson.findMany({
        where: { tenantId: ctx.tenantId, clientId: subject.id },
        orderBy: { createdAt: 'asc' },
      });
      const capabilities = await tx.clientCapability.findMany({
        where: { tenantId: ctx.tenantId, clientId: subject.id },
        orderBy: { createdAt: 'asc' },
      });
      sections.capabilities = await Promise.all(
        capabilities.map(async (c) => ({
          ...c,
          provenance: await visibleCapabilityProvenance(tx, ctx, subject.id, c.provenance),
        })),
      );
    }
    for (const section of SECTIONS)
      if (subject.kind === 'prospect' || ['advocacy', 'notes'].includes(section))
        sections[section] = current
          .filter((f) => f.fieldKey.startsWith(section + '.'))
          .map((f) => f.value);
    sections.documents = await tx.engagementAttachment.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(subject.kind === 'client'
          ? { clientId: subject.id, prospectId: null }
          : { prospectId: subject.id, clientId: null }),
        OR: attachmentViewerWhere(ctx.userId),
        supersededByAttachmentId: null,
        lifecycleStatus: { notIn: ['delete_pending', 'delete_failed'] },
      },
      select: {
        id: true,
        fileName: true,
        contentType: true,
        lifecycleStatus: true,
        createdAt: true,
      },
    });
    if (subject.kind === 'client') {
      const links = await tx.$queryRawUnsafe<Array<{ prospectId: string; attachmentId: string }>>(
        `SELECT prospect_id AS "prospectId",attachment_id AS "attachmentId" FROM profile_attachment_link WHERE tenant_id=$1::uuid AND client_id=$2::uuid`,
        ctx.tenantId,
        subject.id,
      );
      for (const link of links) {
        try {
          await requireProfileSubject(tx, ctx, { kind: 'prospect', id: link.prospectId });
        } catch {
          continue;
        }
        const document = await tx.engagementAttachment.findFirst({
          where: {
            id: link.attachmentId,
            tenantId: ctx.tenantId,
            prospectId: link.prospectId,
            OR: attachmentViewerWhere(ctx.userId),
            supersededByAttachmentId: null,
            lifecycleStatus: { notIn: ['delete_pending', 'delete_failed'] },
          },
          select: {
            id: true,
            fileName: true,
            contentType: true,
            lifecycleStatus: true,
            createdAt: true,
          },
        });
        if (document)
          sections.documents!.push({
            ...document,
            origin: 'prospect',
            prospectId: link.prospectId,
          });
      }
    }
    const allConflicts = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id,field_key AS "fieldKey",current_fact_id AS "currentFactId",proposed_fact_id AS "proposedFactId",status,version,resolution FROM profile_fact_conflict WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid ORDER BY created_at`,
      ctx.tenantId,
      subject.id,
    );
    const visibleIds = new Set(facts.map((f) => f.id)),
      conflicts = allConflicts.filter(
        (c) => visibleIds.has(String(c.currentFactId)) && visibleIds.has(String(c.proposedFactId)),
      );
    sections.company = [fields];
    sections.registration = [
      {
        uei: fields.uei,
        cageCode: fields.cageCode,
        naicsCodes: fields.naicsCodes,
        pscCodes: fields.pscCodes,
      },
    ];
    sections.lobbying = current.filter((f) => f.fieldKey.startsWith('lda')).map((f) => f.value);
    sections.federal_footprint = current
      .filter((f) => f.fieldKey.startsWith('federal_footprint.'))
      .map((f) => f.value);
    sections.news = current.filter((f) => f.fieldKey.startsWith('news.')).map((f) => f.value);
    const researched = await tx.$queryRawUnsafe<Array<{ taskType: string }>>(
      `SELECT DISTINCT task_type AS "taskType" FROM client_profile_fill_task WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid AND status='completed'`,
      ctx.tenantId,
      subject.id,
    );
    if (subject.kind === 'prospect') {
      const lobbying = await tx.$queryRawUnsafe<
        Array<{ value: Record<string, unknown>; evidence: unknown[] }>
      >(
        `SELECT DISTINCT ON(target_key) proposed_value_jsonb AS value,evidence_jsonb AS evidence FROM client_profile_fill_finding WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid AND kind='lda_history' AND status='informational' ORDER BY target_key,created_at DESC`,
        ctx.tenantId,
        subject.id,
      );
      sections.lobbying!.push(
        ...lobbying.map((row) => ({ ...row.value, evidence: row.evidence, referenceOnly: true })),
      );
    }
    const evidenceSections =
      subject.kind === 'prospect'
        ? ['company', 'registration', 'leadership', 'lobbying', 'federal_footprint', 'news']
        : ['basics', 'registration', ...SECTIONS.filter((s) => s !== 'notes')];
    const completeness = evidenceSections.map((key) => {
      const values = ['basics', 'company'].includes(key)
        ? [fields.name, fields.website, fields.description]
        : key === 'registration'
          ? [fields.uei, fields.cageCode, fields.naicsCodes]
          : (sections[key] ?? []);
      const count = values.filter(
        (v) => v != null && v !== '' && (!Array.isArray(v) || v.length),
      ).length;
      return {
        key,
        status:
          count === 0
            ? 'missing'
            : key === 'lobbying' && subject.kind === 'prospect'
              ? 'partial'
              : ['basics', 'company', 'registration'].includes(key) && count < values.length
                ? 'partial'
                : 'complete',
        researched: researched.some(
          (t) =>
            t.taskType ===
            (
              {
                company: 'public_web',
                basics: 'public_web',
                leadership: 'public_web',
                news: 'public_web',
                registration: 'sam_gov',
                lobbying: 'lda',
              } as Record<string, string>
            )[key],
        ),
        reviewCount: facts.filter((f) => f.status === 'pending' && f.fieldKey.startsWith(key + '.'))
          .length,
      };
    });
    const version = reviewHash({ record, facts, sections, conflicts });
    return {
      subject,
      version,
      fields,
      facts,
      conflicts,
      sections,
      completeness: {
        completed: completeness.filter((x) => x.status === 'complete').length,
        total: completeness.length,
        missing: completeness.filter((x) => x.status === 'missing').map((x) => x.key),
        sections: completeness,
      },
    };
  }
  async profile(ctx: TenantContext, subject: ProfileSubject) {
    const profile = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireProfileSubject(tx, ctx, subject);
      return this.snapshot(tx, ctx, subject);
    });
    if (subject.kind === 'prospect') {
      try {
        const dossier = await this.dossier.prospectDossier(
          ctx,
          subject.id,
          'government_exposure',
          true,
        );
        const section = dossier.sections.government_exposure;
        if (section) {
          const approvedFootprint = profile.sections.federal_footprint ?? [];
          profile.sections.federal_footprint = [
            ...approvedFootprint,
            ...section.evidence.map((e) => ({
              ...e,
              title: e.title,
              url: e.locator,
              summary: e.title,
              referenceOnly: true,
            })),
          ];
          const row = profile.completeness.sections.find((s) => s.key === 'federal_footprint');
          if (row) {
            row.researched = !['ambiguous', 'error'].includes(section.status);
            if (!approvedFootprint.length)
              row.status = section.evidence.length ? 'partial' : 'missing';
          }
          Object.assign(profile, {
            referenceCoverage: {
              federal_footprint: { status: section.status, statusText: section.statusText },
            },
          });
        }
      } catch {
        Object.assign(profile, {
          referenceCoverage: {
            federal_footprint: {
              status: 'error',
              statusText: 'Federal reference records could not be checked.',
            },
          },
        });
      }
    }
    return profile;
  }
  async save(ctx: TenantContext, subject: ProfileSubject, raw: unknown) {
    const input = parseProfileSave(raw),
      { referenceMetadata: _referenceMetadata, ...command } = input,
      digest = reviewHash({ subject, input: command }),
      effects: ReviewTransaction['afterCommit'] = [];
    const result = await this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        await requireProfileEditor(tx, ctx, subject);
        const receipt = await this.receipt(
          tx,
          ctx,
          subject,
          input.requestId,
          'profile_build.save',
          digest,
        );
        if (receipt) return this.snapshot(tx, ctx, subject);
        const before = await this.snapshot(tx, ctx, subject);
        if (before.version !== input.expectedVersion)
          throw new ConflictException('The profile changed. Reload before saving.');
        for (const key of Object.keys(input.fieldEvidence ?? {}))
          await assertSharedProfileEvidence(tx, ctx.tenantId, subject, manualCodeEvidence(input.fieldEvidence, key), ctx);
        const values: Array<[string, unknown]> = Object.entries(input.fields ?? {});
        for (const section of SECTIONS) {
          const rawSection = input[section];
          if (rawSection === undefined) continue;
          const rows = Array.isArray(rawSection) ? rawSection : [rawSection];
          for (const row of rows) {
            const value = typeof row === 'string' ? { body: row } : asRecord(row);
            values.push([
              `${section}.${asString(value.id) ?? (section === 'advocacy' ? 'profile' : randomUUID())}`,
              value,
            ]);
          }
        }
        const scope = { tx, afterCommit: effects };
        for (const [key, value] of values) {
          const inputValue =
            subject.kind === 'prospect' && key.includes('.') && !key.startsWith('advocacy.')
              ? { ...asRecord(value), id: asRecord(value).id ?? key.split('.')[1] }
              : value;
          const projected = await this.projection.project(scope, ctx, subject, key, inputValue);
          const factKey =
            key.includes('.') && asString(asRecord(projected).id)
              ? `${key.split('.')[0]}.${asString(asRecord(projected).id)}`
              : key;
          await writeProfileFact(tx, ctx, subject, {
            fieldKey: factKey,
            value: projected,
            origin: 'person',
            originId: `manual:${input.requestId}:${key}`,
            sourceType: 'person_entry',
            evidence: [
              ...(input.referenceMetadata?.[key as 'naicsCodes' | 'pscCodes'] ?? []),
              ...manualCodeEvidence(input.fieldEvidence, key),
            ],
          });
        }
        const after = await this.snapshot(tx, ctx, subject);
        await this.writeReceipt(
          tx,
          ctx,
          subject,
          input.requestId,
          'profile_build.save',
          digest,
          after,
        );
        return after;
      },
      { timeoutMs: 30000 },
    );
    await this.effects(effects);
    return result;
  }
  async setup(ctx: TenantContext, subject: ProfileSubject) {
    if (subject.kind === 'client')
      return { ...(await this.completion.getSetup(ctx, subject.id)), subject, prospectId: null };
    const p = await this.profile(ctx, subject);
    return {
      subject,
      clientId: null,
      prospectId: subject.id,
      clientName: p.fields.name,
      website: p.fields.website ?? null,
      selectedIdentities: [],
      suggestedIdentities: [],
      availableSources: PROSPECT_SOURCES,
      taskPreview: ['Public web', 'SAM.gov', 'LDA', 'Capability documents'],
    };
  }
  async start(
    ctx: TenantContext,
    subject: ProfileSubject,
    input: StartClientProfileFillWorkflowInput,
  ) {
    if (subject.kind === 'client')
      return { ...(await this.completion.startRun(ctx, subject.id, input)), subject };
    if (
      input.businessUnitId ||
      Object.hasOwn(input, 'purpose') ||
      Object.hasOwn(input, 'capabilityId')
    )
      throw new BadRequestException(
        'Capability and business-unit research require a client profile',
      );
    if (!input.requestId) throw new BadRequestException('Request ID is required');
    const request = researchStartRequest(ctx, subject.id, input, subject)!;
    const replay = await readResearchStart(this.prisma, ctx, subject.id, request, subject);
    if (replay) return this.run(ctx, subject, replay);
    const sources = input.sources === undefined ? PROSPECT_SOURCES : [...new Set(input.sources)];
    if (sources.some((s) => !PROSPECT_SOURCES.includes(s)))
      throw new BadRequestException('This source requires a client profile');
    const ids = [...new Set(input.attachmentIds ?? [])];
    if (ids.length > 10 || ids.some((id) => !isUUID(id)))
      throw new BadRequestException('Invalid document selection');
    if (!sources.length && !ids.length)
      throw new BadRequestException('Select a source or document');
    if (input.ldaClientIds?.length)
      throw new BadRequestException('Resolve LDA identity from sourced findings for this prospect');
    const setup = await this.setup(ctx, subject);
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireProfileSubject(tx, ctx, subject, false, true);
      const rows = await tx.engagementAttachment.findMany({
        where: {
          tenantId: ctx.tenantId,
          prospectId: subject.id,
          id: { in: ids },
          viewerMode: 'all',
          lifecycleStatus: { in: ['ready', 'legacy_ready'] },
          supersededByAttachmentId: null,
        },
        select: { id: true },
      });
      if (rows.length !== ids.length) throw new NotFoundException('Document not available');
    });
    const website =
      researchWebsite(input.website) ?? researchWebsite(setup.website as string | null);
    const plan = buildClientProfileFillTaskPlan({ sources, attachmentIds: ids }).map((t) => ({
      ...t,
      input: { ...t.input, website },
    }));
    const { runId } = await createResearchRun(
      this.prisma,
      ctx,
      subject.id,
      {
        sources,
        sourceStates: Object.fromEntries(sources.map((s) => [s, { status: 'queued', count: 0 }])),
        setup: { subject, website, attachmentIds: ids, sources },
        selectedLdaIds: [],
        attachmentIds: ids,
        plan,
        request,
      },
      subject,
    );
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_run SET stage='research' WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid AND id=$3::uuid AND status='running'`,
        ctx.tenantId,
        subject.id,
        runId,
      ),
    );
    return this.run(ctx, subject, runId);
  }
  async latest(ctx: TenantContext, subject: ProfileSubject) {
    if (subject.kind === 'client') {
      const run = await this.completion.getLatest(ctx, subject.id);
      return run ? { ...run, subject } : null;
    }
    const id = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireProfileSubject(tx, ctx, subject);
      return (
        await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM client_profile_fill_run WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid ORDER BY created_at DESC LIMIT 1`,
          ctx.tenantId,
          subject.id,
        )
      )[0]?.id;
    });
    return id ? this.run(ctx, subject, id) : null;
  }
  async run(ctx: TenantContext, subject: ProfileSubject, runId: string) {
    if (subject.kind === 'client')
      return { ...(await this.completion.getRun(ctx, subject.id, runId)), subject };
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireProfileSubject(tx, ctx, subject);
      const run = (
        await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT id,client_id AS "clientId",prospect_id AS "prospectId",status,stage,error,requested_sources AS "requestedSources",source_states_jsonb AS "sourceStates",summary_jsonb AS summary,workflow_version AS "workflowVersion",setup_jsonb AS setup,attachment_ids AS "attachmentIds",selected_lda_ids AS "selectedLdaIds",created_at AS "createdAt",updated_at AS "updatedAt",started_at AS "startedAt",completed_at AS "completedAt",cancelled_at AS "cancelledAt" FROM client_profile_fill_run WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid AND id=$3::uuid`,
          ctx.tenantId,
          subject.id,
          runId,
        )
      )[0];
      if (!run) throw new NotFoundException('Research run not found');
      const tasks = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT id,run_id AS "runId",client_id AS "clientId",prospect_id AS "prospectId",task_type AS "taskType",task_key AS "taskKey",status,attempt,max_attempts AS "maxAttempts",input_jsonb AS input,output_summary_jsonb AS "outputSummary",error_code AS "errorCode",error_message AS "errorMessage",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt" FROM client_profile_fill_task WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid AND run_id=$3::uuid ORDER BY created_at,task_key`,
        ctx.tenantId,
        subject.id,
        runId,
      );
      const findings = await tx.$queryRawUnsafe<
        Array<Record<string, unknown> & { evidence: unknown }>
      >(
        `SELECT id,run_id AS "runId",client_id AS "clientId",prospect_id AS "prospectId",kind,target_key AS "targetKey",source,fact_kind AS "factKind",current_value_jsonb AS "currentValue",proposed_value_jsonb AS "proposedValue",evidence_jsonb AS evidence,confidence::float8 AS confidence,status,content_hash AS "contentHash",reviewed_at AS "reviewedAt",reviewed_by AS "reviewedBy",applied_at AS "appliedAt",created_at AS "createdAt",updated_at AS "updatedAt",rejection_reason AS "rejectionReason" FROM client_profile_fill_finding WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid AND run_id=$3::uuid ORDER BY created_at,id`,
        ctx.tenantId,
        subject.id,
        runId,
      );
      const progress = Object.fromEntries(
        ['queued', 'running', 'completed', 'failed', 'skipped', 'cancelled'].map((status) => [
          status,
          tasks.filter((t) => t.status === status).length,
        ]),
      );
      return {
        ...run,
        subject,
        tasks,
        findings: await visibleProfileFindings(tx, ctx, subject, findings),
        progress: { ...progress, total: tasks.length },
      };
    });
  }
  async cancel(ctx: TenantContext, subject: ProfileSubject, runId: string) {
    if (subject.kind === 'client')
      return { ...(await this.completion.cancelRun(ctx, subject.id, runId)), subject };
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireProfileSubject(tx, ctx, subject, false, true);
      const n = await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_run SET status='cancelled',stage='cancelled',cancelled_at=now(),completed_at=now(),updated_at=now() WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid AND id=$3::uuid AND status='running'`,
        ctx.tenantId,
        subject.id,
        runId,
      );
      if (!n) throw new ConflictException('Run is no longer active');
      await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_task SET status='cancelled',worker_id=NULL,completed_at=now(),updated_at=now() WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid AND run_id=$3::uuid AND status IN ('queued','running')`,
        ctx.tenantId,
        subject.id,
        runId,
      );
    });
    return this.run(ctx, subject, runId);
  }
  review(ctx: TenantContext, subject: ProfileSubject, runId: string) {
    return readReviewSnapshot(this.prisma, ctx, subject.id, runId, subject);
  }
  retry(
    ctx: TenantContext,
    subject: ProfileSubject,
    runId: string,
    taskId: string,
    input: ResearchRetryCommand,
  ) {
    return retryResearchTask(this.prisma, ctx, subject.id, runId, taskId, input, subject);
  }
  apply(ctx: TenantContext, subject: ProfileSubject, runId: string, input: ReviewCommand) {
    if (subject.kind === 'client')
      return this.completion.applyFindings(ctx, subject.id, runId, input);
    return commitReviewedFindings(
      this.prisma,
      ctx,
      subject.id,
      runId,
      input,
      async (scope, finding) => {
        const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
        await assertSharedProfileEvidence(scope.tx, ctx.tenantId, subject, evidence, ctx);
        const key = findingFactKey(finding);
        const result = await writeProfileFact(scope.tx, ctx, subject, {
          fieldKey: key,
          value: finding.proposedValue,
          origin: 'research',
          originId: `finding:${finding.id}`,
          findingId: finding.id,
          runId,
          sourceType: finding.source,
          evidence,
          ...profileFactSource(evidence),
          confidence: Number(finding.confidence),
        });
        if (result.conflict) return { conflict: true };
        if (
          ['profile_field', 'government_identity', 'person', 'facility', 'capability'].includes(
            finding.kind,
          )
        )
          await this.projection.project(scope, ctx, subject, key, finding.proposedValue);
      },
      { subject, warn: () => undefined },
    );
  }
  async decision(
    ctx: TenantContext,
    subject: ProfileSubject,
    findingId: string,
    restore: boolean,
    reason?: string,
  ) {
    const automaticEffects: ReviewTransaction['afterCommit'] = [];
    const automatic = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireProfileSubject(tx, ctx, subject, true, true);
      const scope = { tx, afterCommit: automaticEffects };
      const changed = restore
        ? await restoreAutomaticOfficialFact(tx, ctx, subject, findingId)
        : await rejectAutomaticOfficialFact(
            scope,
            ctx,
            subject,
            findingId,
            reason,
            (scope, ctx, subject, key, value) =>
              this.projection.project(scope, ctx, subject, key, value),
          );
      if (changed)
        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: restore
              ? 'profile_build.official_fact_restore'
              : 'profile_build.official_fact_reject',
            entityType: 'profile_finding',
            entityId: findingId,
            after: { subject, reason: reason ?? null },
          },
        });
      return changed;
    });
    if (automatic) {
      await this.effects(automaticEffects);
      return { ok: true };
    }
    if (subject.kind === 'client')
      return restore
        ? this.completion.restoreFinding(ctx, subject.id, findingId)
        : this.completion.rejectFinding(ctx, subject.id, findingId, reason);
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireProfileSubject(tx, ctx, subject, true, true);
      const changed = await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_finding SET status=$4,reviewed_by=$5::uuid,reviewed_at=$6,rejection_reason=$7,updated_at=now() WHERE tenant_id=$1::uuid AND prospect_id=$2::uuid AND id=$3::uuid AND status=$8`,
        ctx.tenantId,
        subject.id,
        findingId,
        restore ? 'pending' : 'rejected',
        restore ? null : ctx.userId,
        restore ? null : new Date(),
        restore ? null : (reason?.slice(0, 1000) ?? null),
        restore ? 'rejected' : 'pending',
      );
      if (!changed) throw new ConflictException('Finding changed');
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: restore ? 'profile_build.restore' : 'profile_build.reject',
          entityType: 'profile_finding',
          entityId: findingId,
          after: { subject, reason: reason ?? null },
        },
      });
      return { ok: true, id: findingId, status: restore ? 'pending' : 'rejected' };
    });
  }
  async resolveFact(
    ctx: TenantContext,
    subject: ProfileSubject,
    factId: string,
    input: {
      requestId: string;
      expectedVersion: number;
      resolution: 'keep_current' | 'accept_proposed';
    },
  ) {
    if (
      !isUUID(input.requestId) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      !['keep_current', 'accept_proposed'].includes(input.resolution)
    )
      throw new BadRequestException('Invalid conflict resolution');
    const effects: ReviewTransaction['afterCommit'] = [];
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireProfileSubject(tx, ctx, subject, true, true);
      const digest = reviewHash({ factId, input });
      if (await this.receipt(tx, ctx, subject, input.requestId, 'profile_build.resolve', digest))
        return;
      const conflict = (
        await tx.$queryRawUnsafe<
          Array<{
            id: string;
            currentFactId: string;
            proposedFactId: string;
            version: number;
            status: string;
          }>
        >(
          `SELECT id,current_fact_id AS "currentFactId",proposed_fact_id AS "proposedFactId",version,status FROM profile_fact_conflict WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid AND (id=$3::uuid OR proposed_fact_id=$3::uuid) FOR UPDATE`,
          ctx.tenantId,
          subject.id,
          factId,
        )
      )[0];
      if (!conflict || conflict.version !== input.expectedVersion || conflict.status !== 'pending')
        throw new ConflictException('Conflict changed');
      await assertConflictCurrentFact(tx, ctx.tenantId, subject, conflict.currentFactId);
      const fact = (
        await tx.$queryRawUnsafe<ProfileFact[]>(
          `SELECT ${FACT_SELECT} FROM profile_fact WHERE tenant_id=$1::uuid AND ${subjectColumn(subject)}=$2::uuid AND id=$3::uuid FOR UPDATE`,
          ctx.tenantId,
          subject.id,
          conflict.proposedFactId,
        )
      )[0]!;
      if (input.resolution === 'accept_proposed') {
        await tx.$executeRawUnsafe(
          `UPDATE profile_fact SET is_current=false,status='superseded',version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid AND is_current`,
          ctx.tenantId,
          conflict.currentFactId,
        );
        await assertSharedProfileEvidence(
          tx,
          ctx.tenantId,
          subject,
          [...fact.evidence, ...(fact.attachmentId ? [{ attachmentId: fact.attachmentId }] : [])],
          ctx,
        );
        await this.projection.project(
          { tx, afterCommit: effects },
          ctx,
          subject,
          fact.fieldKey,
          fact.value,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE profile_fact SET status=$3,is_current=$4,approved_by=$5::uuid,approved_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        ctx.tenantId,
        fact.id,
        input.resolution === 'accept_proposed' ? 'approved' : 'rejected',
        input.resolution === 'accept_proposed',
        ctx.userId,
      );
      if (fact.findingId)
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_finding SET status=$3,reviewed_by=$4::uuid,reviewed_at=now(),applied_at=$5,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'`,
          ctx.tenantId,
          fact.findingId,
          input.resolution === 'accept_proposed' ? 'accepted' : 'rejected',
          ctx.userId,
          input.resolution === 'accept_proposed' ? new Date() : null,
        );
      await tx.$executeRawUnsafe(
        `UPDATE profile_fact_conflict SET status='resolved',resolution=$3,resolved_by=$4::uuid,resolved_at=now(),version=version+1 WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        ctx.tenantId,
        conflict.id,
        input.resolution,
        ctx.userId,
      );
      await this.writeReceipt(tx, ctx, subject, input.requestId, 'profile_build.resolve', digest, {
        resolved: true,
      });
    });
    await this.effects(effects);
    return this.profile(ctx, subject);
  }
  identify(ctx: TenantContext, input: unknown, signal?: AbortSignal) {
    return this.identityDiscovery.preview(ctx, input, signal);
  }
  confirmSourceIdentity(ctx: TenantContext, input: unknown, signal?: AbortSignal) {
    return this.identityDiscovery.confirm(ctx, input, signal);
  }
  async confirmIdentity(
    ctx: TenantContext,
    subject: ProfileSubject,
    input: { requestId: string; expectedVersion: string; canonicalEntityId: string },
  ) {
    if (!isUUID(input.requestId) || !isUUID(input.canonicalEntityId))
      throw new BadRequestException('Invalid identity confirmation');
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireProfileEditor(tx, ctx, subject);
      const digest = reviewHash({ subject, input });
      if (await this.receipt(tx, ctx, subject, input.requestId, 'profile_build.identity', digest))
        return;
      if ((await this.snapshot(tx, ctx, subject)).version !== input.expectedVersion)
        throw new ConflictException('Profile changed');
      const entity = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM canonical_entities WHERE id=$1::uuid AND entity_type='organization' AND status='active' AND merged_into_entity_id IS NULL AND (identity_scope='global_public' OR tenant_id=$2::uuid)`,
        input.canonicalEntityId,
        ctx.tenantId,
      );
      if (!entity.length) throw new NotFoundException('Identity unavailable');
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        `${ctx.tenantId}:profile-identity:${input.canonicalEntityId}`,
      );
      const table = subject.kind === 'client' ? 'clients' : 'business_development_prospects';
      const duplicate = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM ${table} WHERE tenant_id=$1::uuid AND canonical_entity_id=$2::uuid AND id<>$3::uuid`,
        ctx.tenantId,
        input.canonicalEntityId,
        subject.id,
      );
      if (duplicate.length)
        throw new ConflictException(
          'This organization already has a profile. Review the existing record.',
        );
      await tx.$executeRawUnsafe(
        `UPDATE ${table} SET canonical_entity_id=$3::uuid,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        ctx.tenantId,
        subject.id,
        input.canonicalEntityId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO profile_entity_candidate(tenant_id,${subjectColumn(subject)},canonical_entity_id,status,reviewed_by,reviewed_at) VALUES($1::uuid,$2::uuid,$3::uuid,'chosen',$4::uuid,now()) ON CONFLICT DO NOTHING`,
        ctx.tenantId,
        subject.id,
        input.canonicalEntityId,
        ctx.userId,
      );
      await this.writeReceipt(tx, ctx, subject, input.requestId, 'profile_build.identity', digest, {
        confirmed: true,
      });
    });
    return this.profile(ctx, subject);
  }
  async references(ctx: TenantContext, kind: string, q = '') {
    if (!['naics', 'psc', 'lda'].includes(kind) || q.length > 100)
      throw new BadRequestException('Invalid reference search');
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => requireOwnerActor(tx, ctx));
    if (kind === 'naics' || kind === 'psc')
      return { items: searchProfileBuildReferenceCatalog(kind, q, 40), status: 'ready' };
    const rows = await this.prisma.ldaIssueCode.findMany({
      where: {
        OR: [
          { code: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { code: true, name: true },
      take: 40,
      orderBy: { code: 'asc' },
    });
    return { items: rows.map((r) => ({ code: r.code, label: r.name })), status: 'ready' };
  }
  private async receipt(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    subject: ProfileSubject,
    id: string,
    action: string,
    digest: string,
  ) {
    const row = await tx.auditLog.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!row) return null;
    const after = asRecord(row.after);
    if (
      row.action !== action ||
      row.actorUserId !== ctx.userId ||
      row.entityId !== subject.id ||
      after.digest !== digest
    )
      throw new ConflictException('Request ID belongs to another command');
    return after.result;
  }
  private writeReceipt(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    subject: ProfileSubject,
    id: string,
    action: string,
    digest: string,
    result: unknown,
  ) {
    return tx.auditLog.create({
      data: {
        id,
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        action,
        entityType: `profile_${subject.kind}`,
        entityId: subject.id,
        after: JSON.parse(JSON.stringify({ digest, result })) as Prisma.InputJsonValue,
      },
    });
  }
  private async effects(effects: ReviewTransaction['afterCommit']) {
    for (const effect of effects) {
      try {
        await effect();
      } catch {
        /* A saved profile remains authoritative when asynchronous indexing is unavailable. */
      }
    }
  }
}
