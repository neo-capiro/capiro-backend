import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DistrictNexusService } from '../../district-nexus/district-nexus.service.js';
import { DistrictNexusStrategicService } from '../../district-nexus/district-nexus-strategic.service.js';
import { DistrictNexusEconomicService } from '../../district-nexus/district-nexus-economic.service.js';
import { DistrictNexusPriorityIntelligenceService } from '../../district-nexus/priority-intelligence/priority-intelligence.service.js';
import { DistrictNexusFlagGuard } from '../../district-nexus/district-nexus-flag.guard.js';
import { DistrictNexusStrategicFlagGuard } from '../../district-nexus/district-nexus-strategic-flag.guard.js';
import { DistrictNexusEconomicFlagGuard } from '../../district-nexus/district-nexus-economic-flag.guard.js';
import { DistrictNexusPriorityIntelligenceFlagGuard } from '../../district-nexus/priority-intelligence/priority-intelligence-flag.guard.js';
import {
  DISTRICT_NEXUS_EXTERNAL_CONTEXT_FEATURE, DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE,
  DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE,
} from '../../district-nexus/district-nexus-economic.types.js';
import type { RetrievalSourceAdapter } from '../retrieval-source.adapter.js';
import type { RetrievalRecord, RetrievalRequest, RetrievalSourceResult, SemanticDatasetDescriptor } from '../retrieval-v2.types.js';
import { currentReadError, governmentJson, governmentPageSize, governmentResult, visibleGovernmentClients } from './government-work-retrieval.helpers.js';

const DOMAIN = 'district_nexus' as const;
const QUERY_CLASSES = new Set(['lookup', 'portfolio_scan', 'comparison', 'federal_market_analysis']);
interface NexusCursor { client: string; offset: number }
interface RailRead { key: string; authorize?: () => Promise<boolean>; read: () => Promise<unknown> }

/** Composes existing Nexus readers and their existing entitlements; never reimplements their scores. */
@Injectable()
export class DistrictNexusRetrievalAdapter implements RetrievalSourceAdapter {
  readonly key = 'district-nexus';
  readonly domains = [DOMAIN] as const;
  constructor(
    private readonly prisma: PrismaService,
    private readonly nexus: DistrictNexusService,
    private readonly strategic: DistrictNexusStrategicService,
    private readonly economic: DistrictNexusEconomicService,
    private readonly priority: DistrictNexusPriorityIntelligenceService,
    private readonly baseGate: DistrictNexusFlagGuard,
    private readonly strategicGate: DistrictNexusStrategicFlagGuard,
    private readonly economicGate: DistrictNexusEconomicFlagGuard,
    private readonly priorityGate: DistrictNexusPriorityIntelligenceFlagGuard,
  ) {}

  async retrieve(dataset: SemanticDatasetDescriptor, request: RetrievalRequest, cursor?: string): Promise<RetrievalSourceResult> {
    const invalid = currentReadError(request);
    if (dataset.domain !== DOMAIN || !QUERY_CLASSES.has(request.queryClass) || invalid || request.windowStart || request.windowEnd) {
      return governmentResult(DOMAIN, request, { stopReason: invalid ?? 'current_client_snapshot_only' });
    }
    const parsed = parseCursor(cursor);
    if (cursor && !parsed) return governmentResult(DOMAIN, request, { stopReason: 'invalid_cursor' });
    const { tenantId, userId } = request.caller;
    const clients = await this.prisma.withTenantUser(tenantId, userId, (tx) => visibleGovernmentClients(tx, request));
    if (clients.denied || !clients.ids.length) return governmentResult(DOMAIN, request, {
      sourceStatus: clients.denied ? 'unauthorized' : 'unsupported',
      stopReason: clients.denied ? 'client_wall_or_security_envelope_denied'
        : clients.excludedArchived ? 'archived_client_subjects_excluded' : 'authorized_client_scope_required',
    });
    let clientIndex = parsed ? clients.ids.indexOf(parsed.client) : 0;
    if (clientIndex < 0) return governmentResult(DOMAIN, request, { stopReason: 'cursor_outside_current_client_scope' });
    const clientId = clients.ids[clientIndex]!;
    try { await this.baseGate.assertEnabledForTenant(tenantId); } catch {
      return governmentResult(DOMAIN, request, { sourceStatus: 'unauthorized', stopReason: 'district_nexus_feature_not_available' });
    }
    let base: Awaited<ReturnType<DistrictNexusService['getClientDistrictNexus']>>;
    try { base = await this.nexus.getClientDistrictNexus(clientId, tenantId); } catch {
      return governmentResult(DOMAIN, request, { sourceStatus: 'unavailable', stopReason: 'district_nexus_source_read_failed' });
    }
    const reads: RailRead[] = [
      { key: 'verified_footprint', read: async () => base },
      { key: 'strategic_relevance', authorize: () => this.strategicGate.assertEnabledForTenant(tenantId), read: () => this.strategic.getClientStrategicMap(tenantId, clientId) },
      { key: 'economic_footprint', authorize: () => this.economicGate.assertEnabledForTenant(tenantId, DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE), read: () => this.economic.getClientFootprint(tenantId, clientId) },
      { key: 'supplier_footprint_status', authorize: () => this.economicGate.assertEnabledForTenant(tenantId, DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE), read: () => this.economic.getSupplierFootprintStatus(tenantId, clientId) },
    ];
    // Only the client's existing district footprint is expanded. Do not turn a
    // retrieval request into an unbounded national scan or fabricate relevance.
    const districts = [...new Set(base.districts.map((district) => district.districtKey))].sort();
    for (const key of districts) {
      const match = /^([A-Z]{2})-(\d{1,2})$/.exec(key);
      if (!match) continue;
      const state = match[1]!;
      const district = match[2]!;
      reads.push(
        { key: `economic_context:${key}`, authorize: () => this.economicGate.assertEnabledForTenant(tenantId, DISTRICT_NEXUS_EXTERNAL_CONTEXT_FEATURE), read: () => this.economic.getDistrictContext(state, district) },
        { key: `priority_intelligence:${key}`, authorize: () => this.priorityGate.assertEnabledForTenant(tenantId), read: () => this.priority.getClientDistrictPriorityIntelligence(tenantId, clientId, state, district) },
      );
    }
    const offset = parsed?.offset ?? 0;
    if (offset >= reads.length) return governmentResult(DOMAIN, request, { stopReason: 'cursor_invalidated_by_current_footprint' });
    const pageSize = Math.min(10, governmentPageSize(request));
    const page = reads.slice(offset, offset + pageSize);
    const records: RetrievalRecord[] = [];
    for (const rail of page) {
      let status: 'available' | 'unauthorized' | 'unavailable' = 'available';
      let data: unknown = null;
      if (rail.authorize) {
        try { await rail.authorize(); } catch { status = 'unauthorized'; }
      }
      if (status === 'available') {
        try { data = await rail.read(); } catch { status = 'unavailable'; }
      }
      records.push({
        domain: DOMAIN, recordId: `${clientId}:${rail.key}`,
        payload: governmentJson({ clientId, rail: rail.key, status, data,
          queryFilterApplied: false, queryMode: 'current_client_snapshot',
          coverage: 'Current domain-service summary; source detail limits and rail warnings apply. This is not an exhaustive historical dataset.',
        }),
        provenance: { adapter: this.key, tenantId, clientId, sourceService: sourceService(rail.key),
          sourceRef: `district-nexus:${clientId}:${rail.key}` },
      });
    }
    // Recheck current walls after domain services' tenant-scoped transactions.
    // A grant revoked during the multi-rail read must not release those records.
    const finalScope = await this.prisma.withTenantUser(tenantId, userId, (tx) => visibleGovernmentClients(tx, request));
    if (finalScope.denied || !finalScope.ids.includes(clientId)) return governmentResult(DOMAIN, request, {
      sourceStatus: 'unauthorized', stopReason: 'client_access_changed_during_read',
    });
    const moreRails = offset + page.length < reads.length;
    if (!moreRails) clientIndex += 1;
    const hasMore = moreRails || clientIndex < clients.ids.length;
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({
      client: moreRails ? clientId : clients.ids[clientIndex], offset: moreRails ? offset + page.length : 0,
    })).toString('base64url') : undefined;
    const timestamps = base.freshness.map((source) => source.lastSyncedAt ? new Date(source.lastSyncedAt) : null);
    const lastSyncAt = timestamps.length && timestamps.every((date) => date && Number.isFinite(date.getTime()))
      ? new Date(Math.min(...timestamps.map((date) => date!.getTime()))) : undefined;
    return governmentResult(DOMAIN, request, {
      records, returned: records.length, hasMore, ...(nextCursor ? { nextCursor } : {}),
      // Domain readers cap detail rows. Preserve useful snapshots while making
      // no claim of exhaustive evidence, even when every snapshot page was read.
      truncated: true, sourceStatus: 'degraded', ...(lastSyncAt ? { lastSyncAt } : {}),
      recordsEvaluated: page.length, requestedEntityCount: clients.requested, searchedEntityCount: 1,
      pagesRead: 1, paginationComplete: !hasMore, coverageComplete: false,
      stopReason: records.some((record) => record.payload.status !== 'available')
        ? 'district_nexus_snapshot_some_rails_unavailable'
        : 'district_nexus_current_summaries_source_detail_capped',
    });
  }
}

function parseCursor(cursor?: string): NexusCursor | undefined {
  if (!cursor || cursor.length > 512) return undefined;
  try {
    const data = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as NexusCursor;
    return typeof data.client === 'string' && Number.isSafeInteger(data.offset) && data.offset >= 0 ? data : undefined;
  } catch { return undefined; }
}

function sourceService(key: string): string {
  if (key === 'verified_footprint') return 'DistrictNexusService';
  if (key === 'strategic_relevance') return 'DistrictNexusStrategicService';
  if (key.startsWith('priority_intelligence:')) return 'DistrictNexusPriorityIntelligenceService';
  return 'DistrictNexusEconomicService';
}
