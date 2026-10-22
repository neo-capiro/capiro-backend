import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';

export type SingleMailState = 'pending' | 'sending' | 'accepted' | 'unknown' | 'failed';
export type SingleMailIntent = {
  id: string;
  request_key: string;
  request_hash: string;
  connection_id: string;
  client_id: string | null;
  state: SingleMailState;
  snapshot: Record<string, unknown>;
  receipt: Record<string, unknown> | null;
};

/** Hash a canonical request, including Bcc, mailbox, reply, signature policy and attachments. */
export function singleMailHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** Uses the mail domain's existing transaction/claim pattern. No worker or retry loop. */
export class SingleMailLedger {
  constructor(private readonly prisma: Pick<PrismaService, 'withTenant'>) {}

  validateKey(requestKey: string | undefined): string {
    if (
      !requestKey ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)
    ) {
      throw new BadRequestException('A durable mail requestKey UUID is required');
    }
    return requestKey;
  }

  async read(ctx: TenantContext, requestKey: string): Promise<SingleMailIntent | null> {
    this.validateKey(requestKey);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<SingleMailIntent[]>(Prisma.sql`
        SELECT id, request_key, request_hash, connection_id, client_id, state, snapshot, receipt
        FROM single_mail_intents WHERE tenant_id=${ctx.tenantId}::uuid
          AND actor_id=${ctx.userId}::uuid AND request_key=${requestKey}::uuid`);
      return rows[0] ?? null;
    });
  }

  assertRequest(row: SingleMailIntent, requestHash: string) {
    if (row.request_hash !== requestHash)
      throw new ConflictException('Mail request key already binds different content');
  }

  async begin(
    ctx: TenantContext,
    input: {
      requestKey: string;
      requestHash: string;
      connectionId: string;
      clientId: string | null;
      snapshot: Record<string, unknown>;
    },
  ): Promise<{ intent: SingleMailIntent; created: boolean }> {
    this.validateKey(input.requestKey);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const inserted = await tx.$queryRaw<SingleMailIntent[]>(Prisma.sql`
        INSERT INTO single_mail_intents
          (id, tenant_id, actor_id, request_key, request_hash, connection_id, client_id, state, snapshot)
        VALUES (${randomUUID()}::uuid, ${ctx.tenantId}::uuid, ${ctx.userId}::uuid,
          ${input.requestKey}::uuid, ${input.requestHash}, ${input.connectionId}::uuid,
          ${input.clientId}::uuid, 'pending', ${JSON.stringify(input.snapshot)}::jsonb)
        ON CONFLICT (tenant_id, actor_id, request_key) DO NOTHING
        RETURNING id, request_key, request_hash, connection_id, client_id, state, snapshot, receipt`);
      if (inserted[0]) return { intent: inserted[0], created: true };
      const rows = await tx.$queryRaw<SingleMailIntent[]>(Prisma.sql`
        SELECT id, request_key, request_hash, connection_id, client_id, state, snapshot, receipt
        FROM single_mail_intents WHERE tenant_id=${ctx.tenantId}::uuid
          AND actor_id=${ctx.userId}::uuid AND request_key=${input.requestKey}::uuid`);
      if (!rows[0]) throw new NotFoundException('Mail intent not found');
      this.assertRequest(rows[0], input.requestHash);
      return { intent: rows[0], created: false };
    });
  }

  async claim(
    ctx: TenantContext,
    intent: SingleMailIntent,
    authorize: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<boolean> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await authorize(tx);
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE single_mail_intents SET state='sending', updated_at=now()
        WHERE id=${intent.id}::uuid AND tenant_id=${ctx.tenantId}::uuid
          AND actor_id=${ctx.userId}::uuid AND state='pending'`);
      return changed === 1;
    });
  }

  /** Outcome writes intentionally do not recheck current client access after provider dispatch. */
  async outcome(
    ctx: TenantContext,
    intent: SingleMailIntent,
    state: 'accepted' | 'unknown' | 'failed',
    evidence: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE single_mail_intents SET state=${state}, provider_evidence=${JSON.stringify(evidence)}::jsonb, updated_at=now()
        WHERE id=${intent.id}::uuid AND tenant_id=${ctx.tenantId}::uuid
          AND actor_id=${ctx.userId}::uuid AND state='sending'`);
      if (changed !== 1) throw new ConflictException('Mail outcome could not be recorded');
    });
  }

  async receipt(ctx: TenantContext, intent: SingleMailIntent, receipt: Record<string, unknown>) {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE single_mail_intents SET receipt=${JSON.stringify(receipt)}::jsonb, updated_at=now()
        WHERE id=${intent.id}::uuid AND tenant_id=${ctx.tenantId}::uuid
          AND actor_id=${ctx.userId}::uuid AND state='accepted'`);
    });
  }

  view(row: SingleMailIntent) {
    return {
      intentId: row.id,
      requestKey: row.request_key,
      state: row.state,
      retryable: false as const,
      ...(row.state === 'accepted' && row.receipt ? row.receipt : {}),
    };
  }
}
