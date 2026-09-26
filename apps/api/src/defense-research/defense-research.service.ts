import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  DefenseContextDocumentDetailDto,
  DefenseContextDocumentListDto,
  DefenseContextDocumentRevisionDto,
  DefenseContextDocumentSummaryDto,
  DefenseContextSectionDto,
  DefenseDossierDto,
  DefenseDossierFieldDto,
  DefenseEvidenceRefDto,
  DefenseFundingCellDto,
  DefenseFundingMatrixDto,
  DefenseMilestoneDto,
  DefenseMilestonePeriodDto,
  DefenseMilestoneResponseDto,
  DefenseReferenceOccurrenceDto,
  DefenseResearchAvailability,
  DefenseOfficeSummaryDto,
  DefenseOfficeDetailDto,
  DefenseOfficeListDto,
  DefenseRelationshipListDto,
  DefenseRelationshipEdgeDto,
  OfficeStatus,
  OfficeRelation,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

type SubjectType = DefenseDossierDto['subject']['type'];
const EXPECTED_DOSSIER_FIELDS = [
  'mission', 'plans', 'accomplishments', 'strategy_alignment', 'performance_measures',
  'related_program_funding', 'remarks', 'analyst_questions',
] as const;

@Injectable()
export class DefenseResearchService {
  constructor(private readonly prisma: PrismaService) {}

  async dossier(subjectType: string, subjectId: string): Promise<DefenseDossierDto> {
    const type = this.subjectType(subjectType);
    if (type === 'program_element') return this.programElementDossier(subjectId);
    if (type === 'program') return this.programDossier(subjectId);
    if (type === 'project') return this.projectDossier(subjectId);
    return this.budgetLineDossier(subjectId);
  }

  async milestones(subjectType: string, subjectId: string): Promise<DefenseMilestoneResponseDto> {
    const type = this.subjectType(subjectType);
    let peCode: string | null = type === 'program_element' ? subjectId : null;
    let projectId: string | null = null;
    let projectCode: string | null = null;
    let projectLabel: string | null = null;
    if (type === 'project') {
      const project = await this.prisma.programElementProject.findFirst({ where: this.projectWhere(subjectId), select: { id: true, peCode: true, projectCode: true, title: true } });
      if (!project) throw new NotFoundException('Defense research subject not found');
      peCode = project.peCode;
      projectId = project.id;
      projectCode = project.projectCode;
      projectLabel = project.title;
    }
    if (!peCode) {
      const subject = await this.subjectLabel(type, subjectId);
      return { subject, projectionVersion: 'defense-milestones-v1', milestones: [], coverage: { state: 'unavailable', reason: 'Milestone schedules are currently qualified for program elements and their projects only.' } };
    }
    const pe = await this.prisma.programElement.findUnique({
      where: { peCode },
      include: { milestones: { include: { schedulePeriods: { include: { sourceDocument: true }, orderBy: [{ periodRole: 'asc' }, { createdAt: 'asc' }] } }, orderBy: { milestoneType: 'asc' } } },
    });
    if (!pe) throw new NotFoundException('Defense research subject not found');
    const rows = pe.milestones.filter((milestone) => {
      if (!projectId) return true;
      const metadata = milestone.schedulePeriods[0]?.metadata as Record<string, unknown> | undefined;
      return metadata?.projectId === projectId || metadata?.projectCode === projectCode;
    });
    const mapped = rows.map((milestone): DefenseMilestoneDto => {
      const periods = milestone.schedulePeriods.map((period) => this.schedulePeriod(period));
      return {
        id: milestone.id,
        projectId,
        eventCategory: this.milestoneCategory(milestone.milestoneType),
        label: milestone.milestoneType,
        status: milestone.status,
        periods,
        observedAt: milestone.lastSyncedAt.toISOString(),
        edition: milestone.schedulePeriods[0]?.sourceDocument?.sourceKey ?? null,
        history: [{ revision: milestone.schedulePeriods[0]?.sourceDocument?.sha256 ?? milestone.id, observedAt: milestone.lastSyncedAt.toISOString(), periods }],
      };
    });
    return { subject: { type, id: type === 'project' ? projectId! : subjectId, label: projectLabel ?? pe.title }, projectionVersion: 'defense-milestones-v1', milestones: mapped, coverage: { state: mapped.length ? 'available' : 'unavailable', reason: mapped.length ? null : 'No source-qualified milestone periods are available for this subject.' } };
  }

  async fundingMatrix(subjectType: string, subjectId: string, knownAt?: string): Promise<DefenseFundingMatrixDto> {
    const type = this.subjectType(subjectType);
    if (knownAt) throw new BadRequestException('Arbitrary knownAt reconstruction is unsupported; use a captured portfolio snapshot for historical reproduction.');
    const subject = await this.subjectLabel(type, subjectId);
    let cells: DefenseFundingCellDto[] = [];
    if (type === 'program_element') {
      const rows = await this.prisma.programElementBudgetPosition.findMany({ where: { peCode: subjectId }, include: { sourceDocument: true }, orderBy: [{ assertedFy: 'asc' }, { positionCycle: 'asc' }, { valueKind: 'asc' }] });
      cells = rows.map((row) => this.positionCell(row, `pe-position:${row.id}`));
    } else if (type === 'project') {
      const project = await this.prisma.programElementProject.findFirst({ where: this.projectWhere(subjectId) });
      if (!project) throw new NotFoundException('Defense research subject not found');
      const rows = await this.prisma.programElementProjectBudgetPosition.findMany({ where: { peCode: project.peCode, projectCode: project.projectCode }, include: { sourceDocument: true }, orderBy: [{ assertedFy: 'asc' }, { positionCycle: 'asc' }] });
      cells = rows.map((row) => this.positionCell(row, `project-position:${row.id}`));
    } else if (type === 'budget_line') {
      const line = await this.prisma.procurementLine.findUnique({ where: { id: subjectId }, include: { years: { include: { sources: { include: { sourceDocument: true } } }, orderBy: { fy: 'asc' } } } });
      if (!line) throw new NotFoundException('Defense research subject not found');
      const stages = ['request', 'hascMark', 'sascMark', 'hacDMark', 'sacDMark', 'conference', 'enacted', 'actuals'] as const;
      for (const year of line.years) for (const stage of stages) {
        const value = year[stage];
        const evidence = year.sources.map((source) => this.evidence(`procurement-source:${source.id}`, source.sourceDocumentId, source.sourceDocument?.sha256 ?? null, 'procurement_jbook', source.sourceDocument?.title ?? null, source.sourceUrl, source.pageNumber, null, null, source.sourceDocument?.sourceKey ?? null, source.sourceDocument?.ingestedAt ?? null));
        cells.push({ basis: { requestEdition: evidence[0]?.edition ?? null, fundingFiscalYear: year.fy, stage, metric: 'funding', unit: 'usd_millions', currency: 'USD', priceBasis: null, knownAt: null, knowledgeTimeSupported: false }, value: value?.toString() ?? null, disposition: value === null ? 'missing' : evidence.length ? 'observed' : 'partial', sourceObservationId: `procurement-year:${year.id}:${stage}`, replacedByObservationId: null, evidence });
      }
    }
    const years = [...new Set(cells.map((cell) => cell.basis.fundingFiscalYear))].sort();
    const editions = [...new Set(cells.map((cell) => cell.basis.requestEdition).filter((item): item is string => Boolean(item)))].sort();
    const stages = [...new Set(cells.map((cell) => cell.basis.stage))].sort();
    const metrics = [...new Set(cells.map((cell) => cell.basis.metric))];
    return { subject, projectionVersion: 'defense-funding-matrix-v1', cells, supported: { fiscalYears: years, editions, stages, metrics, knownAt: false }, limitations: ['Request edition and funding fiscal year remain separate.', 'Arbitrary pre-capture known-at reconstruction is unsupported.', ...(cells.some((cell) => cell.evidence.length === 0) ? ['Some cells lack source-locator proof and are marked partial.'] : [])] };
  }

  async listContextDocuments(filters: { family?: string; publisher?: string; status?: string; limit?: number }): Promise<DefenseContextDocumentListDto> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    const persistedWhere = { ...(filters.family ? { family: filters.family } : {}), ...(filters.publisher ? { publisher: { contains: filters.publisher, mode: 'insensitive' as const } } : {}), ...(filters.status ? { status: filters.status } : {}) };
    const rows = await this.prisma.defenseContextDocument.findMany({ where: persistedWhere, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], take: limit });
    const [persistedObserved, persistedEligible, persistedQualified, persistedAvailable, persistedPartial, persistedUnavailable] = await Promise.all([
      this.prisma.defenseContextDocument.count({ where: persistedWhere }),
      this.prisma.defenseContextDocument.count({ where: { ...persistedWhere, eligible: true } }),
      this.prisma.defenseContextDocument.count({ where: { ...persistedWhere, qualification: 'qualified' } }),
      this.prisma.defenseContextDocument.count({ where: { ...persistedWhere, coverage: 'available' } }),
      this.prisma.defenseContextDocument.count({ where: { ...persistedWhere, coverage: 'partial' } }),
      this.prisma.defenseContextDocument.count({ where: { ...persistedWhere, coverage: 'unavailable' } }),
    ]);

    const includesTranscripts = (!filters.family || filters.family === 'hearing_transcript')
      && (!filters.publisher || 'govinfo'.includes(filters.publisher.toLowerCase()))
      && (!filters.status || filters.status === 'published');
    const transcripts = includesTranscripts ? await this.prisma.officialHearingTranscript.findMany({ orderBy: { date: 'desc' }, take: Math.min(20, limit) }) : [];
    const transcriptCount = includesTranscripts ? await this.prisma.officialHearingTranscript.count() : 0;

    const includesHearings = !filters.family || filters.family === 'hearing';
    const transcriptLinks = includesHearings ? await this.prisma.officialHearingTranscript.findMany({ where: { hearingId: { not: null } }, select: { hearingId: true } }) : [];
    const transcriptHearingIds = [...new Set(transcriptLinks.map((item) => item.hearingId).filter((id): id is string => Boolean(id)))];
    const hearingWhere = { id: { notIn: transcriptHearingIds }, ...(filters.status ? { eventStatus: filters.status } : {}), ...(filters.publisher ? { url: { contains: filters.publisher, mode: 'insensitive' as const } } : {}) };
    const hearingGaps = includesHearings ? await this.prisma.committeeHearing.findMany({ where: hearingWhere, orderBy: { date: 'desc' }, take: Math.min(10, limit) }) : [];
    const hearingCount = includesHearings ? await this.prisma.committeeHearing.count({ where: hearingWhere }) : 0;

    const includesPolicy = (!filters.family || filters.family === 'federal_register_rule') && (!filters.status || filters.status === 'published');
    const policyWhere = { type: 'RULE', ...(filters.publisher ? { agencyNames: { has: filters.publisher } } : {}) };
    const policyDocuments = includesPolicy ? await this.prisma.federalRegisterDocument.findMany({ where: policyWhere, orderBy: { publicationDate: 'desc' }, take: Math.min(20, limit) }) : [];
    const policyCoverage = includesPolicy ? await this.prisma.federalRegisterDocument.findMany({ where: policyWhere, select: { abstract: true, cfrReferences: true } }) : [];
    const policyPartial = policyCoverage.filter((row) => Boolean(row.abstract) || row.cfrReferences.length > 0).length;
    const policyUnavailable = policyCoverage.length - policyPartial;

    const allItems: DefenseContextDocumentSummaryDto[] = [
      ...rows.map((row) => this.contextSummary(row)),
      ...transcripts.map((row) => ({ id: `transcript:${row.id}`, family: 'hearing_transcript', publisher: 'GovInfo', title: row.title, congress: row.congress, committee: row.committeeName, publishedAt: (row.publishedAt ?? row.date).toISOString(), status: 'published', currentRevisionId: `transcript:${row.id}:v1`, transcriptAvailability: 'available' as const, coverage: 'available' as const, sourceUrl: row.sourceUrl })),
      ...hearingGaps.map((row) => ({ id: `hearing:${row.id}`, family: 'hearing', publisher: this.publisherFromUrl(row.url), title: row.title, congress: row.congress, committee: row.committeeName, publishedAt: row.date.toISOString(), status: row.eventStatus, currentRevisionId: null, transcriptAvailability: 'unavailable' as const, coverage: 'unavailable' as const, sourceUrl: row.url })),
      ...policyDocuments.map((row) => this.federalRegisterSummary(row)),
    ];
    const filtered = allItems.filter((item) =>
      (!filters.family || item.family === filters.family)
      && (!filters.publisher || item.publisher.toLowerCase().includes(filters.publisher.toLowerCase()))
      && (!filters.status || item.status === filters.status));
    const items = filtered.slice(0, limit);
    const observed = persistedObserved + transcriptCount + hearingCount + policyCoverage.length;
    return {
      items,
      nextCursor: null,
      denominator: {
        eligible: persistedEligible + transcriptCount + hearingCount + policyCoverage.length,
        observed,
        qualified: persistedQualified + transcriptCount + policyCoverage.length,
        available: persistedAvailable + transcriptCount,
        partial: persistedPartial + policyPartial,
        unavailable: persistedUnavailable + hearingCount + policyUnavailable,
      },
    };
  }

  async contextDocument(documentId: string): Promise<DefenseContextDocumentDetailDto> {
    if (documentId.startsWith('transcript:')) return this.transcriptDetail(documentId.slice('transcript:'.length));
    if (documentId.startsWith('hearing:')) return this.hearingGapDetail(documentId.slice('hearing:'.length));
    if (documentId.startsWith('federal-register:')) return this.federalRegisterDetail(documentId.slice('federal-register:'.length));
    const row = await this.prisma.defenseContextDocument.findUnique({ where: { id: this.requireUuid(documentId) }, include: { revisions: { include: { sections: { orderBy: { ordinal: 'asc' } } }, orderBy: { observedAt: 'desc' } } } });
    if (!row) throw new NotFoundException('Context document not found');
    const current = row.revisions.find((revision) => revision.id === row.currentRevisionId) ?? row.revisions[0];
    return { ...this.contextSummary(row), revisions: row.revisions.map((revision) => this.contextRevision(revision)), sections: current?.sections.map((section) => this.contextSection(section)) ?? [], coverageReason: row.coverageReason };
  }

  async contextRevisions(documentId: string): Promise<readonly DefenseContextDocumentRevisionDto[]> { return (await this.contextDocument(documentId)).revisions; }
  async contextSections(documentId: string): Promise<readonly DefenseContextSectionDto[]> { return (await this.contextDocument(documentId)).sections; }

  async references(documentId: string): Promise<readonly DefenseReferenceOccurrenceDto[]> {
    if (documentId.startsWith('transcript:') || documentId.startsWith('hearing:')) return [];
    if (documentId.startsWith('federal-register:')) {
      const row = await this.prisma.federalRegisterDocument.findUnique({ where: { documentNumber: documentId.slice('federal-register:'.length) } });
      if (!row) throw new NotFoundException('Context document not found');
      return row.cfrReferences.map((reference, index) => this.federalRegisterReference(row, reference, index));
    }
    const rows = await this.prisma.defenseReferenceOccurrence.findMany({ where: { documentId: this.requireUuid(documentId) }, include: { revision: true, document: true, section: true }, orderBy: [{ sectionId: 'asc' }, { startOffset: 'asc' }, { id: 'asc' }] });
    return rows.map((row) => this.referenceDto(row));
  }

  async referenceOccurrence(occurrenceId: string): Promise<DefenseReferenceOccurrenceDto> {
    if (occurrenceId.startsWith('federal-register-reference:')) {
      const value = occurrenceId.slice('federal-register-reference:'.length);
      const split = value.lastIndexOf(':');
      const documentNumber = split > 0 ? value.slice(0, split) : '';
      const index = split > 0 ? Number.parseInt(value.slice(split + 1), 10) : Number.NaN;
      const row = documentNumber ? await this.prisma.federalRegisterDocument.findUnique({ where: { documentNumber } }) : null;
      if (!row || !Number.isInteger(index) || index < 0 || index >= row.cfrReferences.length) throw new NotFoundException('Reference occurrence not found');
      return this.federalRegisterReference(row, row.cfrReferences[index]!, index);
    }
    const row = await this.prisma.defenseReferenceOccurrence.findUnique({ where: { id: this.requireUuid(occurrenceId) }, include: { revision: true, document: true, section: true } });
    if (!row) throw new NotFoundException('Reference occurrence not found');
    return this.referenceDto(row);
  }

  async citedBy(documentId: string): Promise<readonly DefenseReferenceOccurrenceDto[]> {
    if (documentId.startsWith('transcript:') || documentId.startsWith('hearing:') || documentId.startsWith('federal-register:')) return [];
    const rows = await this.prisma.defenseReferenceOccurrence.findMany({ where: { resolvedTargetDocumentId: this.requireUuid(documentId) }, include: { revision: true, document: true, section: true }, orderBy: { createdAt: 'desc' } });
    return rows.map((row) => this.referenceDto(row));
  }

  async resolveEvidence(evidenceRefId: string): Promise<DefenseEvidenceRefDto> {
    if (evidenceRefId.startsWith('context-occurrence:')) return (await this.referenceOccurrence(evidenceRefId.slice('context-occurrence:'.length))).evidenceRef;
    if (evidenceRefId.startsWith('federal-register-reference:')) return (await this.referenceOccurrence(evidenceRefId)).evidenceRef;
    if (evidenceRefId.startsWith('pe-source:')) {
      const row = await this.prisma.programElementSource.findUnique({ where: { id: this.evidenceUuid(evidenceRefId, 'pe-source:') }, include: { sourceDocument: true } });
      if (!row) throw new NotFoundException('Evidence reference not found');
      return this.evidence(evidenceRefId, row.sourceDocumentId, row.sourceDocument?.sha256 ?? null, row.docType, row.publisher, row.sourceUrl, row.pageNumber, null, null, row.sourceDocument?.sourceKey ?? null, row.observedAt);
    }
    if (evidenceRefId.startsWith('project:')) {
      const row = await this.prisma.programElementProject.findUnique({ where: { id: this.evidenceUuid(evidenceRefId, 'project:') }, include: { sourceDocument: true } });
      if (!row || !row.sourceUrl) throw new NotFoundException('Evidence reference not found');
      return this.evidence(evidenceRefId, row.sourceDocumentId, row.sourceDocument?.sha256 ?? null, 'r2a_project', row.sourceDocument?.title ?? null, row.sourceUrl, row.pageNumber, null, null, row.sourceDocument?.sourceKey ?? null, row.lastSyncedAt);
    }
    if (evidenceRefId.startsWith('procurement-source:')) {
      const row = await this.prisma.procurementLineSource.findUnique({ where: { id: this.evidenceUuid(evidenceRefId, 'procurement-source:') }, include: { sourceDocument: true } });
      if (!row) throw new NotFoundException('Evidence reference not found');
      return this.evidence(evidenceRefId, row.sourceDocumentId, row.sourceDocument?.sha256 ?? null, 'procurement_jbook', row.sourceDocument?.title ?? row.publisher, row.sourceUrl, row.pageNumber, null, null, row.sourceDocument?.sourceKey ?? null, row.observedAt);
    }
    if (evidenceRefId.startsWith('pe-position:')) {
      const row = await this.prisma.programElementBudgetPosition.findUnique({ where: { id: this.evidenceUuid(evidenceRefId, 'pe-position:') }, include: { sourceDocument: true } });
      if (!row || !row.sourceUrl) throw new NotFoundException('Evidence reference not found');
      return this.evidence(evidenceRefId, row.sourceDocumentId, row.sourceDocument?.sha256 ?? null, row.sourceDocument?.documentType ?? 'budget_position', row.sourceDocument?.title ?? null, row.sourceUrl, row.pageNumber, null, null, row.sourceDocument?.sourceKey ?? row.positionCycle, row.sourceDocument?.ingestedAt ?? row.createdAt);
    }
    if (evidenceRefId.startsWith('project-position:')) {
      const row = await this.prisma.programElementProjectBudgetPosition.findUnique({ where: { id: this.evidenceUuid(evidenceRefId, 'project-position:') }, include: { sourceDocument: true } });
      if (!row || !row.sourceUrl) throw new NotFoundException('Evidence reference not found');
      return this.evidence(evidenceRefId, row.sourceDocumentId, row.sourceDocument?.sha256 ?? null, row.sourceDocument?.documentType ?? 'budget_position', row.sourceDocument?.title ?? null, row.sourceUrl, row.pageNumber, null, null, row.sourceDocument?.sourceKey ?? row.positionCycle, row.sourceDocument?.ingestedAt ?? row.createdAt);
    }
    if (evidenceRefId.startsWith('milestone-period:')) {
      const row = await this.prisma.programElementMilestoneSchedulePeriod.findUnique({ where: { id: this.evidenceUuid(evidenceRefId, 'milestone-period:') }, include: { sourceDocument: true } });
      if (!row || !row.sourceUrl) throw new NotFoundException('Evidence reference not found');
      return this.evidence(evidenceRefId, row.sourceDocumentId, row.sourceDocument?.sha256 ?? null, 'milestone_schedule', row.sourceDocument?.title ?? null, row.sourceUrl, row.pageNumber, null, null, row.sourceDocument?.sourceKey ?? null, row.sourceDocument?.ingestedAt ?? row.createdAt);
    }
    throw new NotFoundException('Evidence reference not found');
  }

  private async programElementDossier(peCode: string): Promise<DefenseDossierDto> {
    const row = await this.prisma.programElement.findUnique({ where: { peCode }, include: { sources: { include: { sourceDocument: true }, orderBy: { observedAt: 'desc' } } } });
    if (!row) throw new NotFoundException('Defense research subject not found');
    const raw = this.record(row.raw);
    const evidence = row.sources.map((source) => this.evidence(`pe-source:${source.id}`, source.sourceDocumentId, source.sourceDocument?.sha256 ?? null, source.docType, source.publisher, source.sourceUrl, source.pageNumber, null, null, source.sourceDocument?.sourceKey ?? null, source.observedAt));
    return this.dossierResult({ type: 'program_element', id: peCode, label: row.title }, { mission: row.description ?? raw.mission, plans: raw.plans, accomplishments: raw.accomplishments, strategy_alignment: raw.strategyAlignment, performance_measures: raw.performanceMeasures, related_program_funding: raw.relatedProgramFunding, remarks: raw.remarks ?? raw.notes, analyst_questions: raw.analystQuestions }, evidence);
  }

  private async programDossier(id: string): Promise<DefenseDossierDto> {
    const row = await this.prisma.program.findUnique({ where: { id }, include: { aliases: { orderBy: { confidence: 'desc' } } } });
    if (!row) throw new NotFoundException('Defense research subject not found');
    const raw = this.record(row.metadata);
    return this.dossierResult({ type: 'program', id, label: row.canonicalName }, { mission: row.description, plans: raw.plans, accomplishments: raw.accomplishments, strategy_alignment: raw.strategyAlignment, performance_measures: raw.performanceMeasures, related_program_funding: raw.relatedProgramFunding, remarks: raw.remarks, analyst_questions: raw.analystQuestions }, []);
  }

  private async projectDossier(id: string): Promise<DefenseDossierDto> {
    const row = await this.prisma.programElementProject.findFirst({ where: this.projectWhere(id), include: { sourceDocument: true, programElement: true } });
    if (!row) throw new NotFoundException('Defense research subject not found');
    const raw = this.record(row.metadata);
    const evidence = row.sourceUrl ? [this.evidence(`project:${row.id}`, row.sourceDocumentId, row.sourceDocument?.sha256 ?? null, 'r2a_project', row.sourceDocument?.title ?? null, row.sourceUrl, row.pageNumber, null, null, row.sourceDocument?.sourceKey ?? null, row.lastSyncedAt)] : [];
    return this.dossierResult({ type: 'project', id: row.id, label: row.title }, { mission: row.mission, plans: raw.plans, accomplishments: raw.accomplishments, strategy_alignment: raw.strategyAlignment, performance_measures: raw.performanceMeasures, related_program_funding: raw.relatedProgramFunding, remarks: raw.remarks, analyst_questions: raw.analystQuestions }, evidence);
  }

  private async budgetLineDossier(id: string): Promise<DefenseDossierDto> {
    const row = await this.prisma.procurementLine.findUnique({ where: { id }, include: { sources: { include: { sourceDocument: true } } } });
    if (!row) throw new NotFoundException('Defense research subject not found');
    const raw = this.record(row.raw);
    const evidence = row.sources.map((source) => this.evidence(`procurement-source:${source.id}`, source.sourceDocumentId, source.sourceDocument?.sha256 ?? null, 'procurement_jbook', source.sourceDocument?.title ?? null, source.sourceUrl, source.pageNumber, null, null, source.sourceDocument?.sourceKey ?? null, source.createdAt));
    return this.dossierResult({ type: 'budget_line', id, label: row.title }, { mission: raw.mission ?? raw.description, plans: raw.plans, accomplishments: raw.accomplishments, strategy_alignment: raw.strategyAlignment, performance_measures: raw.performanceMeasures, related_program_funding: raw.relatedProgramFunding, remarks: raw.remarks, analyst_questions: raw.analystQuestions }, evidence);
  }

  private dossierResult(subject: DefenseDossierDto['subject'], values: Record<string, unknown>, evidence: DefenseEvidenceRefDto[]): DefenseDossierDto {
    const fields: DefenseDossierFieldDto[] = EXPECTED_DOSSIER_FIELDS.map((field) => {
      const value = values[field];
      const text = typeof value === 'string' ? value.trim() : value == null ? '' : JSON.stringify(value);
      const availability: DefenseResearchAvailability = !text ? 'unavailable' : evidence.length ? 'available' : 'partial';
      return { field, availability, value: text || null, reason: availability === 'unavailable' ? 'No qualified source observation is available for this field.' : availability === 'partial' ? 'A value is present but exact source-locator proof is incomplete.' : null, fiscalPeriod: null, metric: null, unit: null, evidence: text ? evidence : [] };
    });
    const counts = { available: fields.filter((field) => field.availability === 'available').length, partial: fields.filter((field) => field.availability === 'partial').length, unavailable: fields.filter((field) => field.availability === 'unavailable').length };
    return { subject, projectionVersion: 'defense-dossier-v1', fields, coverage: { state: counts.unavailable === fields.length ? 'unavailable' : counts.partial || counts.unavailable ? 'partial' : 'available', expectedFields: fields.length, availableFields: counts.available, partialFields: counts.partial, unavailableFields: counts.unavailable } };
  }

  private async subjectLabel(type: SubjectType, id: string): Promise<DefenseDossierDto['subject']> {
    if (type === 'program_element') { const row = await this.prisma.programElement.findUnique({ where: { peCode: id }, select: { title: true } }); if (!row) throw new NotFoundException('Defense research subject not found'); return { type, id, label: row.title }; }
    if (type === 'program') { const row = await this.prisma.program.findUnique({ where: { id }, select: { canonicalName: true } }); if (!row) throw new NotFoundException('Defense research subject not found'); return { type, id, label: row.canonicalName }; }
    if (type === 'project') { const row = await this.prisma.programElementProject.findFirst({ where: this.projectWhere(id), select: { id: true, title: true } }); if (!row) throw new NotFoundException('Defense research subject not found'); return { type, id: row.id, label: row.title }; }
    const row = await this.prisma.procurementLine.findUnique({ where: { id }, select: { title: true } }); if (!row) throw new NotFoundException('Defense research subject not found'); return { type, id, label: row.title };
  }

  private positionCell(row: any, observationId: string): DefenseFundingCellDto {
    const metric = row.valueKind === 'quantity' ? 'quantity' : row.valueKind === 'unit_cost' ? 'unit_cost' : 'funding';
    const unit = metric === 'quantity' ? 'units' : metric === 'unit_cost' ? 'usd_millions_per_unit' : 'usd_millions';
    const evidence = row.sourceUrl ? [this.evidence(observationId, row.sourceDocumentId, row.sourceDocument?.sha256 ?? null, row.sourceDocument?.documentType ?? 'budget_position', row.sourceDocument?.title ?? null, row.sourceUrl, row.pageNumber, null, null, row.sourceDocument?.sourceKey ?? row.positionCycle, row.sourceDocument?.ingestedAt ?? row.createdAt)] : [];
    return { basis: { requestEdition: row.positionCycle, fundingFiscalYear: row.assertedFy, stage: this.stage(row.positionCycle), metric, unit, currency: 'USD', priceBasis: null, knownAt: null, knowledgeTimeSupported: false }, value: (metric === 'quantity' ? row.quantity ?? row.amount : row.amount)?.toString() ?? null, disposition: evidence.length ? 'observed' : 'partial', sourceObservationId: observationId, replacedByObservationId: null, evidence };
  }

  private schedulePeriod(period: any): DefenseMilestonePeriodDto {
    const evidence = period.sourceUrl ? [this.evidence(`milestone-period:${period.id}`, period.sourceDocumentId, period.sourceDocument?.sha256 ?? null, 'milestone_schedule', period.sourceDocument?.title ?? null, period.sourceUrl, period.pageNumber, null, null, period.sourceDocument?.sourceKey ?? null, period.sourceDocument?.ingestedAt ?? period.createdAt)] : [];
    return { role: period.periodRole, rawText: period.rawText, precision: period.periodKind, exactDate: period.exactDate?.toISOString().slice(0, 10) ?? null, rangeStart: period.rangeStart?.toISOString().slice(0, 10) ?? null, rangeEnd: period.rangeEnd?.toISOString().slice(0, 10) ?? null, fiscalYear: period.fiscalYear, quarter: period.fiscalQuarter ?? period.calendarQuarter, evidence };
  }

  private contextSummary(row: any): DefenseContextDocumentSummaryDto { return { id: row.id, family: row.family, publisher: row.publisher, title: row.title, congress: row.congress, committee: row.committee, publishedAt: row.publishedAt?.toISOString() ?? null, status: row.status, currentRevisionId: row.currentRevisionId, transcriptAvailability: row.transcriptAvailability, coverage: row.coverage, sourceUrl: row.sourceUrl }; }
  private contextRevision(row: any): DefenseContextDocumentRevisionDto { return { id: row.id, version: row.version, contentHash: row.contentHash, publishedAt: row.publishedAt?.toISOString() ?? null, observedAt: row.observedAt.toISOString(), status: row.status, sourceUrl: row.sourceUrl }; }
  private contextSection(row: any): DefenseContextSectionDto { return { id: row.id, revisionId: row.revisionId, ordinal: row.ordinal, label: row.label, nativeLocator: row.nativeLocator, textAvailability: row.textAvailability, contentHash: row.contentHash }; }
  private referenceDto(row: any): DefenseReferenceOccurrenceDto {
    return { id: row.id, sourceDocumentId: row.documentId, sourceRevisionId: row.revisionId, sourceSectionId: row.sectionId, exactSpan: row.exactSpan, originalWording: row.originalWording, referenceType: row.referenceType, targetCandidates: row.targetCandidates, resolvedTarget: row.resolvedTarget, disposition: row.disposition, evidenceRef: this.evidence(`context-occurrence:${row.id}`, row.revision.sourceDocumentId ?? null, row.revision.contentHash, row.document.family, row.document.publisher, row.revision.sourceUrl ?? row.document.sourceUrl, null, row.section?.nativeLocator ?? null, row.id, row.revision.version, row.revision.observedAt, row.revisionId) };
  }

  private async transcriptDetail(id: string): Promise<DefenseContextDocumentDetailDto> {
    const row = await this.prisma.officialHearingTranscript.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Context document not found');
    const hash = createHash('sha256').update(row.text).digest('hex');
    return { id: `transcript:${row.id}`, family: 'hearing_transcript', publisher: 'GovInfo', title: row.title, congress: row.congress, committee: row.committeeName, publishedAt: (row.publishedAt ?? row.date).toISOString(), status: 'published', currentRevisionId: `transcript:${row.id}:v1`, transcriptAvailability: 'available', coverage: 'available', sourceUrl: row.sourceUrl, revisions: [{ id: `transcript:${row.id}:v1`, version: 'v1', contentHash: hash, publishedAt: row.publishedAt?.toISOString() ?? null, observedAt: row.fetchedAt.toISOString(), status: 'published', sourceUrl: row.sourceUrl }], sections: [{ id: `transcript:${row.id}:section:1`, revisionId: `transcript:${row.id}:v1`, ordinal: 1, label: 'Official transcript', nativeLocator: 'transcript', textAvailability: 'available', contentHash: hash }], coverageReason: null };
  }

  private async hearingGapDetail(id: string): Promise<DefenseContextDocumentDetailDto> {
    const row = await this.prisma.committeeHearing.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Context document not found');
    return { id: `hearing:${row.id}`, family: 'hearing', publisher: this.publisherFromUrl(row.url), title: row.title, congress: row.congress, committee: row.committeeName, publishedAt: row.date.toISOString(), status: row.eventStatus, currentRevisionId: null, transcriptAvailability: 'unavailable', coverage: 'unavailable', sourceUrl: row.url, revisions: [], sections: [], coverageReason: 'No qualified official transcript revision is available for this hearing.' };
  }

  private async federalRegisterDetail(documentNumber: string): Promise<DefenseContextDocumentDetailDto> {
    const row = await this.prisma.federalRegisterDocument.findUnique({ where: { documentNumber } });
    if (!row || row.type !== 'RULE') throw new NotFoundException('Context document not found');
    const summary = this.federalRegisterSummary(row);
    const hash = this.federalRegisterHash(row);
    const revisionId = `${summary.id}:v1`;
    return {
      ...summary,
      revisions: [{ id: revisionId, version: row.documentNumber, contentHash: hash, publishedAt: row.publicationDate.toISOString(), observedAt: row.syncedAt.toISOString(), status: 'published', sourceUrl: summary.sourceUrl }],
      sections: [{ id: `${summary.id}:abstract`, revisionId, ordinal: 1, label: 'Federal Register abstract', nativeLocator: row.documentNumber, textAvailability: row.abstract ? 'partial' : 'unavailable', contentHash: row.abstract ? createHash('sha256').update(row.abstract).digest('hex') : null }],
      coverageReason: row.abstract ? 'Federal Register metadata, abstract, and CFR references are available; the full rule text is not stored in this projection.' : 'Only Federal Register metadata and CFR references are available; no stored abstract or full text is available.',
    };
  }

  private federalRegisterSummary(row: any): DefenseContextDocumentSummaryDto {
    return {
      id: `federal-register:${row.documentNumber}`,
      family: 'federal_register_rule',
      publisher: row.agencyNames?.length ? row.agencyNames.join(', ') : 'Office of the Federal Register',
      title: row.title,
      congress: null,
      committee: null,
      publishedAt: row.publicationDate.toISOString(),
      status: 'published',
      currentRevisionId: `federal-register:${row.documentNumber}:v1`,
      transcriptAvailability: 'not_applicable',
      coverage: row.abstract || row.cfrReferences?.length ? 'partial' : 'unavailable',
      sourceUrl: row.htmlUrl ?? row.pdfUrl,
    };
  }

  private federalRegisterHash(row: any): string {
    return createHash('sha256').update(JSON.stringify({ documentNumber: row.documentNumber, title: row.title, abstract: row.abstract, cfrReferences: row.cfrReferences, publicationDate: row.publicationDate.toISOString() })).digest('hex');
  }

  private federalRegisterReference(row: any, reference: string, index: number): DefenseReferenceOccurrenceDto {
    const documentId = `federal-register:${row.documentNumber}`;
    const revisionId = `${documentId}:v1`;
    const id = `federal-register-reference:${row.documentNumber}:${index}`;
    const sourceUrl = row.htmlUrl ?? row.pdfUrl;
    return {
      id,
      sourceDocumentId: documentId,
      sourceRevisionId: revisionId,
      sourceSectionId: `${documentId}:abstract`,
      exactSpan: reference,
      originalWording: reference,
      referenceType: 'cfr_reference',
      targetCandidates: [{ type: 'cfr', id: reference, label: reference }],
      resolvedTarget: null,
      disposition: 'unresolved',
      evidenceRef: this.evidence(id, null, this.federalRegisterHash(row), 'federal_register_rule', this.federalRegisterSummary(row).publisher, sourceUrl, null, row.documentNumber, id, row.documentNumber, row.syncedAt, revisionId),
    };
  }

  private evidence(evidenceRefId: string, sourceDocumentId: string | null, contentHash: string | null, sourceFamily: string, publisher: string | null, sourceUrl: string | null, page: number | null, section: string | null, occurrenceId: string | null, edition: string | null, observedAt: Date | null, sourceRevisionId: string | null = null): DefenseEvidenceRefDto {
    return { evidenceRefId, sourceDocumentId, sourceRevisionId, sourceFamily, publisher, sourceUrl, nativeLocator: { page, section, occurrenceId }, contentHash, edition, observedAt: observedAt?.toISOString() ?? null };
  }
  private subjectType(value: string): SubjectType { if (!['program', 'program_element', 'project', 'budget_line'].includes(value)) throw new BadRequestException('subjectType must be program, program_element, project, or budget_line'); return value as SubjectType; }
  private evidenceUuid(evidenceRefId: string, prefix: string): string {
    return this.requireUuid(evidenceRefId.slice(prefix.length), 'Evidence reference not found');
  }
  private requireUuid(value: string, message = 'Context record not found'): string { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new NotFoundException(message); return value; }
  private projectWhere(id: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? { id } : id.includes(':') ? { peCode: id.split(':')[0], projectCode: id.split(':').slice(1).join(':') } : { id }; }
  private record(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}; }
  private stage(positionCycle: string): string { const value = positionCycle.toLowerCase(); if (value.startsWith('pb_')) return 'request'; if (value.startsWith('hasc')) return 'hasc_mark'; if (value.startsWith('sasc')) return 'sasc_mark'; if (value.startsWith('hac')) return 'hac_d_mark'; if (value.startsWith('sac')) return 'sac_d_mark'; if (value.startsWith('conference')) return 'conference'; if (value.startsWith('enacted')) return 'enacted'; return value.split('_fy')[0] ?? value; }
  private milestoneCategory(value: string): DefenseMilestoneDto['eventCategory'] { const normalized = value.toLowerCase(); if (/test|eval|demonstrat/.test(normalized)) return 'testing'; if (/produc|manufactur|field/.test(normalized)) return 'production'; if (/transition|deploy|operational/.test(normalized)) return 'transition'; if (/develop|design|prototype/.test(normalized)) return 'development'; return 'other'; }
  private publisherFromUrl(url: string | null): string { try { return url ? new URL(url).hostname : 'Official committee source'; } catch { return 'Official committee source'; } }

  async listOffices(filters: {
    agency?: string;
    component?: string;
    officeType?: string;
    capability?: string;
    program?: string;
    status?: OfficeStatus;
    availability?: DefenseResearchAvailability;
    freshness?: 'fresh' | 'stale' | 'any';
    q?: string;
    page?: number;
    limit?: number;
  }): Promise<DefenseOfficeListDto> {
    const page = Math.max(filters.page ?? 1, 1);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    const where = this.buildOfficeWhere(filters);
    const [total, offices] = await Promise.all([
      this.prisma.programOffice.count({ where }),
      this.prisma.programOffice.findMany({
        where,
        include: {
          parentOffice: { select: { id: true, name: true } },
          roles: { select: { id: true }, take: 1 },
          programLinks: { select: { id: true }, take: 1 },
        },
        orderBy: [{ name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const items = offices.map((office) => this.officeToSummary(office));
    return {
      items,
      total,
      page,
      limit,
      filters: {
        agency: filters.agency,
        component: filters.component,
        officeType: filters.officeType,
        capability: filters.capability,
        program: filters.program,
        status: filters.status,
        availability: filters.availability,
        freshness: filters.freshness,
      },
    };
  }

  async getOffice(id: string): Promise<DefenseOfficeDetailDto> {
    const office = await this.prisma.programOffice.findUnique({
      where: { id },
      include: {
        parentOffice: true,
        childOffices: true,
        roles: {
          include: {
            person: true,
          },
          where: { reviewStatus: 'accepted' },
        },
        programLinks: {
          include: { program: true },
          where: { reviewStatus: 'accepted' },
        },
      },
    });
    if (!office) throw new NotFoundException('Office not found');
    return this.officeToDetail(office);
  }

  async getRelationships(filters: {
    from?: string;
    to?: string;
    edgeType?: string;
    status?: string;
    includeSpeculative?: boolean;
    page?: number;
    limit?: number;
  }): Promise<DefenseRelationshipListDto> {
    const page = Math.max(Number(filters.page ?? 1), 1);
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 200);
    const reviewStates = filters.includeSpeculative ? ['accepted', 'candidate'] : ['accepted'];
    const offices = await this.prisma.programOffice.findMany({
      include: {
        parentOffice: { select: { id: true, name: true, service: true } },
        roles: {
          where: { reviewStatus: { in: reviewStates } },
          include: {
            person: { select: { id: true, fullName: true } },
            program: { select: { id: true, canonicalName: true, component: true } },
          },
        },
        programLinks: {
          where: { reviewStatus: { in: reviewStates } },
          include: { program: { select: { id: true, canonicalName: true, component: true, acquisitionPathway: true } } },
        },
      },
      orderBy: { name: 'asc' },
      take: 500,
    });

    const edges: DefenseRelationshipEdgeDto[] = [];
    for (const office of offices) {
      if (office.parentOffice) {
        edges.push({
          id: `office-parent:${office.id}:${office.parentOffice.id}`,
          from: { type: 'office', id: office.parentOffice.id, label: office.parentOffice.name, service: office.parentOffice.service },
          to: { type: 'office', id: office.id, label: office.name, service: office.service },
          relation: 'manages',
          sourceStated: Boolean(office.sourceUrl),
          derived: !office.sourceUrl,
          inferred: false,
          validity: this.relationshipValidity(office.status, office.validTo),
          observationRevision: office.updatedAt.toISOString(),
          evidence: this.sourceEvidence(`office:${office.id}`, 'program_office', office.sourceUrl, office.updatedAt),
          reviewStatus: office.sourceUrl ? 'accepted' : 'candidate',
          supersessionImpact: office.status === 'superseded' ? 'Office hierarchy edge is historical and must not be treated as current.' : null,
        });
      }
      for (const link of office.programLinks) {
        const relation = this.officeProgramRelation(link.relation);
        edges.push({
          id: `office-program:${link.id}`,
          from: { type: 'office', id: office.id, label: office.name, service: office.service },
          to: { type: 'program', id: link.program.id, label: link.program.canonicalName, service: link.program.component },
          relation,
          sourceStated: !link.derivedBy,
          derived: Boolean(link.derivedBy),
          inferred: false,
          validity: link.reviewStatus === 'accepted' ? 'valid' : 'candidate',
          observationRevision: link.updatedAt.toISOString(),
          evidence: this.sourceEvidence(`office-program:${link.id}`, 'program_office_program_link', link.sourceUrl, link.updatedAt),
          reviewStatus: this.reviewState(link.reviewStatus),
          supersessionImpact: null,
        });
        if (link.program.acquisitionPathway) {
          edges.push({
            id: `program-acquisition-path:${link.program.id}`,
            from: { type: 'program', id: link.program.id, label: link.program.canonicalName, service: link.program.component },
            to: { type: 'acquisition', id: `pathway:${link.program.acquisitionPathway}`, label: link.program.acquisitionPathway },
            relation: 'acquisition_path',
            sourceStated: false,
            derived: true,
            inferred: false,
            validity: 'valid',
            observationRevision: link.updatedAt.toISOString(),
            evidence: this.sourceEvidence(`program:${link.program.id}:acquisition-path`, 'program', link.sourceUrl, link.updatedAt),
            reviewStatus: this.reviewState(link.reviewStatus),
            supersessionImpact: 'Acquisition pathway is context only and carries no allocation or award authority.',
          });
        }
      }
      for (const role of office.roles) {
        const target = role.program
          ? { type: 'program' as const, id: role.program.id, label: role.program.canonicalName, service: role.program.component }
          : { type: 'office' as const, id: office.id, label: office.name, service: office.service };
        edges.push({
          id: `person-role:${role.id}`,
          from: { type: 'person', id: role.person.id, label: role.person.fullName },
          to: target,
          relation: 'holds_role',
          sourceStated: true,
          derived: false,
          inferred: false,
          validity: role.effectiveEnd && role.effectiveEnd < new Date() ? 'superseded' : role.reviewStatus === 'accepted' ? 'valid' : 'candidate',
          observationRevision: role.observedAt.toISOString(),
          evidence: this.sourceEvidence(`person-role:${role.id}`, role.source, role.sourceUrl, role.observedAt),
          reviewStatus: this.reviewState(role.reviewStatus),
          supersessionImpact: role.effectiveEnd ? 'Role has an explicit effective end and is retained as historical evidence.' : null,
        });
      }
    }

    const filtered = edges.filter((edge) => {
      if (filters.from && edge.from.id !== filters.from) return false;
      if (filters.to && edge.to.id !== filters.to) return false;
      if (filters.edgeType && edge.relation !== filters.edgeType) return false;
      if (filters.status && edge.validity !== filters.status && edge.reviewStatus !== filters.status) return false;
      return true;
    });
    const start = (page - 1) * limit;
    return {
      items: filtered.slice(start, start + limit),
      total: filtered.length,
      page,
      limit,
    };
  }

  private buildOfficeWhere(filters: any) {
    const where: any = {};
    const serviceFilters = [filters.agency, filters.component].filter(Boolean);
    if (serviceFilters.length === 1) where.service = { equals: serviceFilters[0], mode: 'insensitive' };
    if (serviceFilters.length > 1) where.AND = serviceFilters.map((value: string) => ({ service: { equals: value, mode: 'insensitive' } }));
    if (filters.officeType) where.officeType = filters.officeType;
    if (filters.status) where.status = filters.status;
    const relationshipFilters: any[] = [];
    if (filters.program) {
      relationshipFilters.push({ programLinks: { some: { reviewStatus: 'accepted', program: { OR: [
        { id: filters.program },
        { canonicalName: { contains: filters.program, mode: 'insensitive' } },
        { aliases: { some: { alias: { contains: filters.program, mode: 'insensitive' } } } },
      ] } } } });
    }
    if (filters.capability) {
      relationshipFilters.push({ programLinks: { some: { reviewStatus: 'accepted', program: { capabilityArea: { contains: filters.capability, mode: 'insensitive' } } } } });
    }
    if (filters.availability === 'available') where.sourceUrl = { not: null };
    if (filters.availability === 'unavailable') where.sourceUrl = null;
    if (filters.freshness === 'fresh') {
      where.AND = [...(where.AND ?? []), { validTo: null }, { status: 'active' }];
    } else if (filters.freshness === 'stale') {
      where.OR = [{ validTo: { not: null } }, { status: { in: ['historical', 'superseded'] } }];
    }
    if (filters.q) {
      const search = [
        { name: { contains: filters.q, mode: 'insensitive' } },
        { metadata: { path: ['acronym'], equals: filters.q } },
        { metadata: { path: ['aliases'], array_contains: [filters.q] } },
      ];
      where.AND = [...(where.AND ?? []), { OR: search }];
    }
    if (relationshipFilters.length) where.AND = [...(where.AND ?? []), ...relationshipFilters];
    return where;
  }

  private officeToSummary(office: any): DefenseOfficeSummaryDto {
    return {
      id: office.id,
      name: office.name,
      officeType: office.officeType,
      service: office.service,
      parentOfficeId: office.parentOfficeId,
      parentOfficeName: office.parentOffice?.name ?? null,
      status: this.officeStatus(office.status),
      validFrom: office.validFrom?.toISOString() ?? null,
      validTo: office.validTo?.toISOString() ?? null,
      sourceUrl: office.sourceUrl,
      reviewStatus: null,
      confidence: 1.0,
      observedAt: office.createdAt.toISOString(),
      effectiveStart: office.validFrom?.toISOString() ?? null,
      effectiveEnd: office.validTo?.toISOString() ?? null,
      aliases: this.stringArray(this.record(office.metadata).aliases),
      availability: office.sourceUrl ? 'available' : 'partial',
      evidence: this.sourceEvidence(`office:${office.id}`, 'program_office', office.sourceUrl, office.updatedAt ?? office.createdAt),
    };
  }

  private officeToDetail(office: any): DefenseOfficeDetailDto {
    const summary = this.officeToSummary(office);
    const leadership = office.roles.map((role: any) => ({
      personId: role.person.id,
      personName: role.person.fullName,
      roleTitle: role.roleTitle,
      roleType: role.roleType,
      contactUse: role.contactUse,
      observedAt: role.observedAt.toISOString(),
      effectiveStart: role.effectiveStart?.toISOString() ?? null,
      effectiveEnd: role.effectiveEnd?.toISOString() ?? null,
      reviewStatus: this.reviewState(role.reviewStatus),
      sourceUrl: role.sourceUrl,
      evidence: this.sourceEvidence(`person-role:${role.id}`, role.source, role.sourceUrl, role.observedAt),
    }));
    const programs = office.programLinks.map((link: any) => ({
      programId: link.program.id,
      programName: link.program.canonicalName,
      relation: this.officeProgramRelation(link.relation),
      reviewStatus: this.reviewState(link.reviewStatus),
      sourceUrl: link.sourceUrl,
      evidence: this.sourceEvidence(`office-program:${link.id}`, 'program_office_program_link', link.sourceUrl, link.updatedAt),
    }));
    const metadata = this.record(office.metadata);
    const mission = this.optionalString(metadata.mission);
    const responsibilities = this.optionalString(metadata.responsibilities);
    const scope = this.optionalString(metadata.scope);
    const contact = this.optionalString(metadata.contact);
    const website = this.optionalString(metadata.website);
    const coverage: DefenseOfficeDetailDto['coverage'] = {
      mission: mission ? 'available' : 'unavailable',
      responsibilities: responsibilities ? 'available' : 'unavailable',
      scope: scope ? 'available' : 'unavailable',
      leadership: leadership.length ? 'available' : 'unavailable',
      programs: programs.length ? 'available' : 'unavailable',
      contact: contact ? 'available' : 'unavailable',
      website: website ? 'available' : 'unavailable',
    };
    return {
      ...summary,
      mission,
      responsibilities,
      scope,
      leadership,
      programs,
      contact,
      website,
      hierarchy: {
        parent: office.parentOffice ? this.officeToSummary(office.parentOffice) : null,
        children: office.childOffices.map((child: any) => this.officeToSummary(child)),
      },
      coverage,
    };
  }

  private optionalString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
  private stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
  private officeStatus(value: string): OfficeStatus { return ['active', 'historical', 'superseded', 'unresolved'].includes(value) ? value as OfficeStatus : 'unresolved'; }
  private reviewState(value: string): 'accepted' | 'candidate' | 'quarantined' { return value === 'accepted' || value === 'quarantined' ? value : 'candidate'; }
  private relationshipValidity(status: string, validTo: Date | null): DefenseRelationshipEdgeDto['validity'] {
    if (status === 'unresolved') return 'unresolved';
    if (status === 'superseded' || status === 'historical' || (validTo && validTo < new Date())) return 'superseded';
    return 'valid';
  }
  private officeProgramRelation(value: string): OfficeRelation {
    if (value === 'manages' || value === 'executes' || value === 'supports') return value;
    return 'supports';
  }
  private sourceEvidence(id: string, family: string, sourceUrl: string | null, observedAt: Date | null): DefenseEvidenceRefDto[] {
    if (!sourceUrl) return [];
    return [{
      evidenceRefId: id,
      sourceDocumentId: null,
      sourceRevisionId: null,
      sourceFamily: family,
      publisher: this.publisherFromUrl(sourceUrl),
      sourceUrl,
      nativeLocator: { page: null, section: null, occurrenceId: null },
      contentHash: null,
      edition: null,
      observedAt: observedAt?.toISOString() ?? null,
    }];
  }
}
