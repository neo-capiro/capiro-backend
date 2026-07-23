import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { FirmPhasesDto } from './dto/firm-phases.dto.js';

const phaseSelect = {
  id: true,
  label: true,
  startFy: true,
  startQ: true,
  endFy: true,
  endQ: true,
  position: true,
  updatedByUserId: true,
  updatedAt: true,
} as const;

/** Absolute quarter ordinal for ordering (FY*4 + q-1), so exclusive-end bounds compare cleanly. */
const qOrdinal = (fy: number, q: number) => fy * 4 + (q - 1);

/**
 * Firm phases (PHS) — tenant-wide ordered config. Read + full-replace. Not
 * versioned (they're firm config, not a strategy) — attribution is the
 * sp_activity_log row + updatedByUserId (D15). "Configured" = >=1 row exists.
 */
@Injectable()
export class FirmPhasesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.spFirmPhase.findMany({ orderBy: { position: 'asc' }, select: phaseSelect }),
    );
  }

  /** Atomically replace the tenant's phase set (delete-all + re-insert in order). */
  async replace(tenantId: string, clerkUserId: string, dto: FirmPhasesDto) {
    dto.rows.forEach((r) => {
      if (qOrdinal(r.startFy, r.startQ) >= qOrdinal(r.endFy, r.endQ)) {
        throw new BadRequestException(`Phase "${r.label}" must end after it starts`);
      }
    });

    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      const before = await tx.spFirmPhase.findMany({
        orderBy: { position: 'asc' },
        select: phaseSelect,
      });
      await tx.spFirmPhase.deleteMany({});
      if (dto.rows.length) {
        await tx.spFirmPhase.createMany({
          data: dto.rows.map((r, i) => ({
            tenantId,
            label: r.label,
            startFy: r.startFy,
            startQ: r.startQ,
            endFy: r.endFy,
            endQ: r.endQ,
            position: i,
            updatedByUserId: clerkUserId,
          })),
        });
      }
      await tx.spActivityLog.create({
        data: {
          tenantId,
          actorUserId: clerkUserId,
          authorKind: 'person',
          action: 'firm_phases.updated',
          entityType: 'firm_phases',
          entityId: tenantId,
          before: { rows: before },
          after: {
            rows: dto.rows.map((r) => ({
              label: r.label,
              startFy: r.startFy,
              startQ: r.startQ,
              endFy: r.endFy,
              endQ: r.endQ,
            })),
          },
        },
      });
      return tx.spFirmPhase.findMany({ orderBy: { position: 'asc' }, select: phaseSelect });
    });
  }
}
