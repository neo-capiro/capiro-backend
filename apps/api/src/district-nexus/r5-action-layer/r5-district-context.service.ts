import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DistrictNexusService } from '../district-nexus.service.js';
import { DistrictNexusPriorityIntelligenceService } from '../priority-intelligence/priority-intelligence.service.js';
import { DistrictNexusStrategicService } from '../district-nexus-strategic.service.js';
import { DistrictNexusEconomicService } from '../district-nexus-economic.service.js';
import { DistrictNexusStrategicFlagGuard } from '../district-nexus-strategic-flag.guard.js';
import { DistrictNexusEconomicFlagGuard } from '../district-nexus-economic-flag.guard.js';
import { DistrictNexusPriorityIntelligenceFlagGuard } from '../priority-intelligence/priority-intelligence-flag.guard.js';
import { DISTRICT_NEXUS_EXTERNAL_CONTEXT_FEATURE, DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE } from '../district-nexus-economic.types.js';
import { FederalMarketGeographyService } from '../../federal-spending/federal-market-geography.service.js';
import type { DataQualityWarning, SourceFreshness } from '../district-nexus.types.js';
import type { ProjectedCpfCdsSignal } from '../priority-intelligence/priority-intelligence-cpf-cds.js';
import type { ClientPriorityIntelligenceResponse, RecentChangeRecord } from '../priority-intelligence/priority-intelligence.types.js';
import type { R5DistrictContext, R5Fact, R5FactSection, R5Gap } from './r5-types.js';

function factId(section: R5FactSection, source: string, id: string): string {
  return `${section}:${source}:${id}`;
}

function freshnessFor(source: string, health: SourceFreshness[], stale = false): R5Fact['freshness'] {
  const entry = health.find((item) => item.source === source);
  return {
    lastSyncedAt: entry?.lastSyncedAt ?? null,
    stale: stale || Boolean(entry?.neverSynced),
    unavailable: !entry || Boolean(entry.freshnessUnavailable),
  };
}

function warningCodes(warnings: DataQualityWarning[], districtKey: string): string[] {
  return warnings.filter((w) => !w.districtKey || w.districtKey === districtKey).map((w) => w.code);
}

@Injectable()
export class R5DistrictContextService {
  private readonly logger = new Logger(R5DistrictContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly districtNexus: DistrictNexusService,
    private readonly priorityIntelligence: DistrictNexusPriorityIntelligenceService,
    private readonly strategic: DistrictNexusStrategicService,
    private readonly economic: DistrictNexusEconomicService,
    private readonly strategicFlag: DistrictNexusStrategicFlagGuard,
    private readonly economicFlag: DistrictNexusEconomicFlagGuard,
    private readonly market: FederalMarketGeographyService,
    private readonly priorityFlag: DistrictNexusPriorityIntelligenceFlagGuard,
  ) {}

  async getContext(tenantId: string, clientId: string, state: string, district: string): Promise<R5DistrictContext> {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId, tenantId }, select: { id: true, name: true, status: true } }),
    );
    if (!client || client.status === 'archived') throw new NotFoundException('Client not found');

    const stateCode = state.trim().toUpperCase();
    const facts: R5Fact[] = [];
    const gaps: R5Gap[] = [];
    let sourceHealth: SourceFreshness[] = [];
    try {
      sourceHealth = (await this.districtNexus.getFirmDistrictNexusMap(tenantId, { state: stateCode })).freshness;
    } catch (error) {
      this.logger.error('Source freshness unavailable', error);
      gaps.push({ section: 'footprint', reason: 'Source freshness unavailable', source: null });
    }

    await this.collectDetail(tenantId, clientId, stateCode, district, sourceHealth, facts, gaps);
    // Grants.gov client grant candidates are a separate, client-level pipeline that is not yet
    // projected into district facts; say so rather than letting the opportunities section look complete.
    gaps.push({
      section: 'opportunities',
      reason: 'Grants.gov client grant candidates are not included in this district context yet',
      source: 'grant-opportunity-candidates',
    });
    let priority: ClientPriorityIntelligenceResponse | null = null;
    let priorityEnabled = false;
    try {
      await this.priorityFlag.assertEnabledForTenant(tenantId);
      priorityEnabled = true;
    } catch (error) {
      if (!(error instanceof NotFoundException)) gaps.push({ section: 'cpf_cds', reason: 'Priority flag unavailable', source: 'priority-intelligence' });
    }
    if (priorityEnabled) priority = await this.collectPriority(tenantId, clientId, stateCode, district, sourceHealth, facts, gaps);
    if (priority) this.collectChanges(priority.priorityIntelligence.recentChanges, stateCode, district, sourceHealth, facts);

    let strategicEnabled = false;
    try {
      await this.strategicFlag.assertEnabledForTenant(tenantId);
      strategicEnabled = true;
    } catch (error) {
      if (!(error instanceof NotFoundException)) gaps.push({ section: 'economic', reason: 'Strategic flag unavailable', source: 'strategic-relevance' });
    }
    if (strategicEnabled) {
      try {
        const result = await this.strategic.getDistrictStrategic(tenantId, stateCode, district, clientId);
        if (result.strategic?.score != null) facts.push({
          id: factId('economic', 'strategic_relevance', `${stateCode}-${district}`), section: 'economic',
          label: 'Strategic relevance score', value: result.strategic.score, unit: 'score', amountStage: null,
          basis: 'verified_client_nexus',
          source: { type: 'strategic_relevance', label: 'Strategic relevance', recordId: null, url: null },
          asOf: { date: null, fiscalYear: null, sourceYear: null },
          geography: { state: stateCode, district, scope: 'district', basis: null, boundaryCongress: null },
          freshness: freshnessFor('strategic_relevance', sourceHealth), coverage: 'unknown', caveats: [],
        });
      } catch (error) {
        this.logger.error('Strategic rail failed', error);
        gaps.push({ section: 'economic', reason: 'Strategic relevance service failed', source: 'strategic-relevance' });
      }
    }

    let economicEnabled = false;
    try {
      await this.economicFlag.assertEnabledForTenant(tenantId, DISTRICT_NEXUS_EXTERNAL_CONTEXT_FEATURE);
      economicEnabled = true;
    } catch (error) {
      if (!(error instanceof NotFoundException)) gaps.push({ section: 'economic', reason: 'Economic flag unavailable', source: 'district-economic' });
    }
    if (economicEnabled) await this.collectEconomic(stateCode, district, sourceHealth, facts, gaps);
    await this.collectMarket(tenantId, clientId, stateCode, district, sourceHealth, facts, gaps);
    return { clientId, clientName: client.name, state: stateCode, district, facts, gaps, sourceHealth, generatedAt: new Date().toISOString() };
  }

  private async collectDetail(tenantId: string, clientId: string, state: string, district: string,
    health: SourceFreshness[], facts: R5Fact[], gaps: R5Gap[]): Promise<void> {
    try {
      const detail = await this.districtNexus.getDistrictDetail(tenantId, state, district, { clientId });
      if (!detail) {
        gaps.push({ section: 'footprint', reason: 'District not found', source: 'district-nexus' });
        return;
      }
      const caveats = warningCodes(detail.warnings, `${state}-${district}`);
      const stale = caveats.includes('stale_source');
      facts.push({
        id: factId('footprint', 'contract_obligations', `${state}-${district}`), section: 'footprint',
        label: 'District contract obligations (public awards)', value: detail.awarded.contractObligations,
        unit: 'USD', amountStage: 'obligated', basis: 'public_context',
        source: { type: 'federal_award', label: 'Federal contract awards', recordId: null, url: null },
        asOf: { date: null, fiscalYear: null, sourceYear: null },
        geography: { state, district, scope: 'district', basis: null, boundaryCongress: null },
        freshness: freshnessFor('sync-federal-award', health, stale), coverage: 'unknown', caveats,
      });
      for (const facility of detail.facilities) {
        // The district drawer lists all clients' facilities: do not claim another client's site.
        if (facility.clientId !== clientId) continue;
        facts.push({
          id: factId('footprint', 'facility', facility.id), section: 'footprint', label: facility.name,
          value: facility.employeeCount, unit: 'people', amountStage: null, basis: 'verified_client_nexus',
          source: { type: 'facility', label: 'Client facility', recordId: facility.id, url: null },
          asOf: { date: null, fiscalYear: null, sourceYear: null },
          geography: { state, district, scope: 'district', basis: 'facility', boundaryCongress: null },
          freshness: freshnessFor('client_facility', health), coverage: 'unknown', caveats: [],
        });
      }
      for (const e of detail.evidence) {
        const basis: R5Fact['basis'] = e.verificationStatus === 'source_verified' || e.verificationStatus === 'geocode_verified'
          ? 'verified_client_nexus' : 'public_context';
        facts.push({
          id: factId('footprint', e.sourceType, e.sourceRecordId ?? `${state}-${district}-${e.component}`),
          section: 'footprint', label: e.label, value: e.amount, unit: e.amount == null ? null : 'USD',
          amountStage: e.component === 'grant' ? 'awarded' : e.component === 'contract' ? 'obligated' : null,
          basis, source: { type: e.sourceType, label: e.label, recordId: e.sourceRecordId, url: null },
          asOf: { date: e.observedAt, fiscalYear: null, sourceYear: null },
          geography: { state, district, scope: e.geographyBasis === 'statewide' ? 'statewide' : 'district',
            basis: e.geographyBasis, boundaryCongress: e.boundaryCongress },
          freshness: freshnessFor(e.sourceType === 'federal_award' ? 'sync-federal-award' : e.sourceType, health, stale),
          coverage: 'unknown',
          caveats: [...caveats, ...(e.verificationStatus === 'inferred' ? ['inferred_entity_match'] : []),
            ...(e.geographyBasis === 'recipient_location' ? ['recipient_location_fallback'] : []),
            ...(e.boundaryVintage !== 'unknown' ? [`boundary_vintage:${e.boundaryVintage}`] : [])],
        });
      }
      const members = [
        ...(detail.representatives?.house ? [detail.representatives.house] : []),
        ...(detail.representatives?.senate ?? []),
      ];
      for (const rep of members) {
        const senate = rep.chamber.toLowerCase() === 'senate';
        facts.push({
          id: factId('representation', 'congress_member', rep.bioguideId), section: 'representation',
          label: `${rep.fullName} (${rep.party ?? '?'})${senate ? ' — Senate (statewide)' : ''}`,
          value: null, unit: null, amountStage: null, basis: 'public_context',
          source: { type: 'congress_member', label: senate ? 'US Senator' : 'US House member', recordId: rep.bioguideId, url: null },
          asOf: { date: null, fiscalYear: null, sourceYear: null },
          geography: { state, district: senate ? null : district, scope: senate ? 'statewide' : 'district',
            basis: null, boundaryCongress: null },
          freshness: freshnessFor('congress_member', health), coverage: 'unknown',
          caveats: senate ? ['statewide_attribution'] : [],
        });
      }
    } catch (error) {
      this.logger.error('District detail rail failed', error);
      gaps.push({ section: 'footprint', reason: 'District detail service failed', source: 'district-nexus' });
    }
  }

  private async collectPriority(tenantId: string, clientId: string, state: string, district: string,
    health: SourceFreshness[], facts: R5Fact[], gaps: R5Gap[]): Promise<ClientPriorityIntelligenceResponse | null> {
    try {
      const pi = await this.priorityIntelligence.getClientDistrictPriorityIntelligence(tenantId, clientId, state, district);
      const cpf = pi.priorityIntelligence.cpfCds;
      if (cpf.availability.status === 'unavailable') {
        gaps.push({ section: 'cpf_cds', reason: 'CPF/CDS corpus unavailable', source: 'cpf_cds' });
      }
      const stale = pi.freshness.find((entry) => entry.rail === 'cpf_cds');
      const seen = new Set<string>();
      for (const req of [...cpf.districtRequests, ...cpf.clientRequests]) {
        if (seen.has(req.requestId)) continue;
        seen.add(req.requestId);
        this.addRequest(req, state, district, health, Boolean(stale?.stale), facts);
      }
      return pi;
    } catch (error) {
      this.logger.error('Priority intelligence rail failed', error);
      gaps.push({ section: 'cpf_cds', reason: 'Priority intelligence service failed', source: 'priority-intelligence' });
      gaps.push({ section: 'changes', reason: 'Priority intelligence change reader failed', source: 'priority-intelligence' });
      return null;
    }
  }

  private addRequest(req: ProjectedCpfCdsSignal, state: string, district: string,
    health: SourceFreshness[], stale: boolean, facts: R5Fact[]): void {
    const statewide = req.geography.basis === 'senate_statewide';
    const source = { type: 'cpf_cds', label: req.chamber === 'senate' ? 'Senate CDS' : 'House CPF',
      recordId: req.requestId, url: null };
    const geography: R5Fact['geography'] = { state, district: statewide ? null : district,
      scope: statewide ? 'statewide' : 'district', basis: req.geography.basis, boundaryCongress: null };
    const shared = { section: 'cpf_cds' as const, unit: 'USD',
      basis: req.clientAttribution ? 'verified_client_nexus' as const : 'public_context' as const,
      source, asOf: { date: null, fiscalYear: req.fiscalYear, sourceYear: null }, geography,
      freshness: freshnessFor('cpf_cds', health, stale), coverage: 'unknown' as const,
      caveats: [...(statewide ? ['statewide_attribution'] : []),
        ...(stale ? ['stale_source'] : []), `source_stage:${req.amountStageRaw}`],
    };
    facts.push({ ...shared, id: factId('cpf_cds', 'requested', req.requestId),
      label: `${req.projectTitle} (${req.chamber} ${req.requestType}) — requested`,
      value: req.requestedAmountUsd, amountStage: 'requested' });
    if (req.finalAmountUsd != null) facts.push({ ...shared,
      id: factId('cpf_cds', 'enacted', req.requestId), label: `${req.projectTitle} (${req.chamber} ${req.requestType}) — final/enacted`,
      value: req.finalAmountUsd, amountStage: 'enacted' });
  }

  private async collectEconomic(state: string, district: string, health: SourceFreshness[],
    facts: R5Fact[], gaps: R5Gap[]): Promise<void> {
    try {
      const econ = await this.economic.getDistrictContext(state, district);
      for (const source of econ.sources) {
        if (source.status === 'unavailable' || source.status === 'failed') gaps.push({
          section: 'economic', reason: `${source.source} economic source ${source.status}`, source: source.source,
        });
      }
      for (const metric of econ.metrics) {
        const status = econ.sources.find((s) => s.source === metric.source && s.dataset === metric.dataset);
        const moeUnavailable = metric.marginOfError == null || metric.marginOfError <= 0;
        facts.push({
          id: factId('economic', metric.source, metric.sourceRecordId ?? `${metric.metricKey}-${metric.sourceYear}`),
          section: 'economic', label: metric.metricKey.replaceAll('_', ' '), value: metric.value, unit: metric.unit,
          amountStage: null, basis: 'public_context',
          source: { type: metric.source, label: metric.dataset, recordId: metric.sourceRecordId, url: metric.sourceUrl },
          asOf: { date: metric.observedAt, fiscalYear: null, sourceYear: metric.sourceYear },
          geography: { state, district, scope: 'district', basis: null, boundaryCongress: metric.boundaryCongress },
          freshness: freshnessFor(metric.source, health, status?.status === 'failed'),
          coverage: status?.status === 'success_with_errors' ? 'partial' : 'unknown',
          caveats: [...(moeUnavailable ? ['MOE unavailable'] : []), ...econ.warnings],
        });
      }
    } catch (error) {
      this.logger.error('Economic rail failed', error);
      gaps.push({ section: 'economic', reason: 'Economic footprint service failed', source: 'district-economic' });
    }
  }

  private collectChanges(rows: RecentChangeRecord[], state: string, district: string,
    health: SourceFreshness[], facts: R5Fact[]): void {
    for (const row of rows) facts.push({
      id: factId('changes', row.source, `${row.sourceRecordId}-${row.changeKind}-${row.observedAt}`),
      section: 'changes', label: `${row.changeKind} (${row.source})`,
      value: row.newValue == null ? null : JSON.stringify(row.newValue), unit: null, amountStage: null,
      basis: 'public_context',
      source: { type: row.source, label: row.source, recordId: row.sourceRecordId, url: null },
      asOf: { date: row.observedAt, fiscalYear: null, sourceYear: row.sourceYear },
      geography: { state, district, scope: 'district', basis: row.geographyVintage, boundaryCongress: row.boundaryCongress },
      freshness: freshnessFor(row.source, health), coverage: 'unknown', caveats: [],
    });
  }

  private async collectMarket(tenantId: string, clientId: string, state: string, district: string,
    health: SourceFreshness[], facts: R5Fact[], gaps: R5Gap[]): Promise<void> {
    try {
      const market = await this.market.geography(tenantId, { clientId, state, district });
      const key = `${state}-${district}`;
      if (market.futureSignalsAvailability === 'unavailable') gaps.push({
        section: 'opportunities', reason: 'Future signals unavailable', source: 'federal-market',
      });
      for (const signal of market.futureSignals.filter((s) => s.districtKey === key || (!s.districtKey && s.state === state)).slice(0, 5)) {
        const statewide = signal.districtKey !== key;
        facts.push({
          id: factId('opportunities', signal.source, signal.id), section: 'opportunities', label: signal.title,
          value: null, unit: null, amountStage: 'forecast', basis: 'public_context',
          source: { type: signal.source, label: signal.source === 'sam_gov' ? 'SAM opportunity' : 'Agency forecast',
            recordId: signal.id, url: signal.sourceUrl },
          asOf: { date: signal.date, fiscalYear: null, sourceYear: null },
          geography: { state, district: statewide ? null : district, scope: statewide ? 'statewide' : 'district',
            basis: signal.geographyBasis, boundaryCongress: null },
          freshness: freshnessFor(signal.source, health), coverage: 'unknown',
          caveats: statewide ? ['statewide_attribution', 'opportunity_only'] : ['opportunity_only'],
        });
      }
      // Supplier is separately gated in the drawer. The corpus checkpoint, not match count,
      // determines coverage. State-only subawards must never be added to a district figure.
      let supplierEnabled = false;
      try {
        await this.economicFlag.assertEnabledForTenant(tenantId, DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE);
        supplierEnabled = true;
      } catch (error) {
        if (!(error instanceof NotFoundException)) gaps.push({ section: 'footprint', reason: 'Supplier flag unavailable', source: 'tango_subaward' });
      }
      if (supplierEnabled) try {
        const supplier = await this.economic.getSupplierFootprintStatus(tenantId, clientId);
        const row = market.districts.find((d) => d.districtKey === key);
        if (row && supplier.status === 'available') facts.push({
          id: factId('footprint', 'tango_subaward', key), section: 'footprint',
          label: 'District-resolved subawards (supplier corpus)', value: row.subawardAmount,
          unit: 'USD', amountStage: 'awarded', basis: 'public_context',
          source: { type: 'tango_subaward', label: 'Tango subawards', recordId: null, url: null },
          asOf: { date: null, fiscalYear: null, sourceYear: null },
          geography: { state, district, scope: 'district', basis: 'source_place_of_performance', boundaryCongress: null },
          freshness: freshnessFor('tango_subaward', health),
          coverage: supplier.sourceCompleteness === 'complete' ? 'complete' : 'partial',
          caveats: supplier.sourceCompleteness === 'complete' ? [] : [supplier.sourceCoverageNote],
        });
      } catch (error) {
        gaps.push({ section: 'footprint', reason: 'Supplier corpus unavailable', source: 'tango_subaward' });
      }
    } catch (error) {
      this.logger.error('Federal market rail failed', error);
      gaps.push({ section: 'opportunities', reason: 'Federal market service failed', source: 'federal-market' });
    }
  }
}
