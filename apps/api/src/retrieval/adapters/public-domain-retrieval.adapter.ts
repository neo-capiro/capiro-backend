import { Injectable, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DirectoryService } from '../../directory/directory.service.js';
import { FederalMarketService } from '../../federal-spending/federal-market.service.js';
import { FundingOpportunitiesService } from '../../funding-opportunities/funding-opportunities.service.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  FUNDING_OPPORTUNITIES_MERI_V2_FEATURE,
  isFundingOpportunitiesFeatureEnabled,
} from '../../funding-opportunities/funding-opportunities-flag.guard.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ProgramElementReadService } from '../../program-element/program-element-read.service.js';
import type { RetrievalSourceAdapter } from '../retrieval-source.adapter.js';
import type {
  RetrievalDomain,
  RetrievalRequest,
  RetrievalSourceResult,
  SemanticDatasetDescriptor,
} from '../retrieval-v2.types.js';
import { PublicBillReadService } from './public-bill-read.service.js';
import {
  decodePublicCursor,
  encodePublicCursor,
  oldestSourceDate,
  publicJson,
  publicPageSize,
  publicRecord,
  publicResult,
  sourceDate,
  type PublicDomainCursor,
} from './public-domain-retrieval.helpers.js';

/** Explicit contract with already-registered domain providers; no service-name guessing. */
export const PUBLIC_RETRIEVAL_SERVICE_CONTRACTS = [
  { token: ProgramElementReadService, method: 'listProgramElements' },
  { token: FundingOpportunitiesService, method: 'listOpportunities' },
  { token: FederalMarketService, method: 'listContracts' },
  { token: DirectoryService, method: 'getPeople' },
] as const;

const DOMAINS = [
  'program_elements',
  'legiwatch_bills',
  'grants',
  'contracts_opportunities',
  'federal_awards',
  'directory',
] as const;
const QUERY_CLASSES = new Set([
  'lookup',
  'comparison',
  'exhaustive_search',
  'federal_market_analysis',
]);

/**
 * Connects shared retrieval to production read services. Matching, lifecycle,
 * budget claims and eligibility remain owned by their existing domain services.
 * ModuleRef is a late read boundary: importing entire feature modules into
 * RetrievalModule would make cycles through Meri/Intelligence/Knowledge.
 */
@Injectable()
export class PublicDomainRetrievalAdapter implements RetrievalSourceAdapter {
  readonly key = 'public-domain-services';
  readonly domains = DOMAINS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    private readonly bills: PublicBillReadService,
  ) {}

  async retrieve(
    dataset: SemanticDatasetDescriptor,
    request: RetrievalRequest,
    cursor?: string,
  ): Promise<RetrievalSourceResult> {
    const domain = dataset.domain;
    if (
      !this.domains.includes(domain as (typeof DOMAINS)[number]) ||
      !QUERY_CLASSES.has(request.queryClass) ||
      (request.queryClass === 'federal_market_analysis' &&
        (domain === 'legiwatch_bills' || domain === 'directory'))
    ) {
      return publicResult(domain, request, {
        sourceStatus: 'unsupported',
        stopReason: 'query_class_not_supported',
      });
    }
    if (
      request.asOf ||
      request.observedThrough ||
      request.edgeTypes?.length ||
      request.canonicalEntityIds?.length
    ) {
      return publicResult(domain, request, {
        sourceStatus: 'unsupported',
        stopReason: 'historical_or_canonical_entity_filter_not_supported',
      });
    }
    if (
      [request.windowStart, request.windowEnd].some((date) => date && !sourceDate(date)) ||
      (request.windowStart && request.windowEnd && request.windowStart > request.windowEnd)
    ) {
      return publicResult(domain, request, {
        sourceStatus: 'unsupported',
        stopReason: 'invalid_date_range',
      });
    }
    if (
      (request.windowStart || request.windowEnd) &&
      (domain === 'program_elements' || domain === 'directory')
    ) {
      return publicResult(domain, request, {
        sourceStatus: 'unsupported',
        stopReason: 'date_filter_not_supported',
      });
    }
    const position = decodePublicCursor(domain, request, cursor);
    const clientIds = [...new Set(request.caller.clientIds ?? [])];
    const clientFiltered =
      domain === 'grants' || domain === 'contracts_opportunities' || domain === 'federal_awards';
    if (
      !position ||
      position.subject >= (clientFiltered ? Math.max(1, clientIds.length) : 1) ||
      position.family > (domain === 'legiwatch_bills' ? 1 : 0)
    ) {
      return publicResult(domain, request, {
        sourceStatus: 'unsupported',
        stopReason: 'invalid_or_mismatched_cursor',
      });
    }
    if (domain === 'grants' || domain === 'contracts_opportunities') {
      // Service reads bypass HTTP guards. Preserve the same master/Meri gates
      // and standard-user threshold as MeriOpportunityToolsAdapter before CRM reads.
      try {
        for (const flag of [FUNDING_OPPORTUNITIES_FEATURE, FUNDING_OPPORTUNITIES_MERI_V2_FEATURE]) {
          if (
            !(await isFundingOpportunitiesFeatureEnabled(
              this.prisma,
              request.caller.tenantId,
              flag,
            ))
          ) {
            return publicResult(domain, request, {
              sourceStatus: 'unauthorized',
              stopReason: `feature_disabled:${flag}`,
            });
          }
        }
        const membership = await this.prisma.withTenantUser(
          request.caller.tenantId,
          request.caller.userId,
          (tx) =>
            tx.tenantMembership.findFirst({
              where: {
                tenantId: request.caller.tenantId,
                userId: request.caller.userId,
                status: 'active',
                role: { in: ['standard_user', 'user_admin', 'capiro_admin'] },
              },
              select: { id: true },
            }),
        );
        if (!membership)
          return publicResult(domain, request, {
            sourceStatus: 'unauthorized',
            stopReason: 'standard_user_membership_required',
          });
      } catch {
        return publicResult(domain, request, {
          sourceStatus: 'unavailable',
          stopReason: 'funding_access_check_failed',
        });
      }
    }
    const authorized = new Set(request.caller.authorizedClientIds ?? []);
    if (clientIds.some((id) => !authorized.has(id))) {
      return publicResult(domain, request, {
        sourceStatus: 'unauthorized',
        stopReason: 'client_outside_security_envelope',
      });
    }
    if (clientIds.length) {
      const visible = await this.prisma.withTenantUser(
        request.caller.tenantId,
        request.caller.userId,
        (tx) =>
          tx.client.findMany({
            where: {
              tenantId: request.caller.tenantId,
              id: { in: clientIds },
              status: { not: 'archived' },
              OR: [
                { memoryWall: false },
                {
                  memoryAccessGrants: {
                    some: { userId: request.caller.userId },
                  },
                },
              ],
            },
            select: { id: true },
          }),
      );
      if (visible.length !== clientIds.length) {
        return publicResult(domain, request, {
          sourceStatus: 'unauthorized',
          stopReason: 'client_wall_or_status_denied',
        });
      }
    }

    try {
      if (domain === 'program_elements') return await this.programElements(request, position);
      if (domain === 'legiwatch_bills') return await this.billCatalog(request, position);
      if (domain === 'grants' || domain === 'contracts_opportunities')
        return await this.opportunities(domain, request, position, clientIds);
      if (domain === 'federal_awards') return await this.awards(request, position, clientIds);
      return await this.directory(request, position);
    } catch (error) {
      return publicResult(domain, request, {
        sourceStatus: error instanceof MissingPublicProviderError ? 'unavailable' : 'error',
        stopReason:
          error instanceof MissingPublicProviderError ? error.message : 'domain_read_failed',
      });
    }
  }

  private service<T>(token: Type<T>, method: keyof T): T {
    let service: T;
    try {
      service = this.moduleRef.get(token, { strict: false });
    } catch {
      throw new MissingPublicProviderError(`domain_provider_not_registered:${token.name}`);
    }
    if (typeof service?.[method] !== 'function')
      throw new MissingPublicProviderError(
        `domain_method_not_callable:${token.name}.${String(method)}`,
      );
    return service;
  }

  private async programElements(
    request: RetrievalRequest,
    position: PublicDomainCursor,
  ): Promise<RetrievalSourceResult> {
    const domain = 'program_elements';
    const size = publicPageSize(request);
    // Unscoped catalog read deliberately excludes tenant watch/relevance annotations.
    const page = await this.service(
      ProgramElementReadService,
      'listProgramElements',
    ).listProgramElements({
      q: request.query,
      page: position.page,
      limit: size,
    });
    const records = page.data.map((row) =>
      publicRecord(
        domain,
        row.peCode,
        row,
        {
          sourceType: 'program_element',
          sourceId: row.peCode,
          content: 'current_catalog_and_funding_claims',
          clientScopeApplied: false,
          freshnessBasis: 'returned_record_sync',
        },
        { updatedAt: 'lastSyncedAt' in row ? row.lastSyncedAt : undefined },
      ),
    );
    const more = position.page * size < page.total;
    const partial = Boolean(request.caller.clientIds?.length);
    const freshness = oldestSourceDate(
      page.data.map((row) => ('lastSyncedAt' in row ? row.lastSyncedAt : undefined)),
    );
    // A successful catalog query is not a freshness check. If even one returned
    // row lacks its observation date, do not label the whole page current.
    const sourceMissing = !freshness || page.data.some(
      (row) => !sourceDate('lastSyncedAt' in row ? row.lastSyncedAt : undefined),
    );
    return publicResult(domain, request, {
      records,
      returned: records.length,
      total: page.total,
      recordsEvaluated: records.length,
      pagesRead: 1,
      hasMore: more,
      ...(more
        ? {
            nextCursor: encodePublicCursor(domain, request, {
              ...position,
              page: position.page + 1,
            }),
          }
        : {}),
      truncated: more,
      paginationComplete: !more,
      coverageComplete: !more && !partial && !sourceMissing,
      sourceStatus: partial || sourceMissing ? 'degraded' : 'healthy',
      // Individual known observation dates remain on each source record; a
      // dated subset cannot establish the observation date of the whole page.
      lastSyncAt: sourceMissing ? undefined : freshness,
      stopReason: sourceMissing
        ? 'program_element_source_freshness_unavailable'
        : partial
          ? 'public_catalog_only:client_subject_not_filtered'
          : more
            ? 'page_limit_reached'
            : 'complete_ingested_catalog',
    });
  }

  private async billCatalog(
    request: RetrievalRequest,
    position: PublicDomainCursor,
  ): Promise<RetrievalSourceResult> {
    const domain = 'legiwatch_bills';
    const size = publicPageSize(request);
    const page = await this.bills.readPage(position.family as 0 | 1, request, position.page, size);
    const moreInFamily = position.page * size < page.total;
    const more = moreInFamily || position.family === 0;
    const next = moreInFamily
      ? { ...position, page: position.page + 1 }
      : { ...position, family: 1, page: 1 };
    const partial = Boolean(request.caller.clientIds?.length);
    const sourceMissing = !page.lastSyncAt;
    return publicResult(domain, request, {
      records: page.records,
      returned: page.records.length,
      recordsEvaluated: page.records.length,
      pagesRead: 1,
      // No per-family total: reporting only the federal count as the domain count is incorrect.
      hasMore: more,
      ...(more ? { nextCursor: encodePublicCursor(domain, request, next) } : {}),
      truncated: more,
      paginationComplete: !more,
      coverageComplete: !more && !partial && !sourceMissing,
      sourceStatus: sourceMissing ? 'unavailable' : partial ? 'degraded' : 'healthy',
      lastSyncAt: page.lastSyncAt ?? undefined,
      stopReason: sourceMissing
        ? `source_sync_unavailable:${position.family === 0 ? 'congress' : 'state'}`
        : partial
          ? 'public_catalog_only:client_tracking_not_filtered'
          : more
            ? 'page_limit_reached'
            : 'complete_ingested_bill_summaries',
    });
  }

  private async opportunities(
    domain: 'grants' | 'contracts_opportunities',
    request: RetrievalRequest,
    position: PublicDomainCursor,
    clientIds: string[],
  ): Promise<RetrievalSourceResult> {
    const source = domain === 'grants' ? 'grants_gov' : 'sam_gov';
    const clientId = clientIds[position.subject];
    const size = publicPageSize(request);
    const page = await this.service(
      FundingOpportunitiesService,
      'listOpportunities',
    ).listOpportunities(request.caller.tenantId, {
      source,
      clientId,
      q: request.query,
      activeState: 'all',
      page: position.page,
      pageSize: size,
      deadlineFrom: request.windowStart?.toISOString(),
      deadlineTo: request.windowEnd?.toISOString(),
    });
    const health = page.freshness.find((rail) => rail.source === source);
    const unavailable = health?.neverSynced === true && page.opportunities.length === 0;
    const degraded =
      !health ||
      health.countsUnavailable ||
      !health.lastSyncedAt ||
      health.lastRunDegraded !== false ||
      health.enrichment?.degraded === true ||
      (health.enrichment?.activeAwaitingEnrichment ?? 0) > 0 ||
      page.totalIsCapped ||
      page.missingProfileFields.length > 0;
    const records = page.opportunities.map((row) =>
      publicRecord(
        domain,
        clientId ? `${clientId}:${row.id}` : row.id,
        row,
        publicJson({
          sourceType: source,
          sourceId: row.sourceRecordId,
          sourceUrl: row.sourceUrl,
          clientId: clientId ?? null,
          clientScopeApplied: Boolean(clientId),
          sourceHealth: health ?? null,
          totalIsCapped: page.totalIsCapped,
          missingProfileFields: page.missingProfileFields,
          dateFilterBasis: 'response_deadline',
          sourceWindow: 'existing_funding_opportunity_service_scan',
        }),
        { occurredAt: row.postedDate, updatedAt: row.sourceUpdatedAt },
      ),
    );
    const moreHere = position.page * size < page.total;
    const more = moreHere || position.subject + 1 < clientIds.length;
    const next = moreHere
      ? { ...position, page: position.page + 1 }
      : { ...position, page: 1, subject: position.subject + 1 };
    return publicResult(domain, request, {
      records,
      returned: records.length,
      ...(clientIds.length <= 1 ? { total: page.total } : {}),
      recordsEvaluated: records.length,
      searchedEntityCount: clientId ? position.subject + 1 : 0,
      pagesRead: 1,
      hasMore: more,
      ...(more ? { nextCursor: encodePublicCursor(domain, request, next) } : {}),
      truncated: more || page.totalIsCapped,
      paginationComplete: !more && !page.totalIsCapped,
      coverageComplete: !more && !degraded && !unavailable,
      sourceStatus: unavailable ? 'unavailable' : degraded ? 'degraded' : 'healthy',
      lastSyncAt: sourceDate(health?.lastSyncedAt),
      stopReason: unavailable
        ? 'source_never_synced'
        : page.totalIsCapped
          ? 'domain_source_scan_cap_reached'
          : degraded
            ? 'source_or_profile_partial'
            : more
              ? 'page_limit_reached'
              : 'complete_ingested_opportunity_view',
    });
  }

  private async awards(
    request: RetrievalRequest,
    position: PublicDomainCursor,
    clientIds: string[],
  ): Promise<RetrievalSourceResult> {
    const domain = 'federal_awards';
    const size = publicPageSize(request);
    const clientId = clientIds[position.subject];
    const page = await this.service(FederalMarketService, 'listContracts').listContracts(
      request.caller.tenantId,
      {
        clientId,
        q: request.query,
        page: position.page,
        pageSize: size,
        dateFrom: request.windowStart?.toISOString(),
        dateTo: request.windowEnd?.toISOString(),
      },
    );
    const records = page.items.map((row) =>
      publicRecord(
        domain,
        clientId ? `${clientId}:${row.id}` : row.id,
        row,
        {
          sourceType: 'federal_award',
          sourceId: row.id,
          source: page.source,
          clientId: clientId ?? null,
          clientScopeApplied: Boolean(clientId),
          dateFilterBasis: 'actionDate',
          freshnessBasis: 'newest_matching_award_sync',
        },
        { occurredAt: row.actionDate, updatedAt: row.sourceUpdatedAt },
      ),
    );
    const moreHere = position.page * size < page.total;
    const more = moreHere || position.subject + 1 < clientIds.length;
    const next = moreHere
      ? { ...position, page: position.page + 1 }
      : { ...position, page: 1, subject: position.subject + 1 };
    const freshness = sourceDate(page.asOf);
    return publicResult(domain, request, {
      records,
      returned: records.length,
      ...(clientIds.length <= 1 ? { total: page.total } : {}),
      recordsEvaluated: records.length,
      searchedEntityCount: clientId ? position.subject + 1 : 0,
      pagesRead: 1,
      hasMore: more,
      ...(more ? { nextCursor: encodePublicCursor(domain, request, next) } : {}),
      truncated: more,
      paginationComplete: !more,
      coverageComplete: !more && Boolean(freshness),
      sourceStatus: freshness ? 'healthy' : 'degraded',
      lastSyncAt: freshness,
      stopReason: !freshness
        ? 'matching_source_freshness_unavailable'
        : more
          ? 'page_limit_reached'
          : 'complete_ingested_awards',
    });
  }

  private async directory(
    request: RetrievalRequest,
    position: PublicDomainCursor,
  ): Promise<RetrievalSourceResult> {
    const domain = 'directory';
    const size = publicPageSize(request);
    const page = await this.service(DirectoryService, 'getPeople').getPeople({
      q: request.query,
      current: 'true',
      page: String(position.page),
      pageSize: String(size),
    });
    // The directory clamps out-of-range pages to its last page: suppress replay.
    const rows = (position.page - 1) * size >= page.total ? [] : page.people;
    const records = rows.map((row) =>
      publicRecord(domain, row.id, row, {
        sourceType: 'directory_person',
        sourceId: row.id,
        content: 'current_congressional_member_and_staff_summary',
        clientScopeApplied: false,
        freshnessBasis: 'not_exposed_by_directory_people_service',
      }),
    );
    const more = position.page * size < page.total;
    return publicResult(domain, request, {
      records,
      returned: records.length,
      total: page.total,
      recordsEvaluated: rows.length,
      pagesRead: 1,
      hasMore: more,
      ...(more
        ? {
            nextCursor: encodePublicCursor(domain, request, {
              ...position,
              page: position.page + 1,
            }),
          }
        : {}),
      truncated: more,
      paginationComplete: !more,
      coverageComplete: false,
      sourceStatus: 'degraded',
      stopReason: 'partial_directory:congressional_people_only;source_freshness_unavailable',
    });
  }
}

class MissingPublicProviderError extends Error {}
