import { createHash } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { IntelligenceService } from '../intelligence/intelligence.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  asRecord,
  asString,
  stableJson,
} from './client-profile-fill.helpers.js';
import { ClientFacilitiesService } from './client-facilities.service.js';
import {
  calculateProfileCompletion,
  scoreAdvocacyOutcome,
  type ClientProfileFillCompletionTaskType,
} from './client-profile-fill-completion.helpers.js';

const MAX_ADVOCACY_FINDINGS = 200;
const ADVOCACY_TITLE_TERMS = [
  'appropriation',
  'amendment',
  'authorization',
  'bill',
  'budget',
  'congress',
  'funding',
  'hearing',
  'legislation',
  'policy',
  'regulation',
  'request',
  'submission',
  'testimony',
];

interface AddFindingInput {
  kind: string;
  targetKey: string;
  source: string;
  factKind: 'fact' | 'recommendation';
  currentValue: unknown;
  proposedValue: unknown;
  confidence: number;
  evidence: unknown[];
  status: 'pending' | 'informational';
}

interface LdaFilingRow {
  filingUuid: string;
  clientId: number;
  clientName: string;
  filingType: string;
  filingYear: number;
  filingPeriod: string | null;
  dtPosted: Date | null;
  registrantName: string;
  clientDescription: string | null;
  income: unknown;
  expenses: unknown;
  issueCodes: string[];
  governmentEntities: unknown;
  lobbyingActivities: unknown;
  filingDocumentUrl: string | null;
}

@Injectable()
export class ClientProfileFillCompletionSpecialistsService {
  private readonly logger = new Logger(ClientProfileFillCompletionSpecialistsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intelligence: IntelligenceService,
    private readonly facilities: ClientFacilitiesService,
  ) {}

  execute(
    ctx: TenantContext,
    taskType: ClientProfileFillCompletionTaskType,
    clientId: string,
    runId: string,
  ): Promise<number> {
    switch (taskType) {
      case 'federal_market':
        return this.gatherFederalMarket(ctx, clientId, runId);
      case 'facility_resolution':
        return this.gatherFacilityResolution(ctx, clientId, runId);
      case 'district_nexus':
        return this.gatherDistrictNexus(ctx, clientId, runId);
      case 'advocacy_history':
        return this.gatherAdvocacyHistory(ctx, clientId, runId);
      case 'lifecycle_outcomes':
        return this.gatherLifecycleOutcomes(ctx, clientId, runId);
      case 'reconciliation':
        return this.reconcileFindings(ctx, clientId, runId);
      case 'completion_audit':
        return this.runCompletionAudit(ctx, clientId, runId);
    }
  }

  private async gatherFederalMarket(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const profile = asRecord(await this.intelligence.getClientProfile(clientId, ctx.tenantId));
    const contracting = asRecord(profile.contracting);
    await this.recordCursor(ctx.tenantId, clientId, 'federal_market', {
      refreshedAt: new Date().toISOString(),
      matched: contracting.matched === true,
    });
    if (contracting.matched !== true) return 0;

    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { intakeData: true },
      }),
    );
    const proposedValue = {
      contractorName: contracting.contractorName ?? null,
      totalContracts: contracting.totalContracts ?? null,
      rankByContracts: contracting.rankByContracts ?? null,
      noBidTotal: contracting.noBidTotal ?? null,
      topAgencies: Array.isArray(contracting.topAgencies) ? contracting.topAgencies : [],
      yearlySpend: Array.isArray(contracting.yearlySpend) ? contracting.yearlySpend : [],
      refreshedAt: new Date().toISOString(),
    };
    const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
      kind: 'federal_footprint',
      targetKey: 'federalMarket',
      source: 'federal_market',
      factKind: 'fact',
      currentValue: asRecord(client?.intakeData).federalMarket ?? null,
      proposedValue,
      confidence: 0.95,
      status: 'pending',
      evidence: [
        {
          label: 'Resolved federal contracting footprint',
          source: 'Capiro Federal Market / USAspending corpus',
          metadata: {
            contractorName: proposedValue.contractorName,
            totalContracts: proposedValue.totalContracts,
          },
        },
      ],
    });
    return inserted ? 1 : 0;
  }

  private async gatherFacilityResolution(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const [facilities, proposedFacilities] = await this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        const persisted = await tx.clientFacility.findMany({
          where: { tenantId: ctx.tenantId, clientId },
          select: {
            id: true,
            name: true,
            addressLine: true,
            city: true,
            state: true,
            zip: true,
            geocodeStatus: true,
            updatedAt: true,
          },
          orderBy: { createdAt: 'asc' },
          take: 100,
        });
        const proposed = await tx.$queryRawUnsafe<Array<{ proposedValue: unknown }>>(
          `SELECT proposed_value_jsonb AS "proposedValue"
             FROM client_profile_fill_finding
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
              AND kind = 'facility' AND status = 'pending'`,
          ctx.tenantId,
          clientId,
          runId,
        );
        return [persisted, proposed] as const;
      },
    );

    let count = 0;
    for (const facility of facilities) {
      const missing = missingAddressParts(facility);
      if (!missing.length) continue;
      const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
        kind: 'facility_resolution',
        targetKey: `facility-resolution:${facility.id}`,
        source: 'facility_resolution',
        factKind: 'fact',
        currentValue: facility,
        proposedValue: {
          facilityId: facility.id,
          facilityName: facility.name,
          status: 'insufficient_address',
          missing,
        },
        confidence: 1,
        status: 'informational',
        evidence: [
          {
            label: `Cannot resolve ${facility.name} until ${missing.join(', ')} is supplied`,
            source: 'Client facility record',
          },
        ],
      });
      if (inserted) count += 1;
    }

    for (const row of proposedFacilities) {
      const proposal = asRecord(row.proposedValue);
      const missing = missingAddressParts(proposal);
      if (!missing.length) continue;
      const key = createHash('sha256').update(stableJson(proposal)).digest('hex').slice(0, 20);
      const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
        kind: 'facility_resolution',
        targetKey: `proposed-facility-resolution:${key}`,
        source: 'facility_resolution',
        factKind: 'fact',
        currentValue: null,
        proposedValue: {
          facilityName: asString(proposal.name) ?? 'Proposed facility',
          status: 'insufficient_address',
          missing,
        },
        confidence: 1,
        status: 'informational',
        evidence: [
          {
            label: `The proposed facility needs ${missing.join(', ')} before District Nexus can resolve it`,
            source: 'Fill with Meri public-web finding',
          },
        ],
      });
      if (inserted) count += 1;
    }

    const latest = facilities
      .map((facility) => facility.updatedAt)
      .sort((left, right) => right.getTime() - left.getTime())[0];
    await this.recordCursor(ctx.tenantId, clientId, 'facility_resolution', {
      latestFacilityUpdatedAt: latest?.toISOString() ?? null,
      facilityCount: facilities.length,
    });
    return count;
  }

  private async gatherDistrictNexus(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const facilities = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clientFacility.findMany({
        where: {
          tenantId: ctx.tenantId,
          clientId,
          addressLine: { not: null },
          city: { not: null },
          state: { not: null },
        },
        select: {
          id: true,
          name: true,
          addressLine: true,
          city: true,
          state: true,
          zip: true,
          congressionalDistrict: true,
          stateHouseDistrict: true,
          stateSenateDistrict: true,
          geocodeStatus: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 25,
      }),
    );

    let count = 0;
    for (const facility of facilities) {
      try {
        const resolved = await this.facilities.resolveFacilityDistrict(ctx, clientId, facility.id);
        const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
          kind: 'district_nexus',
          targetKey: `district-nexus:${facility.id}`,
          source: 'district_nexus',
          factKind: 'fact',
          currentValue: {
            congressionalDistrict: facility.congressionalDistrict,
            stateHouseDistrict: facility.stateHouseDistrict,
            stateSenateDistrict: facility.stateSenateDistrict,
            geocodeStatus: facility.geocodeStatus,
          },
          proposedValue: {
            facilityId: facility.id,
            facilityName: facility.name,
            congressionalDistrict: resolved.congressionalDistrict,
            stateHouseDistrict: resolved.stateHouseDistrict,
            stateSenateDistrict: resolved.stateSenateDistrict,
            geocodeStatus: resolved.geocodeStatus,
            matchedAddress: resolved.geocodeMatchedAddress,
            districtSource: resolved.districtSource,
          },
          confidence: resolved.geocodeStatus === 'matched' ? 1 : 0.8,
          status: 'informational',
          evidence: [
            {
              label: `Resolved ${facility.name} through the Census-authoritative district pipeline`,
              source: 'U.S. Census Geocoder / TIGER geography',
              metadata: { geocodeStatus: resolved.geocodeStatus },
            },
          ],
        });
        if (inserted) count += 1;
      } catch (error) {
        const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
          kind: 'facility_resolution',
          targetKey: `district-resolution-failed:${facility.id}`,
          source: 'district_nexus',
          factKind: 'fact',
          currentValue: facility,
          proposedValue: {
            facilityId: facility.id,
            facilityName: facility.name,
            status: 'no_match',
          },
          confidence: 1,
          status: 'informational',
          evidence: [
            {
              label: `District resolution did not produce an authoritative match for ${facility.name}`,
              source: 'Capiro facility geocoder',
              metadata: { error: safeError(error) },
            },
          ],
        });
        if (inserted) count += 1;
      }
    }

    await this.recordCursor(ctx.tenantId, clientId, 'district_nexus', {
      resolvedAt: new Date().toISOString(),
      attemptedFacilities: facilities.length,
    });
    return count;
  }

  private async gatherAdvocacyHistory(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const runRows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ selectedLdaIds: number[] }>>(
        `SELECT selected_lda_ids AS "selectedLdaIds"
           FROM client_profile_fill_run
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid`,
        runId,
        ctx.tenantId,
        clientId,
      ),
    );
    const ldaIds = runRows[0]?.selectedLdaIds ?? [];
    const cursor = await this.getCursor(ctx.tenantId, clientId, 'advocacy_history');
    const lastDtPosted = asString(cursor.lastLdaPostedAt);
    const filings = ldaIds.length
      ? await this.prisma.$queryRawUnsafe<LdaFilingRow[]>(
          `SELECT filing_uuid AS "filingUuid",
                  client_id AS "clientId",
                  client_name AS "clientName",
                  filing_type AS "filingType",
                  filing_year AS "filingYear",
                  filing_period AS "filingPeriod",
                  dt_posted AS "dtPosted",
                  registrant_name AS "registrantName",
                  client_description AS "clientDescription",
                  income,
                  expenses,
                  issue_codes AS "issueCodes",
                  government_entities AS "governmentEntities",
                  lobbying_activities AS "lobbyingActivities",
                  filing_document_url AS "filingDocumentUrl"
             FROM lda_filing
            WHERE client_id = ANY($1::int[])
              AND ($2::timestamptz IS NULL OR dt_posted > $2::timestamptz)
            ORDER BY dt_posted DESC NULLS LAST, filing_year DESC
            LIMIT 250`,
          ldaIds,
          lastDtPosted,
        )
      : [];

    let count = 0;
    let newestPostedAt = lastDtPosted ? new Date(lastDtPosted) : null;
    for (const filing of filings) {
      if (filing.dtPosted && (!newestPostedAt || filing.dtPosted > newestPostedAt)) {
        newestPostedAt = filing.dtPosted;
      }
      const activities = recordsFromUnknown(filing.lobbyingActivities);
      const records = activities.length ? activities : [{}];
      for (let index = 0; index < records.length && count < MAX_ADVOCACY_FINDINGS; index += 1) {
        const activity = records[index]!;
        const issueCode =
          asString(activity.general_issue_code) ??
          asString(activity.issue_code) ??
          filing.issueCodes?.[0] ??
          null;
        const externalKey = `lda:${filing.filingUuid}:${index}`;
        const proposedValue = {
          externalKey,
          recordType: 'federal_lobbying',
          title: `${filing.filingYear}${filing.filingPeriod ? ` ${filing.filingPeriod}` : ''}${
            issueCode ? ` — ${issueCode}` : ''
          }`,
          summary: summarizeLdaActivity(activity, filing.clientDescription),
          activityDate: filing.dtPosted?.toISOString() ?? null,
          status: filing.filingType,
          outcome: null,
          sourceType: 'lda',
          sourceId: filing.filingUuid,
          sourceUrl: filing.filingDocumentUrl,
          evidenceClass: 'PUBLIC_VERIFIED',
          confidence: 1,
          metadata: {
            ldaClientId: filing.clientId,
            ldaClientName: filing.clientName,
            registrantName: filing.registrantName,
            filingYear: filing.filingYear,
            filingPeriod: filing.filingPeriod,
            income: filing.income == null ? null : Number(filing.income),
            expenses: filing.expenses == null ? null : Number(filing.expenses),
            issueCodes: filing.issueCodes ?? [],
            governmentEntities: filing.governmentEntities,
            activity,
          },
        };
        const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
          kind: 'advocacy_record',
          targetKey: `advocacy:${externalKey}`,
          source: 'advocacy_history',
          factKind: 'fact',
          currentValue: null,
          proposedValue,
          confidence: 1,
          status: 'pending',
          evidence: [
            {
              label: proposedValue.title,
              url: filing.filingDocumentUrl,
              source: 'Senate Lobbying Disclosure Act filing',
              metadata: { filingUuid: filing.filingUuid, activityIndex: index },
            },
          ],
        });
        if (inserted) count += 1;
      }
    }

    count += await this.gatherClientSubmissionAdvocacy(ctx, clientId, runId, count);
    count += await this.gatherPrivateAdvocacyCandidates(ctx, clientId, runId, count);
    await this.recordCursor(ctx.tenantId, clientId, 'advocacy_history', {
      lastLdaPostedAt: newestPostedAt?.toISOString() ?? lastDtPosted ?? null,
      refreshedAt: new Date().toISOString(),
    });
    return count;
  }

  private async gatherClientSubmissionAdvocacy(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
  ): Promise<number> {
    if (currentCount >= MAX_ADVOCACY_FINDINGS) return 0;
    let rows: Array<{ data: unknown; capabilityName: string | null }> = [];
    try {
      rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$queryRawUnsafe<Array<{ data: unknown; capabilityName: string | null }>>(
          `SELECT to_jsonb(submission) AS data,
                  capability.name AS "capabilityName"
             FROM client_submission_history submission
             JOIN client_capabilities capability ON capability.id = submission.capability_id
            WHERE capability.tenant_id = $1::uuid AND capability.client_id = $2::uuid
            ORDER BY submission.created_at DESC
            LIMIT 100`,
          ctx.tenantId,
          clientId,
        ),
      );
    } catch (error) {
      this.logger.warn(`Client submission advocacy rail unavailable: ${safeError(error)}`);
      return 0;
    }

    let count = 0;
    for (const row of rows) {
      if (currentCount + count >= MAX_ADVOCACY_FINDINGS) break;
      const data = asRecord(row.data);
      const id = asString(data.id);
      if (!id) continue;
      const proposedValue = {
        externalKey: `client-submission:${id}`,
        recordType: 'client_submission',
        title: asString(data.title) ?? `${row.capabilityName ?? 'Client'} submission`,
        summary: asString(data.detail) ?? asString(data.description) ?? null,
        activityDate:
          asString(data.submitted_at) ?? asString(data.created_at) ?? asString(data.updated_at) ?? null,
        status: asString(data.status),
        outcome: asString(data.outcome),
        sourceType: 'client_submission',
        sourceId: id,
        sourceUrl: null,
        evidenceClass: 'CLIENT_VERIFIED',
        confidence: 1,
        metadata: { ...data, capabilityName: row.capabilityName },
      };
      const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
        kind: 'advocacy_record',
        targetKey: `advocacy:client-submission:${id}`,
        source: 'advocacy_history',
        factKind: 'fact',
        currentValue: null,
        proposedValue,
        confidence: 1,
        status: 'pending',
        evidence: [
          {
            label: 'Existing client submission history',
            source: 'Capiro client record',
            metadata: { submissionId: id, capabilityName: row.capabilityName },
          },
        ],
      });
      if (inserted) count += 1;
    }
    return count;
  }

  private async gatherPrivateAdvocacyCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
  ): Promise<number> {
    if (currentCount >= MAX_ADVOCACY_FINDINGS) return 0;
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string; proposedValue: unknown; evidence: unknown }>>(
        `SELECT id,
                proposed_value_jsonb AS "proposedValue",
                evidence_jsonb AS evidence
           FROM client_profile_fill_finding
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid
            AND kind = 'relationship_link' AND status = 'accepted'
          ORDER BY applied_at DESC NULLS LAST
          LIMIT 250`,
        ctx.tenantId,
        clientId,
      ),
    );

    let count = 0;
    for (const row of rows) {
      if (currentCount + count >= MAX_ADVOCACY_FINDINGS) break;
      const proposal = asRecord(row.proposedValue);
      const title = asString(proposal.title) ?? '';
      if (!containsAdvocacyTerm(title)) continue;
      const entityType = asString(proposal.entityType);
      const entityId = asString(proposal.entityId);
      if (!entityType || !entityId) continue;
      const externalKey = `relationship:${entityType}:${entityId}`;
      const proposedValue = {
        externalKey,
        recordType: entityType === 'meeting' ? 'advocacy_meeting' : 'advocacy_correspondence',
        title,
        summary:
          'The interaction subject appears advocacy-related. The source record remains authoritative; review before classifying it as advocacy.',
        activityDate: asString(proposal.occurredAt),
        status: 'activity_observed',
        outcome: null,
        sourceType: entityType,
        sourceId: entityId,
        sourceUrl: null,
        evidenceClass: 'PRIVATE_ACTIVITY',
        confidence: 0.72,
        metadata: {
          relationshipFindingId: row.id,
          matchReason: proposal.matchReason,
          matchedDomains: proposal.matchedDomains,
        },
      };
      const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
        kind: 'advocacy_record',
        targetKey: `advocacy:${externalKey}`,
        source: 'advocacy_history',
        factKind: 'recommendation',
        currentValue: null,
        proposedValue,
        confidence: 0.72,
        status: 'pending',
        evidence: Array.isArray(row.evidence) ? row.evidence : [],
      });
      if (inserted) count += 1;
    }
    return count;
  }

  private async gatherLifecycleOutcomes(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const [findingRows, persistedRecords, outcomes] = await this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        const findings = await tx.$queryRawUnsafe<Array<{ proposedValue: unknown }>>(
          `SELECT proposed_value_jsonb AS "proposedValue"
             FROM client_profile_fill_finding
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
              AND kind = 'advocacy_record' AND status IN ('pending', 'accepted')`,
          ctx.tenantId,
          clientId,
          runId,
        );
        const records = await tx.$queryRawUnsafe<Array<{ data: unknown }>>(
          `SELECT to_jsonb(record) AS data
             FROM client_advocacy_record record
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid
            ORDER BY activity_date DESC NULLS LAST
            LIMIT 250`,
          ctx.tenantId,
          clientId,
        );
        const events = await tx.outcomeEvent.findMany({
          where: { tenantId: ctx.tenantId, clientId },
          select: {
            id: true,
            kind: true,
            sourceType: true,
            sourceId: true,
            evidence: true,
            notes: true,
            observedAt: true,
          },
          orderBy: { observedAt: 'desc' },
          take: 250,
        });
        return [findings, records, events] as const;
      },
    );

    const advocacy = [
      ...findingRows.map((row) => asRecord(row.proposedValue)),
      ...persistedRecords.map((row) => normalizePersistedAdvocacy(asRecord(row.data))),
    ];
    let count = 0;
    const seen = new Set<string>();
    for (const record of advocacy) {
      const externalKey = asString(record.externalKey);
      if (!externalKey || seen.has(externalKey)) continue;
      seen.add(externalKey);
      const activityDate = parseDate(record.activityDate);
      for (const outcome of outcomes) {
        if (activityDate && outcome.observedAt < activityDate) continue;
        const score = scoreAdvocacyOutcome(record, {
          kind: outcome.kind,
          sourceType: outcome.sourceType,
          sourceId: outcome.sourceId,
          notes: outcome.notes,
          evidence: outcome.evidence,
        });
        if (score < 0.34) continue;
        const proposedValue = {
          advocacyExternalKey: externalKey,
          outcomeEventId: outcome.id,
          outcomeKind: outcome.kind,
          observedAt: outcome.observedAt.toISOString(),
          notes: outcome.notes,
          evidence: outcome.evidence,
          relationship: 'temporally_and_semantically_related',
          causationClaimed: false,
          score,
        };
        const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
          kind: 'advocacy_outcome',
          targetKey: `advocacy-outcome:${externalKey}:${outcome.id}`,
          source: 'lifecycle_outcomes',
          factKind: 'recommendation',
          currentValue: null,
          proposedValue,
          confidence: score,
          status: 'pending',
          evidence: [
            {
              label: `Observed outcome “${outcome.kind}” followed a related advocacy record`,
              source: 'Capiro Outcome Event',
              metadata: {
                outcomeEventId: outcome.id,
                observedAt: outcome.observedAt.toISOString(),
                causationClaimed: false,
              },
            },
          ],
        });
        if (inserted) count += 1;
        if (count >= 75) break;
      }
      if (count >= 75) break;
    }

    await this.recordCursor(ctx.tenantId, clientId, 'lifecycle_outcomes', {
      refreshedAt: new Date().toISOString(),
      latestOutcomeAt: outcomes[0]?.observedAt.toISOString() ?? null,
    });
    return count;
  }

  private async reconcileFindings(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<
        Array<{
          id: string;
          kind: string;
          targetKey: string;
          source: string;
          proposedValue: unknown;
          evidence: unknown;
          confidence: number | string;
        }>
      >(
        `SELECT id,
                kind,
                target_key AS "targetKey",
                source,
                proposed_value_jsonb AS "proposedValue",
                evidence_jsonb AS evidence,
                confidence
           FROM client_profile_fill_finding
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
            AND status = 'pending'
          ORDER BY confidence DESC, created_at ASC`,
        ctx.tenantId,
        clientId,
        runId,
      ),
    );

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.kind}:${row.targetKey}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    let changed = 0;
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const distinct = new Set(group.map((row) => stableJson(row.proposedValue)));
      if (distinct.size === 1) {
        for (const duplicate of group.slice(1)) {
          const updated = await this.prisma.withTenant(ctx.tenantId, (tx) =>
            tx.$executeRawUnsafe(
              `UPDATE client_profile_fill_finding
                  SET status = 'informational', updated_at = now()
                WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'pending'`,
              duplicate.id,
              ctx.tenantId,
            ),
          );
          changed += Number(updated);
        }
        continue;
      }
      const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
        kind: 'profile_completion',
        targetKey: `conflict:${createHash('sha256').update(key).digest('hex').slice(0, 20)}`,
        source: 'reconciliation',
        factKind: 'recommendation',
        currentValue: null,
        proposedValue: {
          type: 'conflict',
          target: key,
          findingIds: group.map((row) => row.id),
          message: 'Multiple sources proposed different values. Review them individually; none was auto-selected.',
        },
        confidence: 1,
        status: 'informational',
        evidence: group.map((row) => ({
          label: `${row.source} proposed a value for ${row.targetKey}`,
          source: row.source,
          metadata: { findingId: row.id, confidence: Number(row.confidence) },
        })),
      });
      if (inserted) changed += 1;
    }
    return changed;
  }

  private async runCompletionAudit(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const snapshot = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: {
          website: true,
          description: true,
          uei: true,
          cageCode: true,
          ldaClientIds: true,
          intakeData: true,
          _count: {
            select: {
              capabilities: true,
              people: true,
              facilities: true,
              meetings: true,
              mailThreads: true,
            },
          },
        },
      });
      if (!client) throw new NotFoundException('Client not found');
      const [resolvedFacilities, advocacyRecords, findingCounts] = await Promise.all([
        tx.clientFacility.count({
          where: {
            tenantId: ctx.tenantId,
            clientId,
            congressionalDistrict: { not: null },
          },
        }),
        tx.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT COUNT(*)::int AS count
             FROM client_advocacy_record
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid`,
          ctx.tenantId,
          clientId,
        ),
        tx.$queryRawUnsafe<Array<{ kind: string; count: number }>>(
          `SELECT kind, COUNT(*)::int AS count
             FROM client_profile_fill_finding
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
            GROUP BY kind`,
          ctx.tenantId,
          clientId,
          runId,
        ),
      ]);
      return { client, resolvedFacilities, advocacyRecords, findingCounts };
    });

    const counts = Object.fromEntries(
      snapshot.findingCounts.map((row) => [row.kind, Number(row.count)]),
    );
    const completion = calculateProfileCompletion({
      federalIdentity: snapshot.client.ldaClientIds.length > 0,
      website: Boolean(snapshot.client.website?.trim()),
      overview: Boolean(snapshot.client.description?.trim()),
      governmentIdentity: Boolean(snapshot.client.uei || snapshot.client.cageCode),
      capabilities: snapshot.client._count.capabilities > 0 || Number(counts.capability ?? 0) > 0,
      relationships:
        snapshot.client._count.people > 0 &&
        snapshot.client._count.meetings + snapshot.client._count.mailThreads > 0,
      facilities: snapshot.client._count.facilities > 0 || Number(counts.facility ?? 0) > 0,
      districtNexus: snapshot.resolvedFacilities > 0,
      federalMarket:
        Boolean(asRecord(snapshot.client.intakeData).federalMarket) ||
        Number(counts.federal_footprint ?? 0) > 0,
      lobbyingHistory: Number(counts.lda_history ?? 0) > 0,
      advocacyHistory:
        Number(snapshot.advocacyRecords[0]?.count ?? 0) > 0 ||
        Number(counts.advocacy_record ?? 0) > 0,
      programElements: Number(counts.program_element ?? 0) > 0,
      bills: Number(counts.bill_recommendation ?? 0) > 0,
    });
    const failedTasks = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ taskType: string; errorMessage: string | null }>>(
        `SELECT task_type AS "taskType", error_message AS "errorMessage"
           FROM client_profile_fill_extension_task
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
            AND status = 'failed'`,
        ctx.tenantId,
        clientId,
        runId,
      ),
    );
    const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
      kind: 'profile_completion',
      targetKey: 'profile-completion',
      source: 'completion_audit',
      factKind: 'fact',
      currentValue: null,
      proposedValue: {
        ...completion,
        warnings: failedTasks.map((task) => ({
          task: task.taskType,
          message: task.errorMessage ?? 'Source unavailable',
        })),
        calculatedAt: new Date().toISOString(),
      },
      confidence: 1,
      status: 'informational',
      evidence: [
        {
          label: `${completion.score}% of the defined client profile domains are complete`,
          source: 'Capiro deterministic completion audit',
          metadata: { completed: completion.completed, missing: completion.missing },
        },
      ],
    });
    return inserted ? 1 : 0;
  }

  private async addFinding(
    tenantId: string,
    clientId: string,
    runId: string,
    input: AddFindingInput,
  ): Promise<boolean> {
    const contentHash = createHash('sha256')
      .update(
        stableJson({
          kind: input.kind,
          targetKey: input.targetKey,
          source: input.source,
          proposedValue: input.proposedValue,
        }),
      )
      .digest('hex');
    return this.prisma.withTenant(tenantId, async (tx) => {
      const terminal = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id
           FROM client_profile_fill_finding
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND content_hash = $3
            AND status IN ('accepted', 'rejected')
          LIMIT 1`,
        tenantId,
        clientId,
        contentHash,
      );
      if (terminal.length) return false;
      await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_finding
            SET status = 'informational', updated_at = now()
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND content_hash = $3
            AND run_id <> $4::uuid AND status = 'pending'`,
        tenantId,
        clientId,
        contentHash,
        runId,
      );
      const inserted = await tx.$executeRawUnsafe(
        `INSERT INTO client_profile_fill_finding
           (run_id, tenant_id, client_id, kind, target_key, source, fact_kind,
            current_value_jsonb, proposed_value_jsonb, evidence_jsonb, confidence,
            status, content_hash)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
                 $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13)
         ON CONFLICT (run_id, content_hash) DO NOTHING`,
        runId,
        tenantId,
        clientId,
        input.kind,
        input.targetKey,
        input.source,
        input.factKind,
        JSON.stringify(input.currentValue ?? null),
        JSON.stringify(input.proposedValue),
        JSON.stringify(input.evidence),
        Math.max(0, Math.min(1, input.confidence)),
        input.status,
        contentHash,
      );
      return Number(inserted) > 0;
    });
  }

  private async getCursor(tenantId: string, clientId: string, source: string) {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ watermark: unknown }>>(
        `SELECT watermark_jsonb AS watermark
           FROM client_profile_fill_source_cursor
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND source = $3`,
        tenantId,
        clientId,
        source,
      ),
    );
    return asRecord(rows[0]?.watermark);
  }

  private async recordCursor(
    tenantId: string,
    clientId: string,
    source: string,
    watermark: Record<string, unknown>,
  ) {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO client_profile_fill_source_cursor
           (tenant_id, client_id, source, watermark_jsonb, last_successful_at,
            last_attempt_at, last_error, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, now(), now(), NULL, now())
         ON CONFLICT (tenant_id, client_id, source) DO UPDATE
           SET watermark_jsonb = client_profile_fill_source_cursor.watermark_jsonb || EXCLUDED.watermark_jsonb,
               last_successful_at = now(), last_attempt_at = now(), last_error = NULL,
               updated_at = now()`,
        tenantId,
        clientId,
        source,
        JSON.stringify(watermark),
      ),
    );
  }
}

function missingAddressParts(value: {
  addressLine?: unknown;
  city?: unknown;
  state?: unknown;
}) {
  const missing: string[] = [];
  if (!asString(value.addressLine)) missing.push('street address');
  if (!asString(value.city)) missing.push('city');
  if (!asString(value.state)) missing.push('state');
  return missing;
}

function recordsFromUnknown(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((row) => Object.keys(row).length > 0);
  const row = asRecord(value);
  for (const key of ['activities', 'lobbying_activities', 'items', 'results']) {
    if (Array.isArray(row[key])) return (row[key] as unknown[]).map(asRecord);
  }
  return Object.keys(row).length ? [row] : [];
}

function summarizeLdaActivity(activity: Record<string, unknown>, fallback: string | null) {
  for (const key of [
    'specific_issues',
    'specificIssues',
    'description',
    'issue_description',
    'issueDescription',
    'text',
  ]) {
    const value = asString(activity[key]);
    if (value) return value.slice(0, 4_000);
  }
  return fallback?.slice(0, 4_000) ?? null;
}

function normalizePersistedAdvocacy(row: Record<string, unknown>) {
  return {
    externalKey: row.external_key,
    recordType: row.record_type,
    title: row.title,
    summary: row.summary,
    activityDate: row.activity_date,
    sourceType: row.source_type,
    sourceId: row.source_id,
    metadata: row.metadata_jsonb,
  };
}

function containsAdvocacyTerm(value: string) {
  const normalized = value.toLowerCase();
  return ADVOCACY_TITLE_TERMS.some((term) => normalized.includes(term));
}

function parseDate(value: unknown): Date | null {
  const text = asString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(api[_-]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 800);
}
