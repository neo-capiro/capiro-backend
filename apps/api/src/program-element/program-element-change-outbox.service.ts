import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

interface OutboxPayload {
  peCode: string;
  fy: number;
  field: string;
  oldValue: number | null;
  newValue: number;
  dataCorrection?: boolean;
  suppressAlerts?: boolean;
  emission: {
    changeType: string;
    severity: string;
    title: string;
    description: string;
    data: Record<string, unknown>;
  };
}

interface LockedOutboxRow {
  id: string;
  dedupe_key: string;
  pe_code: string;
  event_type: string;
  payload_jsonb: unknown;
  status: string;
}

function asPayload(value: unknown): OutboxPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Program Element outbox payload is malformed');
  }
  const payload = value as Partial<OutboxPayload>;
  if (!payload.peCode || !payload.emission || typeof payload.emission !== 'object') {
    throw new Error('Program Element outbox payload is missing required fields');
  }
  return payload as OutboxPayload;
}

@Injectable()
export class ProgramElementChangeOutboxService {
  private readonly logger = new Logger(ProgramElementChangeOutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  async processById(id: string): Promise<'processed' | 'already_processed' | 'failed'> {
    try {
      return await this.prisma.withSystem(async (tx) => {
        const rows = await tx.$queryRaw<LockedOutboxRow[]>(Prisma.sql`
          SELECT id, dedupe_key, pe_code, event_type, payload_jsonb, status
          FROM program_element_change_outbox
          WHERE id = ${id}::uuid
            AND status IN ('pending', 'failed')
          FOR UPDATE SKIP LOCKED
        `);
        const row = rows[0];
        if (!row) {
          // Another drainer may hold the row lock, or the item may already be
          // terminal. Either way this invocation must not convert a healthy
          // concurrent claim into a failure or increment attempts again.
          return 'already_processed';
        }

        await tx.programElementChangeOutbox.update({
          where: { id },
          data: { status: 'processing', attempts: { increment: 1 }, lastError: null },
        });

        const payload = asPayload(row.payload_jsonb);
        if (!payload.dataCorrection && !payload.suppressAlerts) {
          const [watches, capabilities] = await Promise.all([
            tx.programElementWatch.findMany({
              where: { peCode: row.pe_code },
              select: { tenantId: true },
            }),
            tx.clientCapability.findMany({
              where: {
                OR: [{ peNumber: row.pe_code }, { peNumbers: { has: row.pe_code } }],
              },
              select: { tenantId: true, clientId: true },
            }),
          ]);

          const byTenant = new Map<string, Set<string>>();
          for (const watch of watches) {
            if (!byTenant.has(watch.tenantId)) byTenant.set(watch.tenantId, new Set());
          }
          for (const capability of capabilities) {
            const ids = byTenant.get(capability.tenantId) ?? new Set<string>();
            ids.add(capability.clientId);
            byTenant.set(capability.tenantId, ids);
          }

          for (const [tenantId, clientIds] of byTenant.entries()) {
            const tenantDedupeKey = `${row.dedupe_key}:tenant:${tenantId}`;
            await tx.intelligenceChange.upsert({
              where: { dedupeKey: tenantDedupeKey },
              create: {
                source: 'program_element',
                changeType: payload.emission.changeType,
                severity: payload.emission.severity,
                title: payload.emission.title,
                description: payload.emission.description,
                relatedClientIds: [...clientIds],
                relatedIssues: [],
                relatedPeCodes: [row.pe_code],
                dedupeKey: tenantDedupeKey,
                data: {
                  ...payload.emission.data,
                  tenantId,
                  outboxDedupeKey: row.dedupe_key,
                  dataCorrection: false,
                },
              },
              update: {},
            });
          }
        }

        await tx.programElementChangeOutbox.update({
          where: { id },
          data: { status: 'processed', processedAt: new Date(), lastError: null },
        });
        return 'processed';
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.programElementChangeOutbox
        .updateMany({
          where: { id, status: { not: 'processed' } },
          data: {
            status: 'failed',
            attempts: { increment: 1 },
            lastError: message.slice(0, 4000),
          },
        })
        .catch(() => undefined);
      this.logger.warn(`Program Element outbox ${id} failed: ${message}`);
      return 'failed';
    }
  }

  async drain(limit = 50): Promise<{ processed: number; failed: number }> {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = await this.prisma.programElementChangeOutbox.findMany({
      where: { status: { in: ['pending', 'failed'] } },
      orderBy: { createdAt: 'asc' },
      take: bounded,
      select: { id: true },
    });
    let processed = 0;
    let failed = 0;
    for (const row of rows) {
      const result = await this.processById(row.id);
      if (result === 'failed') failed += 1;
      else processed += 1;
    }
    return { processed, failed };
  }
}
