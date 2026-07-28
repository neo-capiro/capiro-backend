import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantRole } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export const DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES = [
  'direct_recipient',
  'subrecipient',
  'project_site',
  'research_partner',
  'coalition_partner',
  'beneficiary',
  'matching_contributor',
] as const;

export type DistrictNexusAwardRelationshipType =
  (typeof DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES)[number];

export const DISTRICT_NEXUS_RELATIONSHIP_STATUSES = [
  'unverified',
  'verified',
  'rejected',
] as const;

export type DistrictNexusRelationshipStatus =
  (typeof DISTRICT_NEXUS_RELATIONSHIP_STATUSES)[number];

const MANUAL_EVIDENCE_SOURCE = 'analyst_manual_entry';
const VISIBLE_CLIENT_FILTER = { status: { not: 'archived' }, profileStatus: 'ACTIVE' } as const;

export interface DistrictNexusRelationshipMutationInput {
  assistanceAwardId: string;
  relationshipType: DistrictNexusAwardRelationshipType;
  facilityId?: string | null;
  relationshipDescription?: string | null;
  attributableAmount?: number | null;
  beneficiaryCount?: number | null;
  evidenceSourceRef?: string | null;
  verificationStatus?: DistrictNexusRelationshipStatus;
  externalUseApproved?: boolean;
  effectiveStart?: string | null;
  effectiveEnd?: string | null;
}

export type DistrictNexusRelationshipUpdateInput = Partial<DistrictNexusRelationshipMutationInput>;

const RELATIONSHIP_SELECT = {
  id: true,
  clientId: true,
  assistanceAwardId: true,
  facilityId: true,
  relationshipType: true,
  relationshipDescription: true,
  attributableAmount: true,
  beneficiaryCount: true,
  evidenceSourceType: true,
  evidenceSourceRef: true,
  confidence: true,
  verificationStatus: true,
  externalUseApproved: true,
  verifiedAt: true,
  verifiedByUserId: true,
  effectiveStart: true,
  effectiveEnd: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ClientGrantNexusSelect;

type RelationshipRow = Prisma.ClientGrantNexusGetPayload<{ select: typeof RELATIONSHIP_SELECT }>;

const AWARD_SELECT = {
  id: true,
  awardUniqueId: true,
  fain: true,
  recipientName: true,
  recipientUei: true,
  assistanceListingNumber: true,
  assistanceListingTitle: true,
  awardingAgency: true,
  totalObligatedAmount: true,
  totalOutlayedAmount: true,
  startDate: true,
  endDate: true,
  popState: true,
  popCongressionalDistrict: true,
  recipientState: true,
  recipientCongressionalDistrict: true,
} satisfies Prisma.FederalAssistanceAwardSelect;

type AwardRow = Prisma.FederalAssistanceAwardGetPayload<{ select: typeof AWARD_SELECT }>;

interface AwardLike {
  id: string;
  awardUniqueId: string;
  fain: string | null;
  recipientName: string | null;
  recipientUei: string | null;
  assistanceListingNumber: string | null;
  assistanceListingTitle: string | null;
  awardingAgency: string | null;
  totalObligatedAmount: Prisma.Decimal | number | null;
  totalOutlayedAmount: Prisma.Decimal | number | null;
  startDate: Date | null;
  endDate: Date | null;
  popState: string | null;
  popCongressionalDistrict: string | null;
  recipientState: string | null;
  recipientCongressionalDistrict: string | null;
}

const FACILITY_SELECT = {
  id: true,
  name: true,
  city: true,
  state: true,
  congressionalDistrict: true,
} satisfies Prisma.ClientFacilitySelect;

type FacilityRow = Prisma.ClientFacilityGetPayload<{ select: typeof FACILITY_SELECT }>;

export interface DistrictNexusRelationshipRecord {
  id: string;
  clientId: string;
  assistanceAwardId: string;
  facilityId: string | null;
  relationshipType: DistrictNexusAwardRelationshipType;
  relationshipDescription: string | null;
  attributableAmount: number | null;
  beneficiaryCount: number | null;
  evidenceSourceType: string;
  evidenceSourceRef: string | null;
  confidence: number;
  verificationStatus: DistrictNexusRelationshipStatus;
  externalUseApproved: boolean;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  createdAt: string;
  updatedAt: string;
  award: DistrictNexusAssistanceAwardOption;
  facility: DistrictNexusFacilityOption | null;
}

export interface DistrictNexusFacilityOption {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  congressionalDistrict: string | null;
}

export interface DistrictNexusAssistanceAwardOption {
  id: string;
  awardUniqueId: string;
  fain: string | null;
  recipientName: string | null;
  recipientUei: string | null;
  assistanceListingNumber: string | null;
  assistanceListingTitle: string | null;
  awardingAgency: string | null;
  totalObligatedAmount: number | null;
  totalOutlayedAmount: number | null;
  startDate: string | null;
  endDate: string | null;
  state: string | null;
  congressionalDistrict: string | null;
  geographyBasis: 'place_of_performance' | 'recipient_location' | 'unknown';
}

export interface DistrictNexusRelationshipListResponse {
  relationships: DistrictNexusRelationshipRecord[];
  facilities: DistrictNexusFacilityOption[];
}

interface MutationActor {
  userId: string;
  role: TenantRole;
}

interface NormalizedRelationshipValues {
  assistanceAwardId: string;
  relationshipType: DistrictNexusAwardRelationshipType;
  facilityId: string | null;
  relationshipDescription: string | null;
  attributableAmount: number | null;
  beneficiaryCount: number | null;
  evidenceSourceRef: string | null;
  verificationStatus: DistrictNexusRelationshipStatus;
  externalUseApproved: boolean;
  effectiveStart: Date | null;
  effectiveEnd: Date | null;
}

function money(value: Prisma.Decimal | number | null): number | null {
  return value == null ? null : Number(value);
}

function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function isoTimestamp(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseDate(value: string | null | undefined, field: string): Date | null {
  if (value == null || value.trim() === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw new BadRequestException(`${field} must use YYYY-MM-DD.`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new BadRequestException(`${field} is not a valid calendar date.`);
  }
  return date;
}

function confidenceFor(status: DistrictNexusRelationshipStatus): number {
  if (status === 'verified') return 1;
  if (status === 'rejected') return 0;
  return 0.5;
}

function awardOption(row: AwardLike): DistrictNexusAssistanceAwardOption {
  const usesPlaceOfPerformance = !!row.popState;
  const usesRecipient = !usesPlaceOfPerformance && !!row.recipientState;
  return {
    id: row.id,
    awardUniqueId: row.awardUniqueId,
    fain: row.fain,
    recipientName: row.recipientName,
    recipientUei: row.recipientUei,
    assistanceListingNumber: row.assistanceListingNumber,
    assistanceListingTitle: row.assistanceListingTitle,
    awardingAgency: row.awardingAgency,
    totalObligatedAmount: money(row.totalObligatedAmount),
    totalOutlayedAmount: money(row.totalOutlayedAmount),
    startDate: isoDate(row.startDate),
    endDate: isoDate(row.endDate),
    state: usesPlaceOfPerformance ? row.popState : row.recipientState,
    congressionalDistrict: usesPlaceOfPerformance
      ? row.popCongressionalDistrict
      : row.recipientCongressionalDistrict,
    geographyBasis: usesPlaceOfPerformance
      ? 'place_of_performance'
      : usesRecipient
        ? 'recipient_location'
        : 'unknown',
  };
}

function facilityOption(row: FacilityRow): DistrictNexusFacilityOption {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    state: row.state,
    congressionalDistrict: row.congressionalDistrict,
  };
}

function serializeRelationship(
  row: RelationshipRow,
  award: AwardRow,
  facility: FacilityRow | null,
): DistrictNexusRelationshipRecord {
  if (!row.assistanceAwardId) {
    throw new Error(`ClientGrantNexus ${row.id} has no assistance award id.`);
  }
  return {
    id: row.id,
    clientId: row.clientId,
    assistanceAwardId: row.assistanceAwardId,
    facilityId: row.facilityId,
    relationshipType: row.relationshipType as DistrictNexusAwardRelationshipType,
    relationshipDescription: row.relationshipDescription,
    attributableAmount: money(row.attributableAmount),
    beneficiaryCount: row.beneficiaryCount,
    evidenceSourceType: row.evidenceSourceType,
    evidenceSourceRef: row.evidenceSourceRef,
    confidence: row.confidence,
    verificationStatus: row.verificationStatus as DistrictNexusRelationshipStatus,
    externalUseApproved: row.externalUseApproved,
    verifiedAt: isoTimestamp(row.verifiedAt),
    verifiedByUserId: row.verifiedByUserId,
    effectiveStart: isoDate(row.effectiveStart),
    effectiveEnd: isoDate(row.effectiveEnd),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    award: awardOption(award),
    facility: facility ? facilityOption(facility) : null,
  };
}

function auditSnapshot(row: RelationshipRow): Prisma.InputJsonObject {
  return {
    id: row.id,
    clientId: row.clientId,
    assistanceAwardId: row.assistanceAwardId,
    facilityId: row.facilityId,
    relationshipType: row.relationshipType,
    relationshipDescription: row.relationshipDescription,
    attributableAmount: money(row.attributableAmount),
    beneficiaryCount: row.beneficiaryCount,
    evidenceSourceType: row.evidenceSourceType,
    evidenceSourceRef: row.evidenceSourceRef,
    confidence: row.confidence,
    verificationStatus: row.verificationStatus,
    externalUseApproved: row.externalUseApproved,
    verifiedAt: isoTimestamp(row.verifiedAt),
    verifiedByUserId: row.verifiedByUserId,
    effectiveStart: isoDate(row.effectiveStart),
    effectiveEnd: isoDate(row.effectiveEnd),
  } as Prisma.InputJsonObject;
}

@Injectable()
export class DistrictNexusRelationshipsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    clientId: string,
  ): Promise<DistrictNexusRelationshipListResponse> {
    const scoped = await this.prisma.withTenant(tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, ...VISIBLE_CLIENT_FILTER },
        select: { id: true },
      });
      if (!client) throw new NotFoundException('Client not found.');

      const [relationships, facilities] = await Promise.all([
        tx.clientGrantNexus.findMany({
          where: {
            clientId,
            assistanceAwardId: { not: null },
            relationshipType: { in: [...DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES] },
            evidenceSourceType: MANUAL_EVIDENCE_SOURCE,
          },
          select: RELATIONSHIP_SELECT,
          orderBy: [{ verificationStatus: 'asc' }, { updatedAt: 'desc' }],
        }),
        tx.clientFacility.findMany({
          where: { clientId, client: VISIBLE_CLIENT_FILTER },
          select: FACILITY_SELECT,
          orderBy: [{ state: 'asc' }, { name: 'asc' }],
        }),
      ]);
      return { relationships, facilities };
    });

    const awardIds = Array.from(
      new Set(
        scoped.relationships
          .map((row) => row.assistanceAwardId)
          .filter((id): id is string => id != null),
      ),
    );
    const awards = awardIds.length
      ? await this.prisma.federalAssistanceAward.findMany({
          where: { id: { in: awardIds } },
          select: AWARD_SELECT,
        })
      : [];
    const awardById = new Map(awards.map((row) => [row.id, row]));
    const facilityById = new Map(scoped.facilities.map((row) => [row.id, row]));

    return {
      relationships: scoped.relationships.flatMap((row) => {
        const award = row.assistanceAwardId ? awardById.get(row.assistanceAwardId) : undefined;
        if (!award) return [];
        return [
          serializeRelationship(
            row,
            award,
            row.facilityId ? facilityById.get(row.facilityId) ?? null : null,
          ),
        ];
      }),
      facilities: scoped.facilities.map(facilityOption),
    };
  }

  async searchAwards(query: string): Promise<DistrictNexusAssistanceAwardOption[]> {
    const term = query.trim();
    if (term.length < 2) return [];
    const prefix = `${term}%`;

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        award_unique_id: string;
        fain: string | null;
        recipient_name: string | null;
        recipient_uei: string | null;
        assistance_listing_number: string | null;
        assistance_listing_title: string | null;
        awarding_agency: string | null;
        total_obligated_amount: number | null;
        total_outlayed_amount: number | null;
        start_date: Date | null;
        end_date: Date | null;
        pop_state: string | null;
        pop_congressional_district: string | null;
        recipient_state: string | null;
        recipient_congressional_district: string | null;
      }>
    >`
      SELECT id::text AS id,
             award_unique_id,
             fain,
             recipient_name,
             recipient_uei,
             assistance_listing_number,
             assistance_listing_title,
             awarding_agency,
             total_obligated_amount::float8 AS total_obligated_amount,
             total_outlayed_amount::float8 AS total_outlayed_amount,
             start_date,
             end_date,
             pop_state,
             pop_congressional_district,
             recipient_state,
             recipient_congressional_district
      FROM federal_assistance_award
      WHERE recipient_uei = upper(${term})
         OR fain ILIKE ${prefix}
         OR award_unique_id ILIKE ${prefix}
         OR assistance_listing_number = ${term}
         OR lower(recipient_name) % lower(${term})
      ORDER BY CASE
                 WHEN recipient_uei = upper(${term}) THEN 0
                 WHEN fain ILIKE ${prefix} THEN 1
                 WHEN award_unique_id ILIKE ${prefix} THEN 2
                 WHEN assistance_listing_number = ${term} THEN 3
                 ELSE 4
               END,
               similarity(lower(COALESCE(recipient_name, '')), lower(${term})) DESC,
               total_obligated_amount DESC NULLS LAST
      LIMIT 25
    `;

    return rows.map((row) =>
      awardOption({
        id: row.id,
        awardUniqueId: row.award_unique_id,
        fain: row.fain,
        recipientName: row.recipient_name,
        recipientUei: row.recipient_uei,
        assistanceListingNumber: row.assistance_listing_number,
        assistanceListingTitle: row.assistance_listing_title,
        awardingAgency: row.awarding_agency,
        totalObligatedAmount: row.total_obligated_amount,
        totalOutlayedAmount: row.total_outlayed_amount,
        startDate: row.start_date,
        endDate: row.end_date,
        popState: row.pop_state,
        popCongressionalDistrict: row.pop_congressional_district,
        recipientState: row.recipient_state,
        recipientCongressionalDistrict: row.recipient_congressional_district,
      }),
    );
  }

  async create(
    tenantId: string,
    clientId: string,
    actor: MutationActor,
    input: DistrictNexusRelationshipMutationInput,
  ): Promise<DistrictNexusRelationshipRecord> {
    const award = await this.requireAward(input.assistanceAwardId);
    const normalized = this.normalizeCreate(input, award);

    const result = await this.withDuplicateGuard(() =>
      this.prisma.withTenant(tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, ...VISIBLE_CLIENT_FILTER },
        select: { id: true },
      });
      if (!client) throw new NotFoundException('Client not found.');

      const facility = await this.requireFacility(tx, clientId, normalized.facilityId);
      await this.assertNoDuplicate(tx, clientId, null, normalized);

      const row = await tx.clientGrantNexus.create({
        data: {
          tenantId,
          clientId,
          assistanceAwardId: normalized.assistanceAwardId,
          facilityId: normalized.facilityId,
          relationshipType: normalized.relationshipType,
          relationshipDescription: normalized.relationshipDescription,
          attributableAmount: normalized.attributableAmount,
          beneficiaryCount: normalized.beneficiaryCount,
          evidenceSourceType: MANUAL_EVIDENCE_SOURCE,
          evidenceSourceRef: normalized.evidenceSourceRef,
          confidence: confidenceFor(normalized.verificationStatus),
          verificationStatus: normalized.verificationStatus,
          externalUseApproved: normalized.externalUseApproved,
          verifiedAt: normalized.verificationStatus === 'verified' ? new Date() : null,
          verifiedByUserId: normalized.verificationStatus === 'verified' ? actor.userId : null,
          effectiveStart: normalized.effectiveStart,
          effectiveEnd: normalized.effectiveEnd,
        },
        select: RELATIONSHIP_SELECT,
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'district_nexus.grant_relationship.create',
          entityType: 'client_grant_nexus',
          entityId: row.id,
          after: auditSnapshot(row),
        },
      });
      return { row, facility };
      }),
    );

    return serializeRelationship(result.row, award, result.facility);
  }

  async update(
    tenantId: string,
    clientId: string,
    relationshipId: string,
    actor: MutationActor,
    input: DistrictNexusRelationshipUpdateInput,
  ): Promise<DistrictNexusRelationshipRecord> {
    const existing = await this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.clientGrantNexus.findFirst({
        where: {
          id: relationshipId,
          clientId,
          evidenceSourceType: MANUAL_EVIDENCE_SOURCE,
          relationshipType: { in: [...DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES] },
          client: VISIBLE_CLIENT_FILTER,
        },
        select: RELATIONSHIP_SELECT,
      });
      if (!row) throw new NotFoundException('Grant relationship not found.');
      return row;
    });

    const assistanceAwardId = input.assistanceAwardId ?? existing.assistanceAwardId;
    if (!assistanceAwardId) throw new BadRequestException('An assistance award is required.');
    const award = await this.requireAward(assistanceAwardId);
    const normalized = this.normalizeUpdate(existing, input, award);

    const result = await this.withDuplicateGuard(() =>
      this.prisma.withTenant(tenantId, async (tx) => {
      const facility = await this.requireFacility(tx, clientId, normalized.facilityId);
      await this.assertNoDuplicate(tx, clientId, relationshipId, normalized);

      const row = await tx.clientGrantNexus.update({
        where: { id: relationshipId },
        data: {
          assistanceAwardId: normalized.assistanceAwardId,
          facilityId: normalized.facilityId,
          relationshipType: normalized.relationshipType,
          relationshipDescription: normalized.relationshipDescription,
          attributableAmount: normalized.attributableAmount,
          beneficiaryCount: normalized.beneficiaryCount,
          evidenceSourceRef: normalized.evidenceSourceRef,
          confidence: confidenceFor(normalized.verificationStatus),
          verificationStatus: normalized.verificationStatus,
          externalUseApproved: normalized.externalUseApproved,
          verifiedAt: normalized.verificationStatus === 'verified' ? new Date() : null,
          verifiedByUserId: normalized.verificationStatus === 'verified' ? actor.userId : null,
          effectiveStart: normalized.effectiveStart,
          effectiveEnd: normalized.effectiveEnd,
        },
        select: RELATIONSHIP_SELECT,
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'district_nexus.grant_relationship.update',
          entityType: 'client_grant_nexus',
          entityId: row.id,
          before: auditSnapshot(existing),
          after: auditSnapshot(row),
        },
      });
      return { row, facility };
      }),
    );

    return serializeRelationship(result.row, award, result.facility);
  }

  async reject(
    tenantId: string,
    clientId: string,
    relationshipId: string,
    actor: MutationActor,
  ): Promise<{ id: string; verificationStatus: 'rejected' }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.clientGrantNexus.findFirst({
        where: {
          id: relationshipId,
          clientId,
          evidenceSourceType: MANUAL_EVIDENCE_SOURCE,
          relationshipType: { in: [...DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES] },
          client: VISIBLE_CLIENT_FILTER,
        },
        select: RELATIONSHIP_SELECT,
      });
      if (!existing) throw new NotFoundException('Grant relationship not found.');

      const row = await tx.clientGrantNexus.update({
        where: { id: relationshipId },
        data: {
          verificationStatus: 'rejected',
          externalUseApproved: false,
          verifiedAt: null,
          verifiedByUserId: null,
          confidence: 0,
        },
        select: RELATIONSHIP_SELECT,
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'district_nexus.grant_relationship.reject',
          entityType: 'client_grant_nexus',
          entityId: row.id,
          before: auditSnapshot(existing),
          after: auditSnapshot(row),
        },
      });
      return { id: row.id, verificationStatus: 'rejected' as const };
    });
  }

  private async requireAward(id: string): Promise<AwardRow> {
    const award = await this.prisma.federalAssistanceAward.findUnique({
      where: { id },
      select: AWARD_SELECT,
    });
    if (!award) throw new NotFoundException('Federal assistance award not found.');
    return award;
  }

  private async requireFacility(
    tx: Prisma.TransactionClient,
    clientId: string,
    facilityId: string | null,
  ): Promise<FacilityRow | null> {
    if (!facilityId) return null;
    const facility = await tx.clientFacility.findFirst({
      where: { id: facilityId, clientId, client: VISIBLE_CLIENT_FILTER },
      select: FACILITY_SELECT,
    });
    if (!facility) {
      throw new BadRequestException('The selected facility does not belong to this active client.');
    }
    return facility;
  }

  private normalizeCreate(
    input: DistrictNexusRelationshipMutationInput,
    award: AwardRow,
  ): NormalizedRelationshipValues {
    return this.normalizeValues(
      {
        assistanceAwardId: input.assistanceAwardId,
        relationshipType: input.relationshipType,
        facilityId: input.facilityId ?? null,
        relationshipDescription: cleanText(input.relationshipDescription),
        attributableAmount: input.attributableAmount ?? null,
        beneficiaryCount: input.beneficiaryCount ?? null,
        evidenceSourceRef: cleanText(input.evidenceSourceRef),
        verificationStatus: input.verificationStatus ?? 'unverified',
        externalUseApproved: input.externalUseApproved ?? false,
        effectiveStart: parseDate(input.effectiveStart, 'effectiveStart'),
        effectiveEnd: parseDate(input.effectiveEnd, 'effectiveEnd'),
      },
      award,
    );
  }

  private normalizeUpdate(
    existing: RelationshipRow,
    input: DistrictNexusRelationshipUpdateInput,
    award: AwardRow,
  ): NormalizedRelationshipValues {
    return this.normalizeValues(
      {
        assistanceAwardId: input.assistanceAwardId ?? existing.assistanceAwardId!,
        relationshipType:
          input.relationshipType ??
          (existing.relationshipType as DistrictNexusAwardRelationshipType),
        facilityId: input.facilityId === undefined ? existing.facilityId : input.facilityId,
        relationshipDescription:
          input.relationshipDescription === undefined
            ? existing.relationshipDescription
            : cleanText(input.relationshipDescription),
        attributableAmount:
          input.attributableAmount === undefined
            ? money(existing.attributableAmount)
            : input.attributableAmount,
        beneficiaryCount:
          input.beneficiaryCount === undefined
            ? existing.beneficiaryCount
            : input.beneficiaryCount,
        evidenceSourceRef:
          input.evidenceSourceRef === undefined
            ? existing.evidenceSourceRef
            : cleanText(input.evidenceSourceRef),
        verificationStatus:
          input.verificationStatus ??
          (existing.verificationStatus as DistrictNexusRelationshipStatus),
        externalUseApproved:
          input.externalUseApproved === undefined
            ? existing.externalUseApproved
            : input.externalUseApproved,
        effectiveStart:
          input.effectiveStart === undefined
            ? existing.effectiveStart
            : parseDate(input.effectiveStart, 'effectiveStart'),
        effectiveEnd:
          input.effectiveEnd === undefined
            ? existing.effectiveEnd
            : parseDate(input.effectiveEnd, 'effectiveEnd'),
      },
      award,
    );
  }

  private normalizeValues(
    values: NormalizedRelationshipValues,
    award: AwardRow,
  ): NormalizedRelationshipValues {
    if (!DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES.includes(values.relationshipType)) {
      throw new BadRequestException('Unsupported grant relationship type.');
    }
    if (!DISTRICT_NEXUS_RELATIONSHIP_STATUSES.includes(values.verificationStatus)) {
      throw new BadRequestException('Unsupported verification status.');
    }
    if (values.relationshipType === 'project_site' && !values.facilityId) {
      throw new BadRequestException('A project-site relationship requires a client facility.');
    }
    if (values.attributableAmount != null) {
      if (!Number.isFinite(values.attributableAmount) || values.attributableAmount < 0) {
        throw new BadRequestException('Attributable amount must be a non-negative number.');
      }
      const total = money(award.totalObligatedAmount);
      if (total != null && values.attributableAmount > total) {
        throw new BadRequestException(
          'Attributable amount cannot exceed the award total obligated amount.',
        );
      }
    }
    if (
      values.beneficiaryCount != null &&
      (!Number.isInteger(values.beneficiaryCount) || values.beneficiaryCount < 0)
    ) {
      throw new BadRequestException('Beneficiary count must be a non-negative integer.');
    }
    if (values.verificationStatus === 'verified' && !values.evidenceSourceRef) {
      throw new BadRequestException('Verified relationships require an evidence source.');
    }
    if (values.externalUseApproved && values.verificationStatus !== 'verified') {
      throw new BadRequestException(
        'External-use approval requires a verified relationship.',
      );
    }
    if (
      values.effectiveStart &&
      values.effectiveEnd &&
      values.effectiveStart.getTime() > values.effectiveEnd.getTime()
    ) {
      throw new BadRequestException('effectiveStart must be on or before effectiveEnd.');
    }
    return {
      ...values,
      // Rejected/unverified evidence is never eligible for external materials.
      externalUseApproved:
        values.verificationStatus === 'verified' && values.externalUseApproved,
    };
  }

  /**
   * The findFirst probe below is check-then-act and therefore advisory: two
   * concurrent submits can both pass it. The authoritative guarantee is the
   * partial unique index added in
   * 20260808010000_client_grant_nexus_manual_award_unique, which mirrors this
   * probe's predicate exactly. This maps the resulting Prisma P2002 back onto
   * the SAME ConflictException so a race and a plain duplicate are
   * indistinguishable to the caller — a race must not surface as a 500.
   */
  private static isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }

  private static readonly DUPLICATE_MESSAGE =
    'This client already has an active relationship of that type for the selected award and facility.';

  private async withDuplicateGuard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (DistrictNexusRelationshipsService.isDuplicateKeyError(error)) {
        throw new ConflictException(DistrictNexusRelationshipsService.DUPLICATE_MESSAGE);
      }
      throw error;
    }
  }

  private async assertNoDuplicate(
    tx: Prisma.TransactionClient,
    clientId: string,
    currentId: string | null,
    values: {
      assistanceAwardId: string;
      relationshipType: DistrictNexusAwardRelationshipType;
      facilityId: string | null;
    },
  ): Promise<void> {
    const duplicate = await tx.clientGrantNexus.findFirst({
      where: {
        clientId,
        assistanceAwardId: values.assistanceAwardId,
        relationshipType: values.relationshipType,
        facilityId: values.facilityId,
        evidenceSourceType: MANUAL_EVIDENCE_SOURCE,
        verificationStatus: { not: 'rejected' },
        ...(currentId ? { id: { not: currentId } } : {}),
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(DistrictNexusRelationshipsService.DUPLICATE_MESSAGE);
    }
  }
}
