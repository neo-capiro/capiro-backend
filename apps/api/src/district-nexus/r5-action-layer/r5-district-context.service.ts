/**
 * R5 Action Layer — single source of district facts (contract §Fact shape).
 *
 * Composes the EXISTING services the drawer uses; never queries a source a
 * second way. Every R5 consumer (Brief, Meeting prep, Actions, Meri tools)
 * calls getContext() — this is THE source of district facts.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DistrictNexusService } from '../district-nexus.service.js';
import { DistrictNexusPriorityIntelligenceService } from '../priority-intelligence/priority-intelligence.service.js';
import { DistrictNexusStrategicService } from '../district-nexus-strategic.service.js';
import { DistrictNexusEconomicService } from '../district-nexus-economic.service.js';
import { stateFipsForAbbr } from '../../common/us-states.js';
import type {
  R5DistrictContext,
  R5Fact,
  R5Gap,
  R5FactSection,
  R5FactBasis,
} from './r5-types.js';

function factId(section: R5FactSection, sourceType: string, sourceRecordId: string | null): string {
  const id = sourceRecordId ?? `${section}:${sourceType}`;
  return `${section}:${sourceType}:${id}`;
}

function gsaDistrictKey(paddedDistrict: string): string {
  return String(Number(paddedDistrict));
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
  ) {}

  /**
   * Build the full R5DistrictContext for one client + district.
   *
   * Verifies client ∈ tenant first (404 if not). Each sub-source runs inside a
   * try/catch — a failed rail becomes an R5Gap, never throws the whole context
   * away. A real zero stays zero; missing data stays null.
   */
  async getContext(
    tenantId: string,
    clientId: string,
    state: string,
    district: string,
  ): Promise<R5DistrictContext> {
    // 1) Verify client ∈ tenant
    const client = await this.prisma.withTenant(tenantId, async (tx) => {
      return tx.client.findFirst({
        where: { id: clientId, tenantId },
        select: { id: true, name: true, status: true },
      });
    });
    if (!client || client.status === 'archived') {
      throw new NotFoundException('Client not found');
    }

    const stateCode = state.trim().toUpperCase();
    const facts: R5Fact[] = [];
    const gaps: R5Gap[] = [];

    // ── Rail 1: District detail
    await this.collectDistrictDetail(tenantId, clientId, stateCode, district, facts, gaps);

    // ── Rail 2: Priority Intelligence (CPF/CDS)
    await this.collectPriorityIntelligence(tenantId, clientId, stateCode, district, facts, gaps);

    // ── Rail 3: Strategic relevance
    await this.collectStrategic(tenantId, clientId, stateCode, district, facts, gaps);

    // ── Rail 4: Economic footprint (public context)
    await this.collectEconomic(stateCode, district, facts, gaps);

    // ── Rail 5: Change ledger
    await this.collectChanges(stateCode, district, facts, gaps);

    // Build sourceHealth from DistrictNexusService freshness
    let sourceHealth: R5DistrictContext['sourceHealth'] = [];
    try {
      const map = await this.districtNexus.getFirmDistrictNexusMap(tenantId, { state: stateCode });
      sourceHealth = map.freshness ?? [];
    } catch (err) {
      this.logger.error('Failed to load source freshness', err);
      gaps.push({ section: 'footprint', reason: 'Source freshness unavailable', source: null });
    }

    return {
      clientId,
      clientName: client.name,
      state: stateCode,
      district,
      facts,
      gaps,
      sourceHealth,
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Collectors ────────────────────────────────────────────────────────────

  private async collectDistrictDetail(
    tenantId: string,
    clientId: string,
    state: string,
    district: string,
    facts: R5Fact[],
    gaps: R5Gap[],
  ) {
    try {
      const detail = await this.districtNexus.getDistrictDetail(tenantId, state, district, {
        clientId,
      });

      if (!detail) {
        gaps.push({ section: 'footprint', reason: 'District not found', source: 'district-nexus' });
        return;
      }

      // Facilities → footprint facts
      for (const f of detail.facilities ?? []) {
        facts.push({
          id: factId('footprint', 'facility', f.id),
          section: 'footprint',
          label: f.name,
          value: f.employeeCount,
          unit: 'people',
          amountStage: null,
          basis: 'verified_client_nexus',
          source: { type: 'facility', label: 'Client facility', recordId: f.id, url: null },
          asOf: { date: null, fiscalYear: null, sourceYear: null },
          geography: { state, district, scope: 'district', basis: 'facility', boundaryCongress: null },
          freshness: { lastSyncedAt: null, stale: false, unavailable: false },
          coverage: 'complete',
          caveats: [],
        });
      }

      // Evidence rows → footprint / opportunities facts
      for (const e of detail.evidence ?? []) {
        const section: R5FactSection =
          e.component === 'grant' || e.component === 'opportunity' ? 'opportunities' : 'footprint';
        const basis: R5FactBasis =
          e.verificationStatus === 'source_verified' || e.verificationStatus === 'geocode_verified'
            ? 'verified_client_nexus'
            : 'public_context';

        facts.push({
          id: factId(section, e.component, e.sourceRecordId),
          section,
          label: e.label ?? `${e.component} evidence`,
          value: e.amount,
          unit: 'USD',
          amountStage:
            e.component === 'opportunity'
              ? 'forecast'
              : e.component === 'grant'
                ? 'awarded'
                : 'obligated',
          basis,
          source: {
            type: e.sourceType ?? e.component,
            label: e.label ?? e.component,
            recordId: e.sourceRecordId,
            url: null,
          },
          asOf: {
            date: e.observedAt ?? e.sourceUpdatedAt ?? null,
            fiscalYear: null,
            sourceYear: null,
          },
          geography: {
            state,
            district,
            scope: e.geographyBasis === 'statewide' ? 'statewide' : 'district',
            basis: e.geographyBasis ?? null,
            boundaryCongress: null,
          },
          freshness: { lastSyncedAt: e.sourceUpdatedAt ?? null, stale: false, unavailable: false },
          coverage: e.verificationStatus === 'inferred' ? 'partial' : 'complete',
          caveats: [],
        });
      }

      // Representatives → representation facts
      for (const rep of detail.representatives?.federal?.house ?? []) {
        facts.push({
          id: factId('representation', 'house_member', rep.bioguideId),
          section: 'representation',
          label: `${rep.fullName} (${rep.party ?? '?'})`,
          value: null,
          unit: null,
          amountStage: null,
          basis: 'public_context',
          source: {
            type: 'congress_member',
            label: 'US House member',
            recordId: rep.bioguideId,
            url: null,
          },
          asOf: { date: null, fiscalYear: null, sourceYear: null },
          geography: {
            state,
            district: rep.district != null ? String(rep.district) : null,
            scope: 'district',
            basis: null,
            boundaryCongress: null,
          },
          freshness: { lastSyncedAt: null, stale: false, unavailable: false },
          coverage: 'complete',
          caveats: [],
        });
      }
      for (const sen of detail.representatives?.federal?.senate ?? []) {
        facts.push({
          id: factId('representation', 'senator', sen.bioguideId),
          section: 'representation',
          label: `${sen.fullName} (${sen.party ?? '?'}) — Senate (statewide)`,
          value: null,
          unit: null,
          amountStage: null,
          basis: 'public_context',
          source: {
            type: 'congress_member',
            label: 'US Senator',
            recordId: sen.bioguideId,
            url: null,
          },
          asOf: { date: null, fiscalYear: null, sourceYear: null },
          geography: {
            state,
            district: null,
            scope: 'statewide',
            basis: null,
            boundaryCongress: null,
          },
          freshness: { lastSyncedAt: null, stale: false, unavailable: false },
          coverage: 'complete',
          caveats: ['statewide_attribution'],
        });
      }
    } catch (err) {
      this.logger.error('District detail rail failed', err);
      gaps.push({
        section: 'footprint',
        reason: 'District detail service failed',
        source: 'district-nexus',
      });
    }
  }

  private async collectPriorityIntelligence(
    tenantId: string,
    clientId: string,
    state: string,
    district: string,
    facts: R5Fact[],
    gaps: R5Gap[],
  ) {
    try {
      const pi = await this.priorityIntelligence.getClientDistrictPriorityIntelligence(
        tenantId,
        clientId,
        state,
        district,
      );

      // CPF/CDS district requests
      for (const req of pi.priorityIntelligence.cpfCds.districtRequests ?? []) {
        facts.push({
          id: factId('cpf_cds', 'cpf_request', req.sourceRecordId ?? null),
          section: 'cpf_cds',
          label: req.label ?? req.projectTitle ?? 'CPF/CDS request',
          value: req.requestedAmount ?? null,
          unit: 'USD',
          amountStage: 'requested',
          basis: 'public_context',
          source: {
            type: 'cpf_cds',
            label: 'CPF/CDS',
            recordId: req.sourceRecordId ?? null,
            url: req.sourceUrl ?? null,
          },
          asOf: { date: null, fiscalYear: req.fiscalYear ?? null, sourceYear: req.sourceYear ?? null },
          geography: { state, district, scope: 'district', basis: null, boundaryCongress: null },
          freshness: { lastSyncedAt: null, stale: false, unavailable: false },
          coverage: 'complete',
          caveats: [],
        });
      }

      // Client-attributed CPF/CDS requests
      for (const req of pi.priorityIntelligence.cpfCds.clientRequests ?? []) {
        facts.push({
          id: factId('cpf_cds', 'cpf_client_request', req.sourceRecordId ?? null),
          section: 'cpf_cds',
          label: req.label ?? req.projectTitle ?? 'Client CPF/CDS request',
          value: req.requestedAmount ?? null,
          unit: 'USD',
          amountStage: 'requested',
          basis: 'verified_client_nexus',
          source: {
            type: 'cpf_cds',
            label: 'CPF/CDS (client-attributed)',
            recordId: req.sourceRecordId ?? null,
            url: req.sourceUrl ?? null,
          },
          asOf: { date: null, fiscalYear: req.fiscalYear ?? null, sourceYear: req.sourceYear ?? null },
          geography: { state, district, scope: 'district', basis: null, boundaryCongress: null },
          freshness: { lastSyncedAt: null, stale: false, unavailable: false },
          coverage: 'complete',
          caveats: [],
        });
      }

      // Separate enacted amounts
      for (const req of pi.priorityIntelligence.cpfCds.districtRequests ?? []) {
        if (req.enactedAmount != null) {
          facts.push({
            id: factId('cpf_cds', 'cpf_enacted', req.sourceRecordId ?? null),
            section: 'cpf_cds',
            label: `(Enacted) ${req.label ?? req.projectTitle ?? 'CPF/CDS'}`,
            value: req.enactedAmount,
            unit: 'USD',
            amountStage: 'enacted',
            basis: 'public_context',
            source: {
              type: 'cpf_cds',
              label: 'CPF/CDS enacted',
              recordId: req.sourceRecordId ?? null,
              url: req.sourceUrl ?? null,
            },
            asOf: { date: null, fiscalYear: req.fiscalYear ?? null, sourceYear: req.sourceYear ?? null },
            geography: { state, district, scope: 'district', basis: null, boundaryCongress: null },
            freshness: { lastSyncedAt: null, stale: false, unavailable: false },
            coverage: 'complete',
            caveats: [],
          });
        }
      }
    } catch (err) {
      this.logger.error('Priority intelligence rail failed', err);
      gaps.push({
        section: 'cpf_cds',
        reason: 'Priority intelligence service failed',
        source: 'priority-intelligence',
      });
    }
  }

  private async collectStrategic(
    tenantId: string,
    clientId: string,
    state: string,
    district: string,
    facts: R5Fact[],
    gaps: R5Gap[],
  ) {
    try {
      const strat = await this.strategic.getDistrictStrategic(tenantId, state, district, clientId);

      if (strat.strategic?.score != null) {
        facts.push({
          id: factId('economic', 'strategic_relevance', `strategic-${district}`),
          section: 'economic',
          label: 'Strategic relevance score',
          value: strat.strategic.score,
          unit: 'score',
          amountStage: null,
          basis: 'verified_client_nexus',
          source: {
            type: 'strategic_relevance',
            label: 'Strategic relevance',
            recordId: `strategic-${district}`,
            url: null,
          },
          asOf: { date: null, fiscalYear: null, sourceYear: null },
          geography: { state, district, scope: 'district', basis: null, boundaryCongress: null },
          freshness: { lastSyncedAt: null, stale: false, unavailable: false },
          coverage: 'complete',
          caveats: [],
        });
      }
    } catch (err) {
      this.logger.error('Strategic relevance rail failed', err);
      gaps.push({
        section: 'economic',
        reason: 'Strategic relevance service failed',
        source: 'strategic-relevance',
      });
    }
  }

  private async collectEconomic(
    state: string,
    district: string,
    facts: R5Fact[],
    gaps: R5Gap[],
  ) {
    try {
      const econ = await this.economic.getDistrictContext(state, district);

      for (const m of econ.metrics ?? []) {
        facts.push({
          id: factId('economic', m.source, m.sourceRecordId ?? `${m.source}:${m.metricKey}`),
          section: 'economic',
          label: m.metricKey ?? m.dataset ?? 'Economic metric',
          value: m.value,
          unit: m.unit,
          amountStage: null,
          basis: 'public_context',
          source: {
            type: m.source,
            label: m.dataset ?? m.source,
            recordId: m.sourceRecordId ?? null,
            url: m.sourceUrl ?? null,
          },
          asOf: {
            date: m.lastSyncedAt ?? null,
            fiscalYear: null,
            sourceYear: m.sourceYear,
          },
          geography: {
            state,
            district,
            scope: 'district',
            basis: null,
            boundaryCongress: m.boundaryCongress,
          },
          freshness: { lastSyncedAt: m.lastSyncedAt ?? null, stale: false, unavailable: false },
          coverage: 'complete',
          caveats: [],
        });
      }
    } catch (err) {
      this.logger.error('Economic rail failed', err);
      gaps.push({
        section: 'economic',
        reason: 'Economic footprint service failed',
        source: 'district-economic',
      });
    }
  }

  private async collectChanges(
    state: string,
    district: string,
    facts: R5Fact[],
    gaps: R5Gap[],
  ) {
    try {
      const stateFips = stateFipsForAbbr(state);
      const rows = await this.prisma.districtNexusChange.findMany({
        where: {
          observationKind: 'change',
          OR: [
            { source: 'gsa', stateCode: stateFips, districtCode: gsaDistrictKey(district) },
            { source: { not: 'gsa' }, stateCode: state, districtCode: district },
          ],
        },
        orderBy: { observedAt: 'desc' },
        take: 30,
      });

      for (const c of rows) {
        facts.push({
          id: factId('changes', c.source, c.sourceRecordId),
          section: 'changes',
          label: `${c.changeKind} (${c.source})`,
          value: c.newValue != null ? JSON.stringify(c.newValue) : null,
          unit: null,
          amountStage: null,
          basis: 'public_context',
          source: {
            type: c.source,
            label: c.source,
            recordId: c.sourceRecordId,
            url: null,
          },
          asOf: {
            date: c.observedAt.toISOString(),
            fiscalYear: null,
            sourceYear: c.sourceYear,
          },
          geography: {
            state,
            district,
            scope: 'district',
            basis: null,
            boundaryCongress: c.boundaryCongress,
          },
          freshness: { lastSyncedAt: null, stale: false, unavailable: false },
          coverage: 'complete',
          caveats: [],
        });
      }
    } catch (err) {
      this.logger.error('Change ledger rail failed', err);
      gaps.push({
        section: 'changes',
        reason: 'Change ledger query failed',
        source: 'district_nexus_change',
      });
    }
  }
}