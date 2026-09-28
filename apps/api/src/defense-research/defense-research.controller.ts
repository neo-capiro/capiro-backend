import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type {
  TenantContext,
  DefenseContextDocumentDetailDto,
  DefenseContextDocumentListDto,
  DefenseContextDocumentRevisionDto,
  DefenseContextSectionDto,
  DefenseDossierDto,
  DefenseEvidenceRefDto,
  DefenseFundingMatrixDto,
  DefenseMilestoneResponseDto,
  DefenseReferenceOccurrenceDto,
  DefenseResearchAvailability,
  DefenseOfficeListDto,
  DefenseOfficeDetailDto,
  DefenseRelationshipListDto,
  OfficeStatus,
  DefenseAcquisitionRecordListDto,
  DefenseAcquisitionRecordDetailDto,
  DefenseAcquisitionRecordActionDto,
  DefenseAcquisitionCoverageGapListDto,
  DefenseSearchResponseDto,
  DefenseComparisonResponseDto,
  DefenseProductCoverageResponseDto,
} from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { DefenseResearchService } from './defense-research.service.js';

@Controller('defense-budget')
@UseGuards(RolesGuard)
@Roles('standard_user', 'user_admin', 'capiro_admin')
export class DefenseResearchController {
  constructor(private readonly service: DefenseResearchService) {}

  @Get('dossiers/:subjectType/:subjectId/milestones')
  milestones(
    @Param('subjectType') subjectType: string,
    @Param('subjectId') subjectId: string,
  ): Promise<DefenseMilestoneResponseDto> {
    return this.service.milestones(subjectType, subjectId);
  }

  @Get('dossiers/:subjectType/:subjectId')
  dossier(
    @Param('subjectType') subjectType: string,
    @Param('subjectId') subjectId: string,
  ): Promise<DefenseDossierDto> {
    return this.service.dossier(subjectType, subjectId);
  }

  @Get('funding-matrix/:subjectType/:subjectId/editions')
  async fundingEditions(
    @Param('subjectType') subjectType: string,
    @Param('subjectId') subjectId: string,
  ): Promise<readonly string[]> {
    return (await this.service.fundingMatrix(subjectType, subjectId)).supported.editions;
  }

  @Get('funding-matrix/:subjectType/:subjectId')
  fundingMatrix(
    @Param('subjectType') subjectType: string,
    @Param('subjectId') subjectId: string,
    @Query('knownAt') knownAt?: string,
  ): Promise<DefenseFundingMatrixDto> {
    return this.service.fundingMatrix(subjectType, subjectId, knownAt);
  }

  @Get('context-documents')
  contextDocuments(
    @Query('family') family?: string,
    @Query('publisher') publisher?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): Promise<DefenseContextDocumentListDto> {
    const parsed = limit ? Number.parseInt(limit, 10) : 50;
    return this.service.listContextDocuments({
      family,
      publisher,
      status,
      limit: Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50,
    });
  }

  @Get('context-documents/:documentId/revisions')
  contextRevisions(
    @Param('documentId') documentId: string,
  ): Promise<readonly DefenseContextDocumentRevisionDto[]> {
    return this.service.contextRevisions(documentId);
  }

  @Get('context-documents/:documentId/sections')
  contextSections(
    @Param('documentId') documentId: string,
  ): Promise<readonly DefenseContextSectionDto[]> {
    return this.service.contextSections(documentId);
  }

  @Get('context-documents/:documentId/references')
  references(
    @Param('documentId') documentId: string,
  ): Promise<readonly DefenseReferenceOccurrenceDto[]> {
    return this.service.references(documentId);
  }

  @Get('context-documents/:documentId/cited-by')
  citedBy(
    @Param('documentId') documentId: string,
  ): Promise<readonly DefenseReferenceOccurrenceDto[]> {
    return this.service.citedBy(documentId);
  }

  @Get('context-documents/:documentId')
  contextDocument(
    @Param('documentId') documentId: string,
  ): Promise<DefenseContextDocumentDetailDto> {
    return this.service.contextDocument(documentId);
  }

  @Get('reference-occurrences/:occurrenceId')
  referenceOccurrence(
    @Param('occurrenceId') occurrenceId: string,
  ): Promise<DefenseReferenceOccurrenceDto> {
    return this.service.referenceOccurrence(occurrenceId);
  }

  @Get('offices')
  listOffices(
    @Query('agency') agency?: string,
    @Query('component') component?: string,
    @Query('officeType') officeType?: string,
    @Query('capability') capability?: string,
    @Query('program') program?: string,
    @Query('status') status?: OfficeStatus,
    @Query('availability') availability?: DefenseResearchAvailability,
    @Query('freshness') freshness?: 'fresh' | 'stale' | 'any',
    @Query('q') q?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<DefenseOfficeListDto> {
    return this.service.listOffices({
      agency,
      component,
      officeType,
      capability,
      program,
      status,
      availability,
      freshness,
      q,
      page,
      limit,
    });
  }

  @Get('offices/:officeId')
  getOffice(@Param('officeId') officeId: string): Promise<DefenseOfficeDetailDto> {
    return this.service.getOffice(officeId);
  }

  @Get('relationships')
  getRelationships(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('edgeType') edgeType?: string,
    @Query('status') status?: string,
    @Query('includeSpeculative') includeSpeculative?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<DefenseRelationshipListDto> {
    return this.service.getRelationships({
      from,
      to,
      edgeType,
      status,
      includeSpeculative: includeSpeculative === 'true',
      page,
      limit,
    });
  }

  @Get('acquisition-records')
  getAcquisitionRecords(
    @Query('q') q?: string,
    @Query('sourceSystem') sourceSystem?: string,
    @Query('recordKind') recordKind?: string,
    @Query('status') status?: string,
    @Query('buyerOffice') buyerOffice?: string,
    @Query('activeOn') activeOn?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<DefenseAcquisitionRecordListDto> {
    return this.service.getAcquisitionRecords({
      q,
      sourceSystem,
      recordKind,
      status,
      buyerOffice,
      activeOn,
      page,
      limit,
    });
  }

  @Get('acquisition-records/:identityKey/actions')
  getAcquisitionActions(
    @Param('identityKey') identityKey: string,
  ): Promise<readonly DefenseAcquisitionRecordActionDto[]> {
    return this.service.getAcquisitionActions(identityKey);
  }

  @Get('acquisition-records/:identityKey')
  getAcquisitionRecord(
    @Param('identityKey') identityKey: string,
    @Query('includeSpeculative') includeSpeculative?: string,
  ): Promise<DefenseAcquisitionRecordDetailDto> {
    return this.service.getAcquisitionRecord(identityKey, includeSpeculative === 'true');
  }

  @Get('acquisition-coverage')
  getAcquisitionCoverage(
    @Query('subjectKind') subjectKind: string,
    @Query('subjectKey') subjectKey: string,
  ): Promise<DefenseAcquisitionCoverageGapListDto> {
    return this.service.getAcquisitionCoverage(subjectKind, subjectKey);
  }

  @Get('evidence/:evidenceRefId')
  evidence(@Param('evidenceRefId') evidenceRefId: string): Promise<DefenseEvidenceRefDto> {
    return this.service.resolveEvidence(evidenceRefId);
  }

  @Get('search')
  search(
    @CurrentTenant() ctx: TenantContext,
    @Query('q') q: string,
    @Query('semanticEnabled') semanticEnabled?: string,
  ): Promise<DefenseSearchResponseDto> {
    return this.service.search(q, semanticEnabled === 'true', ctx);
  }

  @Get('compare')
  compare(@Query('subjects') subjects: string): Promise<DefenseComparisonResponseDto> {
    return this.service.compare(
      subjects
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  @Get('product-coverage')
  productCoverage(
    @Query('perimeter') perimeter?: string,
    @Query('component') component?: string,
    @Query('account') account?: string,
    @Query('family') family?: string,
    @Query('fiscalYear') fiscalYear?: string,
    @Query('edition') edition?: string,
    @Query('stage') stage?: string,
    @Query('detail') detail?: string,
  ): Promise<DefenseProductCoverageResponseDto> {
    return this.service.productCoverage({
      perimeter,
      component,
      account,
      family,
      fiscalYear: fiscalYear ? Number.parseInt(fiscalYear, 10) : undefined,
      edition,
      stage,
      detail,
    });
  }
}
