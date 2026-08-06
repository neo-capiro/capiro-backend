import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Prevents the generic held-deliverable review API from becoming a second,
 * weaker decision route for governed memory. Memory rows must use the canonical
 * memory review controller and its assignment, wall, grant, and lineage checks.
 */
@Injectable()
export class MemoryReviewCompatibilityGuardService {
  constructor(private readonly prisma: PrismaService) {}

  async assertNotMemoryReview(
    ctx: TenantContext,
    reviewRequestId: string,
  ): Promise<void> {
    const isMemory = await this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM review_request
            WHERE tenant_id = ${ctx.tenantId}::uuid
              AND id = ${reviewRequestId}::uuid
              AND surface = 'memory'
              AND subject_type = 'memory_candidate'
          ) AS exists
        `);
        return rows[0]?.exists === true;
      },
    );
    if (isMemory) {
      throw new NotFoundException('No review with that id for this surface.');
    }
  }

  filterNonMemoryReviews<T extends { surface: string }>(rows: T[]): T[] {
    return rows.filter((row) => row.surface !== 'memory');
  }
}
