import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Read the tenant's firm phases (ordered). Editing arrives in G4. */
@Injectable()
export class FirmPhasesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.spFirmPhase.findMany({
        orderBy: { position: 'asc' },
        select: {
          id: true,
          label: true,
          startFy: true,
          startQ: true,
          endFy: true,
          endQ: true,
          position: true,
        },
      }),
    );
  }
}
