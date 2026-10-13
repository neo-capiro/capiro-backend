import type { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '@prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ClientPrepopulationService } from './client-prepopulation.service.js';

export interface ClientMappingV1ReviewPorts {
  awardBearingMappingSource(source: string): boolean;
  prepopulation(): ClientPrepopulationService | undefined;
}

type ManualMappingInput = {
  source: string;
  externalId: string;
  externalName: string;
  relationshipType?: string | null;
  rollUpAwards?: boolean | null;
  actorUserId: string;
};
type ReviewMappingInput = {
  confirmed: boolean;
  relationshipType?: string;
  rollUpAwards?: boolean;
  rejectionReason?: string;
  actorUserId: string;
};

export class ClientMappingV1Review {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientMappingV1ReviewPorts,
  ) {}

  async createManualMapping(
    clientId: string,
    tenantId: string,
    input: {
      source: string;
      externalId: string;
      externalName: string;
      relationshipType?: string | null;
      rollUpAwards?: boolean | null;
      actorUserId: string;
    },
  ) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!client) throw new NotFoundException('Client not found');
    if (
      this.ports.awardBearingMappingSource(input.source) &&
      (input.relationshipType == null || input.rollUpAwards == null)
    ) {
      throw new BadRequestException(
        'Award-bearing federal mappings require a reviewed relationship type and an explicit award roll-up decision.',
      );
    }

    if (input.source === 'fec_committee') {
      const committeeId = input.externalId.trim().toUpperCase();
      if (!/^C\d{8}$/.test(committeeId)) {
        throw new BadRequestException('Select a valid FEC PAC committee ID.');
      }
      const committee = await this.prisma.fecCommittee.findUnique({
        where: { id: committeeId },
        select: { name: true, committeeType: true },
      });
      if (!committee || !['Q', 'N', 'O', 'V', 'W'].includes(committee.committeeType ?? '')) {
        throw new BadRequestException('Select a PAC from the imported FEC committee catalog.');
      }
      input = { ...input, externalId: committeeId, externalName: committee.name };
    }

    const mapping = await this.persistManualMapping(clientId, tenantId, input);

    if (input.source === 'lda') {
      await this.ports.prepopulation()?.prepopulate(tenantId, clientId);
    }
    return mapping;
  }

  async rejectMappingCandidate(
    clientId: string,
    tenantId: string,
    input: {
      source: 'contracting';
      externalId: string;
      externalName: string;
      reason: string | null;
      actorUserId: string;
    },
  ) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!client) throw new NotFoundException('Client not found');
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.clientIntelMapping.findUnique({
        where: {
          clientId_source_externalId: {
            clientId,
            source: input.source,
            externalId: input.externalId,
          },
        },
      });
      const saved = await tx.clientIntelMapping.upsert({
        where: {
          clientId_source_externalId: {
            clientId,
            source: input.source,
            externalId: input.externalId,
          },
        },
        update: {
          externalName: input.externalName,
          confirmed: false,
          reviewStatus: 'rejected',
          reviewedBy: input.actorUserId,
          reviewedAt: new Date(),
          rejectionReason: input.reason ?? 'Rejected by reviewer',
          rollUpAwards: false,
        },
        create: {
          tenantId,
          clientId,
          source: input.source,
          externalId: input.externalId,
          externalName: input.externalName,
          confidence: 0,
          confirmed: false,
          reviewStatus: 'rejected',
          reviewedBy: input.actorUserId,
          reviewedAt: new Date(),
          rejectionReason: input.reason ?? 'Rejected by reviewer',
          rollUpAwards: false,
          matchBasis: 'fuzzy_name',
          matchTier: 4,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorUserId: input.actorUserId,
          action: 'intelligence_mapping.rejected',
          entityType: 'client_intel_mapping',
          entityId: saved.id,
          before: before ? (before as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          after: saved as unknown as Prisma.InputJsonValue,
        },
      });
      return saved;
    });
  }

  async confirmMapping(
    mappingId: string,
    input: {
      confirmed: boolean;
      relationshipType?: string;
      rollUpAwards?: boolean;
      rejectionReason?: string;
      actorUserId: string;
    },
    tenantId: string,
  ) {
    const mapping = await this.persistReviewedMapping(mappingId, input, tenantId);
    if (mapping.source === 'lda') {
      await this.ports.prepopulation()?.prepopulate(tenantId, mapping.clientId);
    }
    return mapping;
  }

  private persistManualMapping(clientId: string, tenantId: string, input: ManualMappingInput) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.clientIntelMapping.findUnique({
        where: {
          clientId_source_externalId: {
            clientId,
            source: input.source,
            externalId: input.externalId,
          },
        },
      });
      const saved = await tx.clientIntelMapping.upsert({
        where: {
          clientId_source_externalId: {
            clientId,
            source: input.source,
            externalId: input.externalId,
          },
        },
        update: {
          externalName: input.externalName,
          confirmed: true,
          matchBasis: 'manual_pin',
          matchTier: 1,
          reviewStatus: 'confirmed',
          reviewedBy: input.actorUserId,
          reviewedAt: new Date(),
          rejectionReason: null,
          ...(input.relationshipType !== undefined
            ? { relationshipType: input.relationshipType }
            : {}),
          ...(input.rollUpAwards !== undefined ? { rollUpAwards: input.rollUpAwards } : {}),
        },
        create: {
          tenantId,
          clientId,
          source: input.source,
          externalId: input.externalId,
          externalName: input.externalName,
          confidence: 1,
          confirmed: true,
          matchBasis: 'manual_pin',
          matchTier: 1,
          reviewStatus: 'confirmed',
          reviewedBy: input.actorUserId,
          reviewedAt: new Date(),
          rejectionReason: null,
          ...(input.relationshipType !== undefined
            ? { relationshipType: input.relationshipType }
            : {}),
          ...(input.rollUpAwards !== undefined ? { rollUpAwards: input.rollUpAwards } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorUserId: input.actorUserId,
          action: 'intelligence_mapping.confirmed',
          entityType: 'client_intel_mapping',
          entityId: saved.id,
          before: before ? (before as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          after: saved as unknown as Prisma.InputJsonValue,
        },
      });
      return saved;
    });
  }

  private persistReviewedMapping(mappingId: string, input: ReviewMappingInput, tenantId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.clientIntelMapping.findUnique({ where: { id: mappingId } });
      const owned = existing
        ? await tx.client.findFirst({ where: { id: existing.clientId }, select: { id: true } })
        : null;
      if (!existing || !owned) throw new NotFoundException('Mapping not found');

      // P05 — award-bearing identity may only be decided EXPLICITLY, per decision.
      //
      // Three things changed here, each closing a separate hole:
      //
      // 1. `assistance_recipient` is now covered. Only `contracting` was, so an
      //    assistance mapping could be confirmed with relationshipType and
      //    rollUpAwards left NULL — and NULL means "do not roll up", so the row was
      //    confirmed but invisible to every roll-up read. Confirmed-but-inert is
      //    the worst of the three possible states because it looks decided.
      //
      // 2. The values must be present in THIS request. The old code fell back to
      //    `?? existing.*`, so re-confirming a row silently reused a decision made
      //    at some other time, for some other reason, possibly by someone else —
      //    and a bulk toggle sending only `{confirmed:true}` satisfied the guard.
      //
      // 3. Rejecting an award-bearing mapping now needs a written reason. A reject
      //    is a single PATCH, so the server cannot tell a bulk sweep from an
      //    individual decision; requiring a reason is what a sweep cannot supply.
      if (this.ports.awardBearingMappingSource(existing.source)) {
        if (input.confirmed) {
          if (input.relationshipType == null || input.rollUpAwards == null) {
            throw new BadRequestException(
              'Confirming an award-bearing identity requires an explicit relationship type and an explicit award roll-up decision on this request. Whose money this is cannot be inherited from a previous decision.',
            );
          }
        } else if (!input.rejectionReason?.trim()) {
          throw new BadRequestException(
            'Rejecting an award-bearing identity requires a written reason, so the decision is reviewable later.',
          );
        }
      }

      const saved = await tx.clientIntelMapping.update({
        where: { id: mappingId },
        data: {
          confirmed: input.confirmed,
          reviewStatus: input.confirmed ? 'confirmed' : 'rejected',
          reviewedBy: input.actorUserId,
          reviewedAt: new Date(),
          rejectionReason: input.confirmed
            ? null
            : (input.rejectionReason ?? 'Rejected by reviewer'),
          ...(input.relationshipType !== undefined
            ? { relationshipType: input.relationshipType }
            : {}),
          ...(input.rollUpAwards !== undefined ? { rollUpAwards: input.rollUpAwards } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorUserId: input.actorUserId,
          action: input.confirmed
            ? 'intelligence_mapping.confirmed'
            : 'intelligence_mapping.rejected',
          entityType: 'client_intel_mapping',
          entityId: saved.id,
          before: existing as unknown as Prisma.InputJsonValue,
          after: saved as unknown as Prisma.InputJsonValue,
        },
      });
      return saved;
    });
  }
}
