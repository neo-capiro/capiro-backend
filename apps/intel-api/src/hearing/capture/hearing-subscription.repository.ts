import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface HearingSubscriptionRow {
  id: string; tenantId: string; userId: string; hearingId: string;
  notifyOnStart: boolean; notifyOnMention: boolean; clientIds: string[]; createdAt: Date;
}

@Injectable()
export class HearingSubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, hearingId: string): Promise<HearingSubscriptionRow[]> {
    // The application role bypasses RLS, so tenant isolation must be in the query.
    return this.prisma.$queryRawUnsafe<HearingSubscriptionRow[]>(
      `SELECT id, tenant_id AS "tenantId", user_id AS "userId", hearing_id AS "hearingId",
              notify_on_start AS "notifyOnStart", notify_on_mention AS "notifyOnMention",
              client_ids AS "clientIds", created_at AS "createdAt"
         FROM hearing_subscription WHERE tenant_id=$1::uuid AND hearing_id=$2 ORDER BY created_at`,
      tenantId, hearingId);
  }

  async countActiveForHearing(hearingId: string): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count:number }>>(
      `SELECT COUNT(*)::int AS count FROM hearing_subscription WHERE hearing_id=$1`, hearingId);
    return rows[0]?.count ?? 0;
  }
}
