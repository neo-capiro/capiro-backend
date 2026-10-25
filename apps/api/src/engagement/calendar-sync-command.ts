import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { IntegrationConnection, Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { assertActiveMailboxActor, lockMailboxConnection } from './mailbox-oauth-authority.js';
import {
  assertMailboxSyncCurrent,
  mailboxState,
  mergeMailboxSyncState,
  withMailboxSyncClaim,
} from './mailbox-sync-claim.js';

export async function hasPendingCalendarCommand(
  prisma: PrismaService,
  tenantId: string,
  connectionId: string,
) {
  return prisma.withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{ requestId: string }>
    >`SELECT request_id::text AS "requestId" FROM calendar_sync_commands
      WHERE tenant_id=${tenantId}::uuid AND connection_id=${connectionId}::uuid AND status='pending'`;
    return rows.length > 0;
  });
}

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const instant = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const inputSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: uuid,
    range: z.object({ from: instant, to: instant }).strict().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      !value.range ||
      (Date.parse(value.range.from) < Date.parse(value.range.to) &&
        Date.parse(value.range.to) - Date.parse(value.range.from) <= 732 * 86400000),
  );
export type CalendarCommandInput = z.infer<typeof inputSchema>;
export type CalendarProgress = Record<string, unknown>;
type Provider = 'microsoft_365' | 'google_workspace';
type Saved = {
  requestId: string;
  connectionId: string;
  provider: Provider;
  accountId: string;
  payloadDigest: string;
  command: CalendarCommandInput;
  window: { from: string; to: string };
  progress: CalendarProgress;
  status: 'pending' | 'completed';
  createdAt: Date;
  updatedAt: Date;
};
export type CalendarCommandRun = {
  connection: IntegrationConnection;
  explicitWindow: boolean;
  progress: CalendarProgress;
  window: Saved['window'];
  checkpoint: (
    progress: CalendarProgress,
    tx?: Prisma.TransactionClient,
    verifyOnly?: boolean,
  ) => Promise<void>;
};
export function parseCalendarCommand(input: unknown, provider: Provider): CalendarCommandInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || (provider === 'google_workspace' && parsed.data.range))
    throw new BadRequestException('Review the calendar request and supported date range');
  return parsed.data;
}
const absent = () => new NotFoundException('Calendar request not found');
const uncertain = () =>
  new ServiceUnavailableException('Calendar progress is uncertain; recover the same request');
function result(row: Saved) {
  return {
    schemaVersion: 1 as const,
    requestId: row.requestId,
    connectionId: row.connectionId,
    provider: row.provider,
    payloadDigest: row.payloadDigest,
    range: row.command.range,
    window: row.window,
    status: row.status,
    calendar: mailboxState(row.progress.lastStats),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
async function saved(tx: Prisma.TransactionClient, ctx: TenantContext, requestId: string) {
  const rows = await tx.$queryRaw<
    Saved[]
  >`SELECT request_id::text AS "requestId", connection_id::text AS "connectionId",
    provider, account_id AS "accountId", payload_digest AS "payloadDigest", command_jsonb AS command,
    window_jsonb AS window, progress_jsonb AS progress, status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM calendar_sync_commands WHERE tenant_id=${ctx.tenantId}::uuid AND actor_user_id=${ctx.userId}::uuid
      AND request_id=${requestId}::uuid`;
  return rows[0];
}
async function authority(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  connectionId: string,
  provider: Provider,
  row?: Saved,
) {
  const connection = await lockMailboxConnection(tx, ctx.tenantId, connectionId);
  await assertActiveMailboxActor(tx, ctx.tenantId, ctx.userId);
  if (connection.createdByUserId !== ctx.userId || connection.provider !== provider) throw absent();
  if (row && (row.connectionId !== connectionId || row.provider !== provider)) throw absent();
  if (row && connection.token?.homeAccountId !== row.accountId)
    throw new ConflictException(
      'Calendar account identity changed; the recorded request remains unresolved',
    );
  return connection;
}
export async function readCalendarCommand(
  prisma: PrismaService,
  ctx: TenantContext,
  connectionId: string,
  provider: Provider,
  requestId: string,
) {
  const connectionKey = uuid.safeParse(connectionId);
  if (!connectionKey.success) throw new BadRequestException('Invalid calendar account');
  connectionId = connectionKey.data;
  const parsed = uuid.safeParse(requestId);
  if (!parsed.success) throw new BadRequestException('Invalid calendar request');
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    const row = await saved(tx, ctx, parsed.data);
    if (!row) {
      await authority(tx, ctx, connectionId, provider);
      throw absent();
    }
    await authority(tx, ctx, connectionId, provider, row);
    return result(row);
  });
}
/** One finite calendar import, using the existing mailbox claim and provider/item owners. */
export async function runCalendarCommand(
  prisma: PrismaService,
  ctx: TenantContext,
  connectionId: string,
  provider: Provider,
  input: unknown,
  run: (execution: CalendarCommandRun) => Promise<void>,
) {
  const connectionKey = uuid.safeParse(connectionId);
  if (!connectionKey.success) throw new BadRequestException('Invalid calendar account');
  connectionId = connectionKey.data;
  const command = parseCalendarCommand(input, provider);
  const digest = createHash('sha256')
    .update(JSON.stringify([1, ctx.tenantId, ctx.userId, connectionId, provider, command.range]))
    .digest('hex');
  // Reads of completed commands never refresh a token or contact the provider.
  const existing = await prisma.withTenant(ctx.tenantId, async (tx) => {
    const row = await saved(tx, ctx, command.requestId);
    await authority(tx, ctx, connectionId, provider, row);
    if (row && row.payloadDigest !== digest)
      throw new ConflictException('Calendar request already has different input');
    return row;
  });
  if (existing?.status === 'completed') return result(existing);
  return withMailboxSyncClaim(prisma, ctx.tenantId, connectionId, async () => {
    const admitted = await prisma.withTenant(ctx.tenantId, async (tx) => {
      const connection = await authority(tx, ctx, connectionId, provider);
      await assertMailboxSyncCurrent(tx, ctx.tenantId, connectionId);
      let row = await saved(tx, ctx, command.requestId);
      if (row) {
        await authority(tx, ctx, connectionId, provider, row);
        if (row.payloadDigest !== digest)
          throw new ConflictException('Calendar request already has different input');
        return row;
      }
      if (!connection.token?.homeAccountId || !['connected', 'error'].includes(connection.status))
        throw new ForbiddenException('A verified connected calendar account is required');
      const state = mailboxState(connection.syncState);
      const unfinished = await tx.$queryRaw<
        Array<{ requestId: string }>
      >`SELECT request_id::text AS "requestId"
        FROM calendar_sync_commands WHERE tenant_id=${ctx.tenantId}::uuid AND connection_id=${connectionId}::uuid AND status='pending'`;
      if (unfinished.length)
        throw new ConflictException('Recover the unfinished calendar request first');
      const now = Date.now();
      const previousWindow = mailboxState(state.calendarWindow);
      const previousRange = mailboxState(previousWindow.window);
      const unfinishedWindow = Boolean(previousWindow.nextLink || previousWindow.pendingPage);
      if (
        command.range &&
        unfinishedWindow &&
        (previousRange.from !== command.range.from || previousRange.to !== command.range.to)
      ) {
        throw new ConflictException(
          'Resume the unfinished calendar window before selecting a different range',
        );
      }
      const initial = command.range
        ? unfinishedWindow
          ? previousWindow
          : {}
        : mailboxState(state.calendar);
      const frozen = command.range ?? mailboxState(initial.window);
      const window =
        typeof frozen.from === 'string' && typeof frozen.to === 'string'
          ? { from: frozen.from, to: frozen.to }
          : {
              from: new Date(now - 365 * 86400000).toISOString(),
              to: new Date(now + 365 * 86400000).toISOString(),
            };
      const progress = {
        ...initial,
        lastStats: {
          scanned: 0,
          matched: 0,
          skipped: 0,
          removed: 0,
          failed: 0,
          pages: 0,
          hasMore: true,
        },
      };
      await tx.$executeRaw`INSERT INTO calendar_sync_commands
        (tenant_id,actor_user_id,request_id,connection_id,provider,account_id,payload_digest,command_jsonb,window_jsonb,progress_jsonb,status)
        VALUES (${ctx.tenantId}::uuid,${ctx.userId}::uuid,${command.requestId}::uuid,${connectionId}::uuid,${provider},
          ${connection.token.homeAccountId},${digest},${JSON.stringify(command)}::jsonb,${JSON.stringify(window)}::jsonb,${JSON.stringify(progress)}::jsonb,'pending')`;
      row = await saved(tx, ctx, command.requestId);
      if (!row) throw uncertain();
      return row;
    });
    // Confirm durable admission before obtaining a token or performing provider work.
    const read = async () =>
      prisma.withTenant(ctx.tenantId, async (tx) => {
        const row = await saved(tx, ctx, command.requestId);
        if (!row || row.payloadDigest !== digest) throw uncertain();
        await authority(tx, ctx, connectionId, provider, row);
        return row;
      });
    const confirmed = await read();
    if (
      !isDeepStrictEqual(
        JSON.parse(JSON.stringify(confirmed)),
        JSON.parse(JSON.stringify(admitted)),
      )
    )
      throw uncertain();
    if (confirmed.status === 'completed') return result(confirmed);
    // If the final page committed before the reply was lost, finish without refetching it.
    if (mailboxState(confirmed.progress.lastStats).hasMore !== false) {
      const connection = await prisma.withTenant(ctx.tenantId, (tx) =>
        authority(tx, ctx, connectionId, provider, confirmed),
      );
      await run({
        connection,
        explicitWindow: Boolean(command.range),
        progress: structuredClone(confirmed.progress),
        window: confirmed.window,
        checkpoint: async (progress, tx, verifyOnly = false) => {
          const expected = JSON.parse(JSON.stringify(progress)) as CalendarProgress;
          const update = async (client: Prisma.TransactionClient) => {
            await authority(client, ctx, connectionId, provider, confirmed);
            await assertMailboxSyncCurrent(client, ctx.tenantId, connectionId);
            const count =
              await client.$executeRaw`UPDATE calendar_sync_commands SET progress_jsonb=${JSON.stringify(expected)}::jsonb, updated_at=clock_timestamp()
              WHERE tenant_id=${ctx.tenantId}::uuid AND actor_user_id=${ctx.userId}::uuid AND request_id=${command.requestId}::uuid AND status='pending'`;
            if (count !== 1) throw uncertain();
          };
          if (tx) return update(tx);
          if (!verifyOnly) await prisma.withTenant(ctx.tenantId, update);
          const row = await read();
          if (!isDeepStrictEqual(JSON.parse(JSON.stringify(row.progress)), expected))
            throw uncertain();
        },
      });
    }
    const progress = await read();
    if (mailboxState(progress.progress.lastStats).hasMore !== false) return result(progress);
    await prisma.withTenant(ctx.tenantId, async (tx) => {
      await authority(tx, ctx, connectionId, provider, progress);
      await assertMailboxSyncCurrent(tx, ctx.tenantId, connectionId);
      await mergeMailboxSyncState(tx, ctx.tenantId, connectionId, {
        [command.range ? 'calendarWindow' : 'calendar']: progress.progress,
      });
      await tx.$executeRaw`UPDATE calendar_sync_commands SET status='completed', updated_at=clock_timestamp()
        WHERE tenant_id=${ctx.tenantId}::uuid AND actor_user_id=${ctx.userId}::uuid AND request_id=${command.requestId}::uuid AND status='pending'`;
    });
    const completed = await read();
    if (completed.status !== 'completed') throw uncertain();
    return result(completed);
  });
}
