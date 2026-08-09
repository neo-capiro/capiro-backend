import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { CapabilityAuthorizationService } from '../capability-authorization.service.js';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import { CapabilityError } from '../capability-errors.js';
import { OutreachTargetReferenceService } from '../targets/outreach-target-reference.service.js';
import {
  createResolvedContextRefV1,
  normalizeContextSelectionV1,
  normalizeResolvedContextRefsV1,
  type OutreachContextClass,
  type OutreachContextLocatorV1,
  type OutreachContextScopeV1,
  type OutreachContextSelectionV1,
  type OutreachContextSensitivity,
  type OutreachContextVerificationClass,
  type OutreachResolvedContextRefV1,
} from './outreach-context.contract.js';

interface MemoryContextRow {
  id: string;
  client_id: string | null;
  owner_user_id: string | null;
  visibility: string;
  title: string;
  type: string;
  sections_jsonb: unknown;
  status: string;
  sensitivity: string | null;
  instructions_allowed: boolean | null;
  source_type: string | null;
  source_version: string | null;
  source_excerpt: string | null;
  governed_status: string | null;
  memory_authority: string | null;
  conflict_status: string | null;
  as_of: Date | null;
  valid_until: Date | null;
  updated_at: Date;
}

interface ResolvedSourceContext {
  title: string;
  summary: string;
  clientId: string | null;
  verificationClass: OutreachContextVerificationClass;
  sensitivity: OutreachContextSensitivity;
  instructionsAllowed: boolean;
  usableAsEvidence: boolean;
  sourceSystem: string;
  sourceVersion: string | null;
  lastVerifiedAt: string | null;
}

@Injectable()
export class OutreachContextReferenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: CapabilityAuthorizationService,
    private readonly targetReferences: OutreachTargetReferenceService,
  ) {}

  async resolveMany(
    ctx: TenantContext,
    selections: readonly unknown[],
  ): Promise<OutreachResolvedContextRefV1[]> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.resolveManyWithinTx(tx, ctx, selections),
    );
  }

  async resolveManyWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    rawSelections: readonly unknown[],
  ): Promise<OutreachResolvedContextRefV1[]> {
    const resolved: OutreachResolvedContextRefV1[] = [];
    for (const input of rawSelections) {
      resolved.push(await this.resolveOneWithinTx(tx, ctx, normalizeContextSelectionV1(input)));
    }
    return normalizeResolvedContextRefsV1(resolved);
  }

  async resolveOne(
    ctx: TenantContext,
    selection: unknown,
  ): Promise<OutreachResolvedContextRefV1> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.resolveOneWithinTx(tx, ctx, normalizeContextSelectionV1(selection)),
    );
  }

  async reauthorizeSnapshotsWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    snapshots: readonly OutreachResolvedContextRefV1[],
  ): Promise<void> {
    for (const snapshot of snapshots) {
      await this.resolveOneWithinTx(tx, ctx, {
        locator: snapshot.locator,
        contextClass: snapshot.contextClass,
        scope: snapshot.scope,
      });
    }
  }

  async resolveOneWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    selection: OutreachContextSelectionV1,
  ): Promise<OutreachResolvedContextRefV1> {
    const source = await this.resolveSource(tx, ctx, selection.locator, selection.scope);
    this.assertClassCompatibility(selection.contextClass, selection.scope, source, selection.locator);
    return createResolvedContextRefV1({
      locator: selection.locator,
      contextClass: selection.contextClass,
      scope: selection.scope,
      title: source.title,
      summary: source.summary,
      clientId: source.clientId,
      verificationClass: source.verificationClass,
      sensitivity: source.sensitivity,
      instructionsAllowed:
        selection.contextClass === 'writing_guidance' ? source.instructionsAllowed : false,
      usableAsEvidence:
        selection.contextClass !== 'writing_guidance' && source.usableAsEvidence,
      usableAsWritingGuidance:
        selection.contextClass === 'writing_guidance' && source.instructionsAllowed,
      sourceSnapshot: {
        system: source.sourceSystem,
        version: source.sourceVersion,
        lastVerifiedAt: source.lastVerifiedAt,
      },
    });
  }

  private async resolveSource(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    locator: OutreachContextLocatorV1,
    scope: OutreachContextScopeV1,
  ): Promise<ResolvedSourceContext> {
    switch (locator.source) {
      case 'memory_item':
        return this.resolveMemory(tx, ctx, locator);
      case 'capiro_record':
        return this.resolveCapiroRecord(tx, ctx, locator);
      case 'document':
        return this.resolveDocument(tx, ctx, locator);
      case 'government_record':
        return this.resolveGovernmentRecord(tx, locator);
      case 'target_profile_fact':
        return this.resolveTargetFact(tx, ctx, locator, scope);
      case 'manual':
        return {
          title: locator.title,
          summary: locator.text,
          clientId: null,
          verificationClass: 'user_supplied',
          sensitivity: 'normal',
          instructionsAllowed: true,
          usableAsEvidence: false,
          sourceSystem: locator.sourceLabel ?? 'user_supplied',
          sourceVersion: null,
          lastVerifiedAt: null,
        };
    }
  }

  private async resolveMemory(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    locator: Extract<OutreachContextLocatorV1, { source: 'memory_item' }>,
  ): Promise<ResolvedSourceContext> {
    const rows = await tx.$queryRaw<MemoryContextRow[]>`
      SELECT id, client_id, owner_user_id, visibility, title, type, sections_jsonb,
             status, sensitivity, instructions_allowed, source_type,
             source_version, source_excerpt, governed_status, memory_authority,
             conflict_status, as_of, valid_until, updated_at
      FROM memory_items
      WHERE tenant_id = ${ctx.tenantId}::uuid
        AND id = ${locator.id}::uuid
        AND status NOT IN ('revoked', 'rejected', 'withdrawn')
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `;
    const row = rows[0];
    if (!row || (row.visibility === 'user' && row.owner_user_id !== ctx.userId)) {
      throw contextNotFound();
    }
    if (locator.clientId !== null && row.client_id !== locator.clientId) throw contextNotFound();
    if (row.client_id && !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, row.client_id))) {
      throw contextNotFound();
    }
    const approved = ['approved', 'active'].includes(row.governed_status ?? row.status);
    const conflicted = Boolean(row.conflict_status && row.conflict_status !== 'none');
    const expired = row.valid_until ? row.valid_until.getTime() < Date.now() : false;
    return {
      title: row.title,
      summary: memorySummary(row),
      clientId: row.client_id,
      verificationClass: memoryVerificationClass(row),
      sensitivity: normalizeSensitivity(row.sensitivity),
      instructionsAllowed: Boolean(row.instructions_allowed),
      usableAsEvidence: approved && !conflicted && !expired,
      sourceSystem: row.source_type ?? 'capiro_memory',
      sourceVersion: row.source_version ?? row.updated_at.toISOString(),
      lastVerifiedAt: (row.as_of ?? row.updated_at).toISOString(),
    };
  }

  private async resolveCapiroRecord(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    locator: Extract<OutreachContextLocatorV1, { source: 'capiro_record' }>,
  ): Promise<ResolvedSourceContext> {
    if (locator.recordType === 'client') {
      const client = await this.authorizeClient(tx, ctx, locator.id);
      if (locator.clientId !== null && locator.clientId !== client.id) throw contextNotFound();
      return {
        title: client.name,
        summary: boundedSummary([client.description, client.website, client.sectorTag]),
        clientId: client.id,
        verificationClass: 'first_party',
        sensitivity: 'confidential',
        instructionsAllowed: false,
        usableAsEvidence: true,
        sourceSystem: 'capiro_client',
        sourceVersion: client.updatedAt.toISOString(),
        lastVerifiedAt: client.updatedAt.toISOString(),
      };
    }

    if (locator.recordType === 'meeting') {
      const row = await tx.meeting.findFirst({
        where: {
          id: locator.id,
          tenantId: ctx.tenantId,
          OR: [{ visibility: 'shared' }, { createdByUserId: ctx.userId }],
        },
        select: {
          clientId: true,
          subject: true,
          description: true,
          location: true,
          startsAt: true,
          endsAt: true,
          status: true,
          updatedAt: true,
        },
      });
      if (!row || (locator.clientId !== null && row.clientId !== locator.clientId)) {
        throw contextNotFound();
      }
      if (row.clientId) await this.authorizeClient(tx, ctx, row.clientId);
      return {
        title: row.subject,
        summary: boundedSummary([
          row.description,
          row.location,
          `${row.startsAt.toISOString()} — ${row.endsAt.toISOString()}`,
          `Status: ${row.status}`,
        ]),
        clientId: row.clientId,
        verificationClass: 'first_party',
        sensitivity: 'confidential',
        instructionsAllowed: false,
        usableAsEvidence: true,
        sourceSystem: 'capiro_meeting',
        sourceVersion: row.updatedAt.toISOString(),
        lastVerifiedAt: row.updatedAt.toISOString(),
      };
    }

    const row = await tx.engagementTask.findFirst({
      where: { id: locator.id, tenantId: ctx.tenantId },
      select: {
        clientId: true,
        title: true,
        description: true,
        dueDate: true,
        status: true,
        updatedAt: true,
      },
    });
    if (!row || (locator.clientId !== null && row.clientId !== locator.clientId)) {
      throw contextNotFound();
    }
    if (row.clientId) await this.authorizeClient(tx, ctx, row.clientId);
    return {
      title: row.title,
      summary: boundedSummary([
        row.description,
        row.dueDate ? `Due: ${row.dueDate.toISOString().slice(0, 10)}` : null,
        `Status: ${row.status}`,
      ]),
      clientId: row.clientId,
      verificationClass: 'first_party',
      sensitivity: 'confidential',
      instructionsAllowed: false,
      usableAsEvidence: true,
      sourceSystem: 'capiro_engagement_task',
      sourceVersion: row.updatedAt.toISOString(),
      lastVerifiedAt: row.updatedAt.toISOString(),
    };
  }

  private async resolveDocument(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    locator: Extract<OutreachContextLocatorV1, { source: 'document' }>,
  ): Promise<ResolvedSourceContext> {
    const row = await tx.engagementAttachment.findFirst({
      where: {
        id: locator.id,
        tenantId: ctx.tenantId,
        lifecycleStatus: { in: ['ready', 'legacy_ready'] },
        supersededByAttachmentId: null,
      },
      select: {
        clientId: true,
        fileName: true,
        contentType: true,
        source: true,
        sourceEntityType: true,
        sourceEntityId: true,
        calculatedSha256: true,
        indexedAt: true,
        extractionStatus: true,
        approvedAt: true,
        sharedAt: true,
        createdAt: true,
      },
    });
    if (!row || (locator.clientId !== null && row.clientId !== locator.clientId)) {
      throw contextNotFound();
    }
    if (row.clientId) await this.authorizeClient(tx, ctx, row.clientId);
    return {
      title: row.fileName,
      summary: boundedSummary([
        `Document: ${row.fileName}`,
        `Content type: ${row.contentType}`,
        row.sourceEntityType ? `Source type: ${row.sourceEntityType}` : null,
        row.sourceEntityId ? `Source record: ${row.sourceEntityId}` : null,
        row.extractionStatus ? `Extraction: ${row.extractionStatus}` : null,
        row.indexedAt ? `Indexed: ${row.indexedAt.toISOString()}` : null,
      ]),
      clientId: row.clientId,
      verificationClass: row.approvedAt ? 'first_party' : 'unverified',
      sensitivity: row.clientId ? 'confidential' : 'normal',
      instructionsAllowed: false,
      usableAsEvidence: Boolean(row.approvedAt || row.sharedAt),
      sourceSystem: row.source || 'capiro_document',
      sourceVersion: row.calculatedSha256 ?? row.createdAt.toISOString(),
      lastVerifiedAt: (row.approvedAt ?? row.indexedAt ?? row.createdAt).toISOString(),
    };
  }

  private async resolveGovernmentRecord(
    tx: Prisma.TransactionClient,
    locator: Extract<OutreachContextLocatorV1, { source: 'government_record' }>,
  ): Promise<ResolvedSourceContext> {
    const record = await governmentRecord(tx, locator.category, locator.id);
    if (!record) throw contextNotFound();
    return {
      title: record.title,
      summary: record.summary,
      clientId: null,
      verificationClass: 'authoritative',
      sensitivity: 'normal',
      instructionsAllowed: false,
      usableAsEvidence: true,
      sourceSystem: record.sourceSystem,
      sourceVersion: record.version,
      lastVerifiedAt: record.lastVerifiedAt,
    };
  }

  private async resolveTargetFact(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    locator: Extract<OutreachContextLocatorV1, { source: 'target_profile_fact' }>,
    scope: OutreachContextScopeV1,
  ): Promise<ResolvedSourceContext> {
    const target = await this.targetReferences.resolveOneWithinTx(tx, ctx, locator.targetRef);
    if (scope.kind !== 'target' || scope.targetKey !== target.targetKey) throw contextNotFound();
    const fact = targetFact(target, locator.factCode);
    if (!fact) throw contextNotFound();
    return {
      title: fact.title,
      summary: fact.summary,
      clientId: target.clientId,
      verificationClass:
        target.sourceSnapshot.system === 'capiro_directory'
          ? 'authoritative'
          : target.sourceSnapshot.system === 'user_supplied'
            ? 'user_supplied'
            : 'first_party',
      sensitivity: target.clientId ? 'confidential' : 'normal',
      instructionsAllowed: false,
      usableAsEvidence:
        target.roleStatus === 'current' && target.sourceSnapshot.system !== 'user_supplied',
      sourceSystem: target.sourceSnapshot.system,
      sourceVersion: target.sourceSnapshot.version,
      lastVerifiedAt: target.sourceSnapshot.lastVerifiedAt,
    };
  }

  private assertClassCompatibility(
    contextClass: OutreachContextClass,
    scope: OutreachContextScopeV1,
    source: ResolvedSourceContext,
    locator: OutreachContextLocatorV1,
  ): void {
    if (contextClass === 'writing_guidance' && !source.instructionsAllowed) {
      throw new CapabilityError(
        'CAPABILITY_INVALID_INPUT',
        'The selected source is not authorized to provide writing instructions.',
      );
    }
    if (contextClass === 'required_policy' && !source.usableAsEvidence) {
      throw new CapabilityError(
        'CAPABILITY_INVALID_INPUT',
        'Required policy must come from a verified source.',
      );
    }
    if (contextClass === 'target_specific' && scope.kind !== 'target') {
      throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'Target-specific context needs target scope.');
    }
    if (contextClass === 'group_safe') {
      if (scope.kind !== 'group' || source.sensitivity !== 'normal') {
        throw new CapabilityError(
          'CAPABILITY_INVALID_INPUT',
          'Group-safe context must be normal-sensitivity and explicitly group-scoped.',
        );
      }
      if (locator.source === 'target_profile_fact') {
        throw new CapabilityError(
          'CAPABILITY_INVALID_INPUT',
          'Target-specific profile facts cannot be promoted to group-safe context.',
        );
      }
    }
  }

  private async authorizeClient(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string,
  ) {
    const capabilityCtx: AuthorizedCapabilityContext = {
      actorUserId: ctx.userId,
      clerkUserId: ctx.clerkUserId,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      role: ctx.role,
      clientScope: null,
      impersonation: null,
      requestId: `outreach-context:${clientId}`,
      surface: 'outreach',
    };
    try {
      return await this.authorization.authorizeClientWithinTx(tx, capabilityCtx, clientId);
    } catch (error) {
      if (error instanceof CapabilityError) throw contextNotFound();
      throw error;
    }
  }
}

function memorySummary(row: MemoryContextRow): string {
  if (row.source_excerpt?.trim()) return row.source_excerpt.trim().slice(0, 12_000);
  return jsonText(row.sections_jsonb).slice(0, 12_000) || `${row.type}: ${row.title}`;
}

function memoryVerificationClass(row: MemoryContextRow): OutreachContextVerificationClass {
  if (row.memory_authority === 'authoritative') return 'authoritative';
  if (row.governed_status === 'approved') return 'first_party';
  if (row.governed_status === 'proposed' || row.governed_status === 'pending') return 'unverified';
  return 'derived';
}

function normalizeSensitivity(value: string | null): OutreachContextSensitivity {
  if (value === 'restricted' || value === 'high') return 'restricted';
  if (value === 'confidential') return 'confidential';
  return 'normal';
}

function boundedSummary(values: Array<string | null | undefined>): string {
  const value = values.filter((entry): entry is string => Boolean(entry?.trim())).join('\n');
  return (value || 'No additional source summary is available.').slice(0, 12_000);
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(jsonText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map(jsonText)
      .filter(Boolean)
      .join('\n');
  }
  return value == null ? '' : String(value);
}

function contextNotFound(): CapabilityError {
  return new CapabilityError(
    'CAPABILITY_NOT_FOUND',
    'The requested context was not found in the authorized scope.',
  );
}

interface GovernmentRecordSnapshot {
  title: string;
  summary: string;
  sourceSystem: string;
  version: string | null;
  lastVerifiedAt: string | null;
}

async function governmentRecord(
  tx: Prisma.TransactionClient,
  category: Extract<OutreachContextLocatorV1, { source: 'government_record' }>['category'],
  id: string,
): Promise<GovernmentRecordSnapshot | null> {
  switch (category) {
    case 'bill': {
      const row = await tx.congressBill.findUnique({
        where: { id },
        select: {
          billNumber: true,
          title: true,
          sponsorName: true,
          latestActionDate: true,
        },
      });
      return row
        ? gov(
            `${row.billNumber} — ${row.title}`,
            [row.sponsorName, dateLabel(row.latestActionDate)],
            'congress.gov',
            row.latestActionDate,
          )
        : null;
    }
    case 'award': {
      const row = await tx.federalAward.findUnique({
        where: { id },
        select: { contractorName: true, awardingAgency: true, awardedAt: true },
      });
      return row
        ? gov(
            row.contractorName ?? 'Federal award',
            [row.awardingAgency, dateLabel(row.awardedAt)],
            'usaspending.gov',
            row.awardedAt,
          )
        : null;
    }
    case 'lda_filing': {
      const row = await tx.ldaFiling.findUnique({
        where: { id },
        select: { clientName: true, registrantName: true, dtPosted: true },
      });
      return row
        ? gov(
            row.clientName || row.registrantName || 'LDA filing',
            [row.registrantName, dateLabel(row.dtPosted)],
            'lda.senate.gov',
            row.dtPosted,
          )
        : null;
    }
    case 'hearing': {
      const row = await tx.committeeHearing.findUnique({
        where: { id },
        select: { title: true, committeeName: true, date: true },
      });
      return row
        ? gov(row.title, [row.committeeName, dateLabel(row.date)], 'congress.gov', row.date)
        : null;
    }
    case 'sec_filing': {
      const row = await tx.secFiling.findUnique({
        where: { id },
        select: { companyName: true, filingDate: true },
      });
      return row
        ? gov(row.companyName, ['SEC filing', dateLabel(row.filingDate)], 'sec.gov', row.filingDate)
        : null;
    }
    case 'fara_registration': {
      const row = await tx.faraRegistration.findUnique({
        where: { id },
        select: { registrantName: true, registrationDate: true },
      });
      return row
        ? gov(
            row.registrantName,
            ['FARA registration', dateLabel(row.registrationDate)],
            'justice.gov/fara',
            row.registrationDate,
          )
        : null;
    }
    case 'gao_report': {
      const row = await tx.gaoReport.findUnique({
        where: { id },
        select: { id: true, title: true, publishDate: true },
      });
      return row
        ? gov(`${row.id} — ${row.title}`, [dateLabel(row.publishDate)], 'gao.gov', row.publishDate)
        : null;
    }
    case 'crs_report': {
      const row = await tx.crsReport.findUnique({
        where: { id },
        select: { id: true, title: true, date: true },
      });
      return row
        ? gov(
            `${row.id} — ${row.title}`,
            [dateLabel(row.date)],
            'crsreports.congress.gov',
            row.date,
          )
        : null;
    }
    case 'regulatory_docket': {
      const row = await tx.regulatoryDocket.findUnique({
        where: { id },
        select: { title: true, postedDate: true },
      });
      return row
        ? gov(row.title, ['Regulatory docket', dateLabel(row.postedDate)], 'regulations.gov', row.postedDate)
        : null;
    }
    case 'intel_article': {
      const row = await tx.intelArticle.findUnique({
        where: { id },
        select: { title: true, summary: true, publishedAt: true },
      });
      return row
        ? gov(
            row.title,
            [row.summary, dateLabel(row.publishedAt)],
            'capiro_intelligence',
            row.publishedAt,
          )
        : null;
    }
    case 'state_bill': {
      const row = await tx.stateBill.findUnique({
        where: { id },
        select: { title: true, sponsorName: true, latestActionDate: true },
      });
      return row
        ? gov(
            row.title,
            [row.sponsorName, dateLabel(row.latestActionDate)],
            'legiscan',
            row.latestActionDate,
          )
        : null;
    }
    case 'federal_register': {
      const row = await tx.federalRegisterDocument.findUnique({
        where: { id },
        select: { documentNumber: true, title: true, publicationDate: true },
      });
      return row
        ? gov(
            row.title,
            [row.documentNumber, dateLabel(row.publicationDate)],
            'federalregister.gov',
            row.publicationDate,
          )
        : null;
    }
  }
}

function gov(
  title: string,
  summary: Array<string | null | undefined>,
  sourceSystem: string,
  sourceDate: Date | null,
): GovernmentRecordSnapshot {
  const timestamp = sourceDate?.toISOString() ?? null;
  return {
    title: title.slice(0, 320),
    summary: boundedSummary(summary),
    sourceSystem,
    version: timestamp,
    lastVerifiedAt: timestamp,
  };
}

function dateLabel(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function targetFact(
  target: Awaited<ReturnType<OutreachTargetReferenceService['resolveOneWithinTx']>>,
  factCode: string,
): { title: string; summary: string } | null {
  switch (factCode) {
    case 'current_role':
      return {
        title: `${target.displayName} — current role`,
        summary: boundedSummary([target.title, target.organization, `Role status: ${target.roleStatus}`]),
      };
    case 'jurisdiction':
      return {
        title: `${target.displayName} — jurisdiction`,
        summary: boundedSummary([
          target.jurisdiction.governmentLevel,
          target.jurisdiction.chamber,
          target.jurisdiction.state,
          target.jurisdiction.district,
        ]),
      };
    case 'committees':
      return target.jurisdiction.committees.length
        ? {
            title: `${target.displayName} — committees`,
            summary: target.jurisdiction.committees.join(', '),
          }
        : null;
    case 'issue_areas':
      return target.jurisdiction.issueAreas.length
        ? {
            title: `${target.displayName} — issue areas`,
            summary: target.jurisdiction.issueAreas.join(', '),
          }
        : null;
    default:
      return null;
  }
}
