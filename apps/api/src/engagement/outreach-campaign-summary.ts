import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { OutreachDirection } from './outreach-audience.js';

const cursorSchema = z.object({ id: z.string().uuid() }).strict();
const audienceCursorSchema = cursorSchema.extend({ direction: z.enum(['on-behalf', 'to-clients']) });
export type CampaignCursor = z.infer<typeof cursorSchema>;

export function decodeCampaignCursor(value?: string, direction?: OutreachDirection): CampaignCursor | undefined {
  if (!value) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
    const raw: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!direction) return cursorSchema.parse(raw);
    const cursor = audienceCursorSchema.parse(raw);
    if (cursor.direction !== direction) throw new Error('Audience changed');
    return { id: cursor.id };
  } catch {
    throw new BadRequestException('Invalid outreach cursor');
  }
}

export function encodeCampaignCursor(value: CampaignCursor | null, direction?: OutreachDirection): string | null {
  return value ? Buffer.from(JSON.stringify({ ...value, ...(direction ? { direction } : {}) })).toString('base64url') : null;
}

type Delivery = { status: string; totals: unknown } | null;
type Generation = { params: unknown; status: string; items: { status: string }[] } | null;
type LatestDelivery = NonNullable<Delivery> & {
  id: string;
  outreachRecordId: string;
  createdAt: Date;
  finishedAt: Date | null;
};
type LatestGeneration = Omit<NonNullable<Generation>, 'items'> & {
  id: string;
  outreachRecordId: string;
};

/** A bounded page uses three outcome reads, independent of its number of campaigns. */
export async function readCampaignOutcomes(
  prisma: PrismaService,
  ctx: TenantContext,
  ids: string[],
) {
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    const selectedIds = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
    const deliveries = await tx.$queryRaw<LatestDelivery[]>(Prisma.sql`
      SELECT DISTINCT ON (outreach_record_id) id, outreach_record_id AS "outreachRecordId",
        status, totals_jsonb AS totals, created_at AS "createdAt", finished_at AS "finishedAt"
      FROM outreach_send_intents
      WHERE tenant_id = ${ctx.tenantId}::uuid AND user_id = ${ctx.userId}::uuid
        AND test_mode = false AND outreach_record_id IN (${selectedIds})
      ORDER BY outreach_record_id, created_at DESC, id DESC
    `);
    const generations = await tx.$queryRaw<LatestGeneration[]>(Prisma.sql`
      SELECT DISTINCT ON (outreach_record_id) id, outreach_record_id AS "outreachRecordId",
        status, params_jsonb AS params
      FROM outreach_jobs
      WHERE tenant_id = ${ctx.tenantId}::uuid AND user_id = ${ctx.userId}::uuid
        AND kind = 'generate' AND outreach_record_id IN (${selectedIds})
      ORDER BY outreach_record_id, created_at DESC, id DESC
    `);
    const items = generations.length
      ? await tx.outreachJobItem.groupBy({
          by: ['jobId', 'status'],
          where: { tenantId: ctx.tenantId, jobId: { in: generations.map((job) => job.id) } },
        })
      : [];
    return {
      deliveries: new Map(deliveries.map((row) => [row.outreachRecordId, row])),
      generations: new Map(
        generations.map((row) => [
          row.outreachRecordId,
          {
            ...row,
            items: items
              .filter((item) => item.jobId === row.id)
              .map((item) => ({ status: item.status })),
          },
        ]),
      ),
    };
  });
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Classification describes retained native outcomes; it never authorizes generation or sending. */
export function campaignCategory(
  status: string,
  revision: number,
  delivery: Delivery,
  generation: Generation,
) {
  const totals = object(delivery?.totals);
  const deliveryNeedsAttention =
    delivery &&
    (['failed', 'partial'].includes(delivery.status) ||
      ['failed', 'unknown', 'held'].some(
        (key) => typeof totals[key] === 'number' && Number(totals[key]) > 0,
      ));
  const generationNeedsAttention =
    generation &&
    object(generation.params).revision === revision &&
    (['failed', 'partial'].includes(generation.status) ||
      generation.items.some((item) => ['failed', 'held', 'unknown'].includes(item.status)));
  if (
    deliveryNeedsAttention ||
    generationNeedsAttention ||
    ['failed', 'delivery_unknown'].includes(status)
  )
    return 'attention' as const;
  if (status === 'sent' || (delivery?.status === 'complete' && Number(totals.sent ?? 0) > 0))
    return 'sent' as const;
  return 'drafts' as const;
}

export function deliveryTotals(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(object(value)).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
    ),
  );
}
