import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ExplorerService } from './explorer.service.js';

/**
 * Coerce a CSV string OR repeated query param into an array of strings.
 * Lets the frontend pass `?issueCodes=DEF,HCR` OR `?issueCodes=DEF&issueCodes=HCR`.
 */
function arrayOrSplit(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : String(v ?? '')))
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim().length) {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return undefined;
}

class CommonPagingDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  sort?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

class LdaFilingsQuery extends CommonPagingDto {
  @IsOptional()
  @IsArray()
  issueCodes?: string[] | string;

  @IsOptional()
  @IsArray()
  years?: string[] | string;

  @IsOptional()
  @IsArray()
  filingTypes?: string[] | string;

  @IsOptional()
  @IsArray()
  states?: string[] | string;

  @IsOptional()
  @IsArray()
  periods?: string[] | string;

  @IsOptional()
  @Type(() => Number)
  minIncome?: number;

  @IsOptional()
  @Type(() => Number)
  maxIncome?: number;
}

class ContractorsQuery extends CommonPagingDto {
  @IsOptional()
  @IsArray()
  categories?: string[] | string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  hasNoBid?: boolean;

  @IsOptional()
  @Type(() => Number)
  minContracts?: number;

  @IsOptional()
  @Type(() => Number)
  maxContracts?: number;
}

class BillsQuery extends CommonPagingDto {
  @IsOptional()
  @IsArray()
  congress?: string[] | string;

  @IsOptional()
  @IsArray()
  subjects?: string[] | string;

  @IsOptional()
  @IsArray()
  sponsorParty?: string[] | string;

  @IsOptional()
  @IsArray()
  originChamber?: string[] | string;

  @IsOptional()
  @IsArray()
  policyAreas?: string[] | string;
}

class FedRegQuery extends CommonPagingDto {
  @IsOptional()
  @IsArray()
  types?: string[] | string;

  @IsOptional()
  @IsArray()
  agencies?: string[] | string;

  @IsOptional()
  @IsArray()
  topics?: string[] | string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  significantOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  openCommentOnly?: boolean;
}

@Controller('explorer')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ExplorerController {
  constructor(private readonly service: ExplorerService) {}

  @Get('lda-filings')
  ldaFilings(@Query() q: LdaFilingsQuery) {
    return this.service.ldaFilings({
      q: q.q,
      issueCodes: arrayOrSplit(q.issueCodes),
      years: arrayOrSplit(q.years)?.map((y) => Number.parseInt(y, 10)).filter((n) => Number.isFinite(n)),
      filingTypes: arrayOrSplit(q.filingTypes),
      states: arrayOrSplit(q.states),
      periods: arrayOrSplit(q.periods),
      minIncome: q.minIncome,
      maxIncome: q.maxIncome,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('lda-facets')
  ldaFacets() {
    return this.service.ldaFacets();
  }

  @Get('federal-contractors')
  contractors(@Query() q: ContractorsQuery) {
    return this.service.federalContractors({
      q: q.q,
      categories: arrayOrSplit(q.categories),
      hasNoBid: q.hasNoBid,
      minContracts: q.minContracts,
      maxContracts: q.maxContracts,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('contractor-facets')
  contractorFacets() {
    return this.service.contractorFacets();
  }

  @Get('congress-bills')
  bills(@Query() q: BillsQuery) {
    return this.service.congressBills({
      q: q.q,
      congress: arrayOrSplit(q.congress)?.map((c) => Number.parseInt(c, 10)).filter((n) => Number.isFinite(n)),
      subjects: arrayOrSplit(q.subjects),
      sponsorParty: arrayOrSplit(q.sponsorParty),
      originChamber: arrayOrSplit(q.originChamber),
      policyAreas: arrayOrSplit(q.policyAreas),
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('bill-facets')
  billFacets() {
    return this.service.billFacets();
  }

  @Get('federal-register')
  fedReg(@Query() q: FedRegQuery) {
    return this.service.federalRegisterDocs({
      q: q.q,
      types: arrayOrSplit(q.types),
      agencies: arrayOrSplit(q.agencies),
      topics: arrayOrSplit(q.topics),
      significantOnly: q.significantOnly,
      openCommentOnly: q.openCommentOnly,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('fed-reg-facets')
  fedRegFacets() {
    return this.service.fedRegFacets();
  }

  /* ── Committee hearings ──────────────────────────────────────────────── */

  @Get('hearings')
  hearings(@Query() q: CommonPagingDto & Record<string, unknown>) {
    const df = typeof q.dateFilter === 'string' ? q.dateFilter : undefined;
    const dateFilter =
      df === 'upcoming' || df === 'past' || df === 'all' ? df : undefined;
    return this.service.committeeHearings({
      q: q.q,
      chambers: arrayOrSplit(q.chambers),
      committees: arrayOrSplit(q.committees),
      types: arrayOrSplit(q.types),
      futureOnly: q.futureOnly === 'true' || q.futureOnly === true,
      dateFilter,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('hearing-facets')
  hearingFacets() {
    return this.service.hearingFacets();
  }

  /* ── GAO reports ─────────────────────────────────────────────────────── */

  @Get('gao')
  gao(@Query() q: CommonPagingDto & Record<string, unknown>) {
    return this.service.gaoReports({
      q: q.q,
      reportTypes: arrayOrSplit(q.reportTypes),
      topics: arrayOrSplit(q.topics),
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('gao-facets')
  gaoFacets() {
    return this.service.gaoFacets();
  }

  /* ── CRS reports ─────────────────────────────────────────────────────── */

  @Get('crs')
  crs(@Query() q: CommonPagingDto & Record<string, unknown>) {
    return this.service.crsReports({
      q: q.q,
      topics: arrayOrSplit(q.topics),
      activeOnly: q.activeOnly === 'true' || q.activeOnly === true,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('crs-facets')
  crsFacets() {
    return this.service.crsFacets();
  }

  /* ── FEC contributions ───────────────────────────────────────────────── */

  @Get('fec-contributions')
  fec(@Query() q: CommonPagingDto & Record<string, unknown>) {
    return this.service.fecContributions({
      q: q.q,
      cycles: arrayOrSplit(q.cycles)
        ?.map((c) => Number.parseInt(c, 10))
        .filter((n) => Number.isFinite(n)),
      states: arrayOrSplit(q.states),
      minAmount: typeof q.minAmount === 'string' ? Number(q.minAmount) : undefined,
      maxAmount: typeof q.maxAmount === 'string' ? Number(q.maxAmount) : undefined,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('fec-facets')
  fecFacets() {
    return this.service.fecFacets();
  }

  /* ── FARA registrations ──────────────────────────────────────────────── */

  @Get('fara')
  fara(@Query() q: CommonPagingDto & Record<string, unknown>) {
    return this.service.faraRegistrations({
      q: q.q,
      countries: arrayOrSplit(q.countries),
      statuses: arrayOrSplit(q.statuses),
      states: arrayOrSplit(q.states),
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('fara-facets')
  faraFacets() {
    return this.service.faraFacets();
  }

  /* ── SEC filings ─────────────────────────────────────────────────────── */

  @Get('sec')
  sec(@Query() q: CommonPagingDto & Record<string, unknown>) {
    return this.service.secFilings({
      q: q.q,
      formTypes: arrayOrSplit(q.formTypes),
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('sec-facets')
  secFacets() {
    return this.service.secFacets();
  }

  /* ── SAM.gov contract opportunities ──────────────────────────────────── */

  @Get('sam-opportunities')
  samOpportunities(@Query() q: CommonPagingDto & Record<string, unknown>) {
    return this.service.samOpportunities({
      q: q.q,
      noticeTypes: arrayOrSplit(q.noticeTypes),
      agencies: arrayOrSplit(q.agencies),
      naics: typeof q.naics === 'string' ? q.naics : undefined,
      psc: typeof q.psc === 'string' ? q.psc : undefined,
      activeOnly: q.activeOnly === 'false' || q.activeOnly === false ? false : true,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('sam-opportunity-facets')
  samOpportunityFacets() {
    return this.service.samOpportunityFacets();
  }

  /* ── Federal awards (USAspending) ────────────────────────────────────── */

  @Get('federal-awards')
  federalAwards(@Query() q: CommonPagingDto & Record<string, unknown>) {
    return this.service.federalAwards({
      q: q.q,
      agencies: arrayOrSplit(q.agencies),
      states: arrayOrSplit(q.states),
      fiscalYears: arrayOrSplit(q.fiscalYears)?.map((v) => Number(v)).filter((n) => !Number.isNaN(n)),
      minAmount: typeof q.minAmount === 'string' && q.minAmount !== '' ? Number(q.minAmount) : undefined,
      maxAmount: typeof q.maxAmount === 'string' && q.maxAmount !== '' ? Number(q.maxAmount) : undefined,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('federal-award-facets')
  federalAwardFacets() {
    return this.service.federalAwardFacets();
  }

  /* ── Federal grants (Grants.gov) ─────────────────────────────────────── */

  @Get('federal-grants')
  federalGrants(@Query() q: CommonPagingDto & Record<string, unknown>) {
    return this.service.federalGrants({
      q: q.q,
      agencies: arrayOrSplit(q.agencies),
      statuses: arrayOrSplit(q.statuses),
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('federal-grant-facets')
  federalGrantFacets() {
    return this.service.federalGrantFacets();
  }

  /* ── State legislators (OpenStates) ──────────────────────────────────── */

  @Get('state-legislators')
  stateLegislators(@Query() q: CommonPagingDto & Record<string, unknown>) {
    return this.service.stateLegislators({
      q: q.q,
      states: arrayOrSplit(q.states),
      chambers: arrayOrSplit(q.chambers),
      parties: arrayOrSplit(q.parties),
      // Singular, NOT arrayOrSplit — committee names contain commas.
      committee: typeof q.committee === 'string' ? q.committee : undefined,
      includeCommittees: q.includeCommittees === 'true' || q.includeCommittees === true,
      activeOnly: q.activeOnly === 'false' || q.activeOnly === false ? false : true,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('state-legislator-facets')
  stateLegislatorFacets(@Query() q: Record<string, unknown>) {
    return this.service.stateLegislatorFacets({ states: arrayOrSplit(q.states) });
  }

  @Get('state-legislators/:id')
  async stateLegislatorDetail(@Param('id') id: string) {
    const detail = await this.service.stateLegislatorDetail(id);
    if (!detail) throw new NotFoundException('State legislator not found');
    return detail;
  }

  /* ── Intel articles (news) ───────────────────────────────────────────── */

  @Get('intel-articles')
  intelArticles(@Query() q: CommonPagingDto & Record<string, unknown>) {
    return this.service.intelArticles({
      q: q.q,
      sources: arrayOrSplit(q.sources),
      topics: arrayOrSplit(q.topics),
      agencies: arrayOrSplit(q.agencies),
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('intel-article-facets')
  intelArticleFacets() {
    return this.service.intelArticleFacets();
  }

  /* ── State bills ─────────────────────────────────────────────────────── */

  @Get('state-bills')
  stateBills(@Query() q: CommonPagingDto & Record<string, unknown>) {
    return this.service.stateBills({
      q: q.q,
      states: arrayOrSplit(q.states),
      subjects: arrayOrSplit(q.subjects),
      sponsorParty: arrayOrSplit(q.sponsorParty),
      chambers: arrayOrSplit(q.chambers),
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('state-bill-facets')
  stateBillFacets() {
    return this.service.stateBillFacets();
  }

  /* ── Detail endpoints (drill-in) ─────────────────────────────────────── */

  @Get('lda-filings/:id')
  ldaFilingDetail(@Param('id') id: string) {
    return this.service.ldaFilingDetail(id);
  }

  @Get('congress-bills/:id')
  billDetail(@Param('id') id: string) {
    return this.service.billDetail(id);
  }

  @Get('federal-contractors/:id')
  contractorDetail(@Param('id') id: string) {
    return this.service.contractorDetail(id);
  }

  @Get('federal-register/:id')
  fedRegDetail(@Param('id') id: string) {
    return this.service.fedRegDetail(id);
  }

  @Get('hearings/:id')
  hearingDetail(@Param('id') id: string) {
    return this.service.hearingDetail(id);
  }

  @Get('gao/:id')
  gaoDetail(@Param('id') id: string) {
    return this.service.gaoDetail(id);
  }

  @Get('crs/:id')
  crsDetail(@Param('id') id: string) {
    return this.service.crsDetail(id);
  }

  @Get('fec-contributions/:id')
  fecDetail(@Param('id') id: string) {
    return this.service.fecDetail(id);
  }

  @Get('fara/:id')
  faraDetail(@Param('id') id: string) {
    return this.service.faraDetail(id);
  }

  @Get('sec/:id')
  secDetail(@Param('id') id: string) {
    return this.service.secDetail(id);
  }

  @Get('intel-articles/:id')
  intelArticleDetail(@Param('id') id: string) {
    return this.service.intelArticleDetail(id);
  }

  @Get('state-bills/:id')
  stateBillDetail(@Param('id') id: string) {
    return this.service.stateBillDetail(id);
  }
}
