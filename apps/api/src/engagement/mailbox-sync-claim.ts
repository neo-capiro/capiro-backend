import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { assertActiveMailboxActor, lockMailboxConnection } from './mailbox-oauth-authority.js';
import {
  assertMailboxBudget,
  MAILBOX_RUN_TIMEOUT_MS,
  withMailboxProviderBudget,
} from './mailbox-provider-transport.js';

export const MAILBOX_CLAIM_MS = MAILBOX_RUN_TIMEOUT_MS + 60_000;
type Claim = { tenantId: string; connectionId: string; token: string };
const claims = new AsyncLocalStorage<Claim>();
export const mailboxState = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export class MailboxClaimLostError extends ConflictException {
  constructor() {
    super('Mailbox work was superseded; reload the connection.');
  }
}
export class MailboxBusyError extends ConflictException {
  constructor() {
    super('This mailbox is already syncing. Try again shortly.');
  }
}

/** Call inside each existing write transaction; the row lock spans its complete persistence. */
export async function assertMailboxSyncCurrent(
  tx: Prisma.TransactionClient,
  tenantId: string,
  connectionId: string,
): Promise<void> {
  const claim = claims.getStore();
  if (!claim) return; // Shared token owner also serves OAuth/send, which retain their own fences.
  assertMailboxBudget();
  if (claim.tenantId !== tenantId || claim.connectionId !== connectionId)
    throw new MailboxClaimLostError();
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM engagement_connections
    WHERE id = ${connectionId}::uuid AND tenant_id = ${tenantId}::uuid
      AND status IN ('connected', 'error')
      AND sync_state_jsonb->'syncClaim'->>'token' = ${claim.token}
      AND (sync_state_jsonb->'syncClaim'->>'expiresAt')::timestamptz > clock_timestamp()
    FOR UPDATE`;
  if (rows.length !== 1) throw new MailboxClaimLostError();
  assertMailboxBudget();
}

/** Merge only the fields this operation owns; OAuth/webhooks/other resource state survives. */
export async function mergeMailboxSyncState(
  tx: Prisma.TransactionClient,
  tenantId: string,
  connectionId: string,
  patch: Record<string, unknown>,
  data: Prisma.IntegrationConnectionUpdateInput = {},
) {
  await assertMailboxSyncCurrent(tx, tenantId, connectionId);
  const current = await lockMailboxConnection(tx, tenantId, connectionId);
  return tx.integrationConnection.update({
    where: { id: connectionId },
    data: {
      ...data,
      syncState: { ...mailboxState(current.syncState), ...patch } as Prisma.InputJsonValue,
    },
  });
}

/** No network call or long transaction owns a DB connection for this lease's lifetime. */
export async function withMailboxSyncClaim<T>(
  prisma: PrismaService,
  tenantId: string,
  connectionId: string,
  operation: () => Promise<T>,
  options: { requireDue?: boolean; successIntervalMinutes?: number } = {},
): Promise<T> {
  const nested = claims.getStore();
  if (nested) {
    if (nested.tenantId !== tenantId || nested.connectionId !== connectionId)
      throw new MailboxClaimLostError();
    assertMailboxBudget();
    return operation();
  }
  const claim = { tenantId, connectionId, token: randomUUID() };
  await prisma.withTenant(tenantId, async (tx) => {
    const connection = await lockMailboxConnection(tx, tenantId, connectionId);
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const now = clock[0]?.now;
    if (!now) throw new MailboxClaimLostError();
    if (
      options.requireDue &&
      connection.nextSyncAt &&
      connection.nextSyncAt.getTime() > now.getTime()
    )
      throw new MailboxClaimLostError();
    const state = mailboxState(connection.syncState);
    if (
      !['connected', 'error'].includes(connection.status) ||
      !connection.createdByUserId ||
      Number(mailboxState(state.oauthAttempt).expiresAt) * 1000 > now.getTime()
    )
      throw new MailboxClaimLostError();
    if (Date.parse(String(mailboxState(state.syncClaim).expiresAt)) > now.getTime())
      throw new MailboxBusyError();
    await assertActiveMailboxActor(tx, tenantId, connection.createdByUserId);
    const expiresAt = new Date(now.getTime() + MAILBOX_CLAIM_MS);
    await tx.integrationConnection.update({
      where: { id: connectionId },
      data: {
        syncState: {
          ...state,
          syncClaim: { token: claim.token, expiresAt: expiresAt.toISOString() },
        } as Prisma.InputJsonValue,
        nextSyncAt: expiresAt,
      },
    });
  });
  let failed = false;
  try {
    return await claims.run(claim, () => withMailboxProviderBudget(operation));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A timed-out continuation keeps its aborted async context. It cannot write after
    // this release, even if an SDK/mock ignores cancellation and eventually resolves.
    await prisma.withTenant(tenantId, async (tx) => {
      let connection;
      try {
        connection = await lockMailboxConnection(tx, tenantId, connectionId);
      } catch (error) {
        if (error instanceof NotFoundException) return;
        throw error;
      }
      const state = mailboxState(connection.syncState);
      if (mailboxState(state.syncClaim).token !== claim.token) return;
      delete state.syncClaim;
      const syncable = ['connected', 'error'].includes(connection.status);
      const intervalMinutes =
        !failed &&
        connection.status === 'connected' &&
        mailboxState(state.webhooks).recoveryPending !== true
          ? (options.successIntervalMinutes ?? 15)
          : 15;
      await tx.integrationConnection.update({
        where: { id: connectionId },
        data: {
          syncState: state as Prisma.InputJsonValue,
          ...(syncable
            ? {
                nextSyncAt: new Date(Date.now() + (intervalMinutes + Math.random() * 5) * 60_000),
                ...(failed
                  ? {
                      status: 'error',
                      lastError:
                        connection.lastError ?? 'Mailbox sync could not complete. Retry later.',
                    }
                  : {}),
              }
            : {}),
        },
      });
    });
  }
}
