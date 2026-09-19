import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  normalizeOpportunitySearchCriteria,
  OPPORTUNITY_SOURCES_V2,
  type FundingOpportunityV2ActionCapability,
  type FundingOpportunityV2DateFact,
  type FundingOpportunityV2DetailRecord,
  type FundingOpportunityV2DetailResponse,
  type FundingOpportunityV2DisplayReference,
  type FundingOpportunityV2Destination,
  type FundingOpportunityV2SimilarOpportunity,
  type FundingOpportunityV2SourceClickResponse,
  type OpportunitySearchMode,
  type OpportunitySearchRecordV2,
  type OpportunitySourceV2,
} from '@capiro/shared';
import type { TenantContext } from '@capiro/shared';
import type { CatalogOpportunityRecord } from './funding-opportunity-v2-search.service.js';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { readEnabledFundingSources } from './funding-opportunity-source-access.js';
import {
  FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER,
  type OpportunityClientProfile,
  type OpportunityClientProfileReader,
  type OpportunitySearchContext,
  FundingOpportunityV2SearchService,
} from './funding-opportunity-v2-search.service.js';
import { readSourceSql } from './funding-opportunity-v2-search.sql.js';
import {
  asSourceFactRecord,
  asSourceString,
  readFundingOpportunityV2SourceFacts,
} from './funding-opportunity-v2-source-facts.js';
import { sourceRecordTypeFor } from './funding-opportunity-identity.js';
import { FundingOpportunityV2DecoratorService } from './funding-opportunity-v2-decorator.service.js';
import { OpportunityRequirementService, type RequirementsResponse } from './requirements/opportunity-requirement.service.js';
import { OpportunityTimelineService, type OpportunityTimelineResponse } from './opportunity-timeline.service.js';
import { isFundingOpportunitiesFeatureEnabled, FUNDING_OPPORTUNITIES_DOCUMENTS_FEATURE, FUNDING_OPPORTUNITIES_NOTICE_HISTORY_FEATURE } from './funding-opportunities-flag.guard.js';

export type FundingOpportunityV2DetailContext = Pick<TenantContext, 'tenantId' | 'userId' | 'role'>;

type FundingOpportunityV2DetailRecordWithoutDecoration = Omit<FundingOpportunityV2DetailRecord, 'decoration'>;

function capability(allowed: boolean, reason: string): FundingOpportunityV2ActionCapability {
  return { allowed, reason };
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
}
function dateOnly(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}
function dateFact(value: string | null, precision: 'date' | 'timestamp' | 'raw' | null, sourceRaw: string | null, reason: string, timezone: string | null = null): FundingOpportunityV2DateFact {
  return { value: value && precision === 'date' ? dateOnly(value) : value, precision, timezone, sourceRaw, unavailableReason: value ? null : reason };
}
function sourceDateFact(value: string | null, sourceRaw: string | null, fallback: 'date' | 'timestamp' | 'raw', reason: string): FundingOpportunityV2DateFact {
  const raw = sourceRaw?.trim() ?? null;
  if (!value && !raw) return dateFact(null, null, sourceRaw, reason);
  const zone = raw?.match(/\b(EDT|EST|PDT|PST|UTC)\b/i)?.[1]?.toUpperCase() ?? raw?.match(/([+-]\d{2}:?\d{2})$/)?.[1] ?? null;
  if (zone) {
    const offset = ({ EDT: '-04:00', EST: '-05:00', PDT: '-07:00', PST: '-08:00', UTC: '+00:00' } as Record<string, string>)[zone] ?? zone;
    const parsed = Date.parse(raw!.replace(/\b(EDT|EST|PDT|PST|UTC)\b/i, offset));
    return Number.isFinite(parsed) ? dateFact(new Date(parsed).toISOString(), 'raw', raw, reason, zone) : dateFact(raw, 'raw', raw, reason, zone);
  }
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return dateFact(raw, 'date', raw, reason);
  if (raw && /\dT\d|\d:\d/.test(raw)) return dateFact(raw, 'raw', raw, reason);
  return dateFact(value ?? raw, value ? fallback : 'raw', raw, reason);
}
function https(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
function email(value: unknown): string | null {
  const candidate = text(value);
  return candidate && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}
function modelFor(source: OpportunitySourceV2, facts: Record<string, unknown>): string {
  if (source === 'sbir_sttr') return asSourceString(facts.provenance) === 'tango_sbir_solicitation' ? 'tango_sbir_solicitation' : 'tango_sbir_topic';
  return source === 'grants_gov' ? 'federal_grant' : source === 'sam_gov' ? 'sam_opportunity' : source === 'agency_forecast' ? 'tango_procurement_forecast' : source === 'dibbs' ? 'tango_dibbs_solicitation' : 'california_grant_opportunity';
}
function displayReference(source: OpportunitySourceV2, facts: Awaited<ReturnType<typeof readFundingOpportunityV2SourceFacts>>): FundingOpportunityV2DisplayReference | null {
  const raw = facts.sourceFacts;
  const candidates: Record<OpportunitySourceV2, [string, string, string][]> = {
    grants_gov: [['Opportunity number', 'opportunityNumber', 'Grants.gov opportunityNumber']],
    sam_gov: [['Solicitation number', 'solicitationNumber', 'SAM solicitationNumber']],
    agency_forecast: [['Forecast reference', 'externalId', 'forecast externalId']],
    dibbs: [['Solicitation', 'solicitation', 'DIBBS solicitation']],
    sbir_sttr: [['Topic number', 'topicNumber', 'SBIR topicNumber'], ['Solicitation number', 'solicitationNumber', 'SBIR solicitationNumber']],
    ca_portal: [['Portal ID', 'portalId', 'California PortalID']],
  };
  for (const [label, key, sourceField] of candidates[source]) {
    const value = text(raw[key]);
    if (value) return { label, value, sourceField };
  }
  return null;
}

@Injectable()
export class FundingOpportunityV2DetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly searchService: FundingOpportunityV2SearchService,
    @Inject(FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER)
    private readonly profiles: OpportunityClientProfileReader,
    private readonly decorator: FundingOpportunityV2DecoratorService,
    private readonly requirements: OpportunityRequirementService,
    private readonly timeline: OpportunityTimelineService,
  ) {}

  async readDetail(
    context: FundingOpportunityV2DetailContext,
    source: string,
    sourceRecordId: string,
    clientId: string | null,
    mode: OpportunitySearchMode = 'all',
  ): Promise<FundingOpportunityV2DetailResponse> {
    const sourceValue = this.assertSource(source);
    if (mode === 'matched' && !clientId) throw new BadRequestException('Matched detail requires clientId.');
    const id = sourceRecordId.trim();
    if (!id) throw new NotFoundException('Opportunity not found.');
    await this.assertSourceEnabled(context.tenantId, sourceValue);
    const profile = await this.readProfile(context, clientId);
    const criteria = normalizeOpportunitySearchCriteria({
      mode, clientId: clientId ?? undefined,
      sources: [sourceValue], lifecycle: [], page: 1, pageSize: 1,
    }).criteria;
    const result = await readSourceSql(this.prisma, sourceValue, { ...criteria, pageSize: 2 }, profile, id);
    if (sourceValue === 'sbir_sttr' && result.records.length > 1) throw new BadRequestException('This SBIR identifier is ambiguous across topic and solicitation records.');
    const row = result.records[0] as CatalogOpportunityRecord | undefined;
    if (!row) throw new NotFoundException('Opportunity not found.');
    const facts = await readFundingOpportunityV2SourceFacts(this.prisma, sourceValue, id, asSourceFactRecord(row.sourceFacts));
    const destinations = this.destinations(sourceValue, row, facts);
    const similarResult = await this.similar(context, row, clientId, profile);
    const similarOpportunities = similarResult.items;
    const documentsEnabled = sourceValue === 'sam_gov' && await this.featureEnabled(context.tenantId, FUNDING_OPPORTUNITIES_DOCUMENTS_FEATURE);
    const noticeHistoryEnabled = sourceValue === 'sam_gov' && await this.featureEnabled(context.tenantId, FUNDING_OPPORTUNITIES_NOTICE_HISTORY_FEATURE);
    const requirements = documentsEnabled
      ? await this.requirements.getRequirements(context.tenantId, sourceValue, id)
      : null;
    const noticeTimeline = noticeHistoryEnabled
      ? await this.timeline.getTimeline(sourceValue, id)
      : null;
    const undecorated = this.detailRecord(row, facts, destinations, similarOpportunities, similarResult.unavailableReason, clientId, mode, requirements, noticeTimeline, documentsEnabled, noticeHistoryEnabled);
    const [decorated] = await this.decorator.decorate([undecorated], {
      tenantId: context.tenantId,
      actorUserId: context.userId,
      clientId,
    });
    if (!decorated?.decoration) throw new Error('Detail decoration did not produce a record.');
    const opportunity: FundingOpportunityV2DetailRecord = {
      ...undecorated,
      decoration: decorated.decoration,
      workflow: {
        available: decorated.decoration.workflow.available,
        status: decorated.decoration.workflow.status,
        humanDecision: decorated.decoration.workflow.humanDecision,
        unavailableReason: decorated.decoration.workflow.unavailableReason,
      },
      capabilities: {
        ...undecorated.capabilities,
        pursue: decorated.decoration.capabilities.pursue,
        save: decorated.decoration.capabilities.save,
      },
    };
    return {
      opportunity,
      generatedAt: new Date().toISOString(),
      source: sourceValue,
      sourceRecordId: id,
      authoritativeSourceUrl: destinations.find((destination) => destination.kind === 'source_page')?.authoritativeUrl ?? null,
    };
  }

  async auditSourceClick(
    context: FundingOpportunityV2DetailContext,
    input: { source: string; sourceRecordId: string; clientId: string | null; destinationKind: string },
  ): Promise<FundingOpportunityV2SourceClickResponse> {
    const resolved = await this.readExact(context, input.source, input.sourceRecordId, input.clientId);
    const destination = this.destinations(resolved.source, resolved.row, resolved.facts)
      .find((item) => item.kind === input.destinationKind);
    if (!destination) throw new BadRequestException('The requested source destination is unavailable.');
    const clickedAt = new Date().toISOString();
    await this.prisma.withTenant(context.tenantId, async (tx) => {
      await tx.auditLog.create({
        data: {
          tenantId: context.tenantId,
          actorUserId: context.userId,
          actorRole: context.role,
          action: 'funding_opportunity.source_click',
          entityType: 'funding_opportunity_v2',
          entityId: `${input.source}:${input.sourceRecordId}`,
          after: {
            source: input.source,
            sourceRecordId: input.sourceRecordId,
            clientId: input.clientId,
            destinationKind: destination.kind,
            authoritativeUrl: destination.authoritativeUrl,
            clickedAt,
          } as Prisma.InputJsonValue,
        },
      });
    });
    return { audited: true, authoritativeUrl: destination.authoritativeUrl };
  }

  private async featureEnabled(tenantId: string, feature: string): Promise<boolean> {
    try {
      return await isFundingOpportunitiesFeatureEnabled(this.prisma, tenantId, feature);
    } catch {
      return false;
    }
  }

  private async assertSourceEnabled(tenantId: string, source: OpportunitySourceV2): Promise<void> {
    const enabled = await readEnabledFundingSources(this.prisma, tenantId);
    if (!enabled.includes(source)) throw new NotFoundException('Opportunity not found.');
  }

  private async readExact(
    context: FundingOpportunityV2DetailContext,
    source: string,
    sourceRecordId: string,
    clientId: string | null,
  ): Promise<{ source: OpportunitySourceV2; row: CatalogOpportunityRecord; facts: Awaited<ReturnType<typeof readFundingOpportunityV2SourceFacts>> }> {
    const sourceValue = this.assertSource(source);
    const id = sourceRecordId.trim();
    if (!id) throw new NotFoundException('Opportunity not found.');
    await this.assertSourceEnabled(context.tenantId, sourceValue);
    const profile = await this.readProfile(context, clientId);
    const criteria = normalizeOpportunitySearchCriteria({ mode: 'all', clientId: clientId ?? undefined, sources: [sourceValue], lifecycle: [], page: 1, pageSize: 1 }).criteria;
    const result = await readSourceSql(this.prisma, sourceValue, { ...criteria, pageSize: 2 }, profile, id);
    if (sourceValue === 'sbir_sttr' && result.records.length > 1) throw new BadRequestException('This SBIR identifier is ambiguous across topic and solicitation records.');
    const row = result.records[0] as CatalogOpportunityRecord | undefined;
    if (!row) throw new NotFoundException('Opportunity not found.');
    const facts = await readFundingOpportunityV2SourceFacts(this.prisma, sourceValue, id, asSourceFactRecord(row.sourceFacts));
    return { source: sourceValue, row, facts };
  }

  private async readProfile(context: FundingOpportunityV2DetailContext, clientId: string | null): Promise<OpportunityClientProfile | null> {
    if (!clientId) return null;
    const searchContext: OpportunitySearchContext = { tenantId: context.tenantId, userId: context.userId };
    const visible = await this.profiles.visibleClientIds(searchContext);
    if (!visible.includes(clientId)) throw new NotFoundException('Opportunity not found.');
    const profile = await this.profiles.read(searchContext, clientId);
    if (!profile) throw new NotFoundException('Opportunity not found.');
    return profile;
  }

  private assertSource(source: string): OpportunitySourceV2 {
    if (!OPPORTUNITY_SOURCES_V2.includes(source as OpportunitySourceV2)) throw new NotFoundException('Opportunity not found.');
    return source as OpportunitySourceV2;
  }

  private destinations(source: OpportunitySourceV2, row: OpportunitySearchRecordV2, facts: Awaited<ReturnType<typeof readFundingOpportunityV2SourceFacts>>): FundingOpportunityV2Destination[] {
    const out: FundingOpportunityV2Destination[] = [];
    const page = https(row.sourceUrl);
    if (page) out.push({ kind: 'source_page', label: 'Source page', authoritativeUrl: page });
    const addUrl = (kind: FundingOpportunityV2Destination['kind'], label: string, value: unknown) => {
      const url = https(value);
      if (url && !out.some((item) => item.authoritativeUrl === url)) out.push({ kind, label, authoritativeUrl: url });
    };
    if (source === 'grants_gov') addUrl('document:funding_announcement', 'Funding announcement', facts.sourceFacts.fundingDescLinkUrl ?? facts.raw.fundingDescLinkUrl);
    if (source === 'dibbs') {
      addUrl('document:solicitation', 'Solicitation document', facts.documentUrl);
      addUrl('document:technical_data', 'Technical documents', facts.techDocsUrl);
    }
    if (source === 'sbir_sttr') {
      addUrl('document:topic', 'SBIR/STTR topic', facts.topicUrl);
      addUrl('document:solicitation', 'SBIR/STTR solicitation', facts.officialSolicitationUrl);
      addUrl('document:solicitation_download', 'SBIR/STTR solicitation download', facts.sourceFacts.solDownloadUrl);
    }
    facts.applicationUrls.forEach((url, index) => addUrl(`application:${index + 1}`, `Application destination ${index + 1}`, url));
    facts.applicationEmails.forEach((address, index) => {
      const safe = email(address);
      if (safe) out.push({ kind: `application:email_${index + 1}`, label: `Application email ${index + 1}`, authoritativeUrl: `mailto:${safe}` });
    });
    const contact = email(facts.contactEmail);
    if (contact) out.push({ kind: 'contact_email:primary', label: 'Source contact email', authoritativeUrl: `mailto:${contact}` });
    return out;
  }

  private detailRecord(
    row: CatalogOpportunityRecord,
    facts: Awaited<ReturnType<typeof readFundingOpportunityV2SourceFacts>>,
    destinations: FundingOpportunityV2Destination[],
    similarOpportunities: FundingOpportunityV2SimilarOpportunity[],
    similarOpportunitiesUnavailableReason: string | null,
    clientId: string | null,
    mode: OpportunitySearchMode,
    requirements: RequirementsResponse | null,
    noticeTimeline: OpportunityTimelineResponse | null,
    documentsEnabled: boolean,
    noticeHistoryEnabled: boolean,
  ): FundingOpportunityV2DetailRecordWithoutDecoration {
    const fallbackPrecision = row.source === 'sam_gov' ? 'timestamp' : row.source === 'grants_gov' ? 'raw' : 'date';
    const raw = facts.sourceFacts;
    const postedRaw = text(raw.postingDate) ?? text(raw.postedDate) ?? text(raw.postingDateStr) ?? text(raw.openDateRaw);
    const deadlineRaw = text(raw.responseDate) ?? text(raw.responseDeadLine) ?? text(raw.responseDeadline) ?? text(raw.responseDateStr) ?? text(raw.applicationDeadlineRaw);
    const closeRaw = text(raw.archiveDate) ?? text(raw.applicationDeadlineRaw);
    const anticipated = text(raw.anticipatedAwardDate);
    const sourceUpdatedPrecision = facts.sourceUpdatedPrecision;
    const sourceUpdatedAt = facts.sourceUpdatedAt;
    const contact = facts.contactEmail || facts.contactName || facts.contactPhone || facts.contactDescription ? [{
      key: 'primary', name: facts.contactName, email: facts.contactEmail, phone: facts.contactPhone, description: facts.contactDescription,
    }] : [];
    const hidden = mode === 'all';
    const clientState = row.clientCapability?.state ?? row.eligibility?.state ?? null;
    const clientReason = row.clientCapability?.reason ?? row.eligibility?.reason ?? (clientId ? 'The source did not state enough facts for a client-specific determination.' : null);
    const base = hidden ? { ...row, relevanceScore: null, matchedSignals: [], eligibility: null } : row;
    return {
      ...base,
      sourceFacts: { ...facts.sourceFacts, provenance: asSourceString(facts.sourceFacts.provenance) ?? row.sourceFacts.provenance },
      sourceReference: {
        source: row.source, recordType: sourceRecordTypeFor(row.source, facts.sourceFacts), sourceRecordId: row.sourceRecordId,
        providerRecordId: facts.providerRecordId, sourceUpdatedAt, ingestedAt: facts.ingestedAt,
        sourceUpdatedPrecision, sourceUpdatedRaw: facts.sourceUpdatedRaw,
      },
      displayReference: displayReference(row.source, facts),
      dates: {
        posted: sourceDateFact(row.postedDate, postedRaw, fallbackPrecision, 'The cached source did not state a posting date.'),
        responseDeadline: sourceDateFact(row.deadline, deadlineRaw, fallbackPrecision, 'The cached source did not state a response or application deadline.'),
        closeOrArchive: sourceDateFact(row.closeOrArchiveDate, closeRaw, fallbackPrecision, 'The cached source did not state a close or archive date.'),
        forecast: {
          anticipatedAwardDate: dateFact(anticipated, 'date', anticipated, anticipated ? '' : 'This source is not a forecast or did not state an anticipated award date.'),
          estimatedPeriod: text(raw.estimatedPeriod),
          unavailableReason: row.source === 'agency_forecast' && !anticipated ? 'The forecast source did not state an anticipated award date.' : row.source === 'agency_forecast' ? null : 'Not applicable to this source.',
        },
      },
      scope: { agencies: row.agency ? [row.agency] : [], geography: row.geography, naicsCodes: row.naicsCodes, pscCodes: row.pscCodes, sectors: row.sectors, setAside: row.setAside, content: [
        ...(text(row.summary) ? [{ label: 'Source description', kind: 'source_description', statement: text(row.summary)!, sourceExcerpt: null, sourceDocument: null, sourceField: 'description', sourcePage: null, reviewStatus: null, supersededAt: null }] : []),
        ...(requirements?.requirements ?? []).map((item) => ({ label: item.requirementType.replaceAll('_', ' '), kind: item.requirementType, statement: item.statement, sourceExcerpt: item.sourceExcerpt, sourceDocument: item.fileName, sourceField: 'requirement.sourceExcerpt', sourcePage: item.sourcePage, reviewStatus: item.reviewStatus, supersededAt: item.supersededAt })),
      ], unavailableReason: text(row.summary) || requirements?.requirements.length ? null : requirements?.coverageExplanation ?? (documentsEnabled ? 'The cached source did not provide scope evidence.' : 'Scope requirements are unavailable because the documents feature is disabled.') },
      eligibilityDetail: { applicantTypes: row.applicantTypes, restrictions: [text(raw.eligibilityText), text(raw.applicantEligibilityDesc), text(raw.applicantTypeNotes)].filter((item): item is string => Boolean(item)), sourceText: text(raw.eligibilityText) ?? text(raw.applicantEligibilityDesc), clientState: hidden ? null : clientState, clientReason: hidden ? null : clientReason, unavailableReason: row.applicantTypes.length || raw.eligibilityText || raw.applicantEligibilityDesc ? null : 'The cached source did not state eligibility facts.' },
      evaluation: { criteria: text(raw.evaluationCriteria) ?? text(raw.evaluation), costShare: row.costShare, prerequisites: row.grantPrerequisites, awardCategory: text(raw.category) ?? (raw.opportunityCategory && typeof raw.opportunityCategory === 'object' && !Array.isArray(raw.opportunityCategory) ? text((raw.opportunityCategory as Record<string, unknown>).description) : text(raw.opportunityCategory)), unavailableReason: null },
      responseInstructions: (() => { const responseRequirements = (requirements?.requirements ?? []).filter((item) => ['submission', 'question_deadline', 'key_date'].includes(item.requirementType)); return { steps: responseRequirements.map((item) => item.statement), details: responseRequirements.map((item) => ({ label: item.requirementType.replaceAll('_', ' '), kind: item.requirementType, statement: item.statement, sourceExcerpt: item.sourceExcerpt, sourceDocument: item.fileName, sourceField: 'requirement.sourceExcerpt', sourcePage: item.sourcePage, reviewStatus: item.reviewStatus, supersededAt: item.supersededAt })), unavailableReason: responseRequirements.length ? null : requirements?.coverageExplanation ?? 'The cached source did not provide typed response instructions.' }; })(),
      activity: (noticeTimeline?.entries ?? []).map((entry) => ({ kind: 'notice_history', statement: entry.title ?? 'Notice history entry', sourceExcerpt: entry.changes.map((change) => change.summary).join(' ') || null, sourceDocument: null, sourceField: 'timeline.entries', sourcePage: null, reviewStatus: null, supersededAt: null, occurredAt: entry.postedDate, title: entry.title, severity: entry.changes[0]?.severity ?? null, changedDimensions: entry.changes.map((change) => change.dimension), sourceUrl: entry.sourceUrl })),
      activityCoverage: noticeTimeline?.coverageExplanation ?? (noticeHistoryEnabled ? 'Notice history has no available entries for this solicitation.' : 'Notice history is unavailable because the notice-history feature is disabled.'),
      destinations,
      documents: destinations.filter((item) => item.kind.startsWith('document:')).map((item) => ({ key: item.kind.slice('document:'.length), label: item.label, url: item.authoritativeUrl, documentType: item.kind.slice('document:'.length) })),
      contacts: contact,
      changeNotes: facts.changeNotes ? [{ key: 'source', text: facts.changeNotes, occurredAt: sourceUpdatedAt }] : [],
      provenance: { sourceModel: modelFor(row.source, facts.sourceFacts), cached: true, sourceFacts: facts.sourceFacts, unavailableReason: null },
      similarOpportunities,
      similarOpportunitiesUnavailableReason,
      workflow: { available: false, status: null, humanDecision: null, unavailableReason: 'Workflow state is unavailable for this detail view.' },

      capabilities: {
        view: capability(true, 'The source record is visible to this tenant.'),
        sourceClick: capability(destinations.length > 0, destinations.length > 0 ? 'An allowlisted source destination is available.' : 'The source did not provide an allowlisted destination.'),
        pursue: capability(Boolean(clientId) && row.isPursuable && (row.clientCapability?.allowed ?? false), row.clientCapability?.reason ?? (!clientId ? 'A visible client is required before pursuit can be evaluated.' : 'The source is not currently pursuable.')),
        save: capability(true, 'This source record can be bookmarked independently of workflow.'),
        submit: capability(false, 'Submission is not available from this detail view.'),
      },
    };
  }

  private async similar(context: FundingOpportunityV2DetailContext, row: CatalogOpportunityRecord, clientId: string | null, profile: OpportunityClientProfile | null): Promise<{ items: FundingOpportunityV2SimilarOpportunity[]; unavailableReason: string | null }> {
    const exactCodes = row.codes.slice(0, 4);
    const agency = row.agency ? [row.agency] : [];
    const geography = row.geography.slice(0, 2);
    if (!exactCodes.length && !agency.length && !geography.length) return { items: [], unavailableReason: null };
    try {
      const criteria = normalizeOpportunitySearchCriteria({ mode: profile ? 'matched' : 'all', clientId: clientId ?? undefined, sources: [...OPPORTUNITY_SOURCES_V2], lifecycle: [], codes: exactCodes, agencies: agency, geography, page: 1, pageSize: 8, sort: 'relevance' }).criteria;
      const result = await this.searchService.search({ tenantId: context.tenantId, userId: context.userId }, criteria);
      return { items: result.opportunities.filter((candidate) => candidate.id !== row.id).slice(0, 5).map((candidate) => {
        const candidateCodes = [...list(candidate.sourceFacts.codes), ...candidate.naicsCodes, ...candidate.pscCodes, ...list(candidate.sourceFacts.naicsCode), ...list(candidate.sourceFacts.pscCode)];
        const matchedOn = [
          candidateCodes.some((code) => exactCodes.includes(code)) ? 'exact_code' : null,
          agency.length && candidate.agency === row.agency ? 'agency' : null,
          geography.some((value) => candidate.geography.includes(value)) ? 'geography' : null,
        ].filter((value): value is string => Boolean(value));
        return { source: candidate.source, sourceRecordId: candidate.sourceRecordId, title: candidate.title, agency: candidate.agency, sourceUrl: candidate.sourceUrl, type: candidate.type, deadline: candidate.deadline, similarity: matchedOn.includes('exact_code') ? 'strong' : matchedOn.length > 1 ? 'moderate' : 'weak', matchedOn };
      }), unavailableReason: null };
    } catch {
      return { items: [], unavailableReason: 'Similar opportunities are temporarily unavailable.' };
    }
  }
}
