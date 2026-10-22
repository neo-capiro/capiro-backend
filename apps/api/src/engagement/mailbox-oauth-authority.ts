// ML-08/ML-10: Neo approved this bounded OAuth/token repair on 2026-10-21.
// Keep identity, one-use OAuth attempts and token refresh fencing in the existing
// connection domain. No mailbox content or token secret is placed in OAuth state.
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { IntegrationConnection, IntegrationConnectionToken, Prisma } from '@prisma/client';

export interface MailboxOAuthState {
  c: string;
  t: string;
  u: string;
  p: string;
  i: 'add' | 'reconnect';
  h: string | null;
  q: string | null;
  a: string | null;
  n: string;
  e: number;
}

type TokenSnapshot = Pick<
  IntegrationConnectionToken,
  'id' | 'homeAccountId' | 'accessTokenCiphertext' | 'refreshTokenCiphertext'
>;

export function tokenFingerprint(token: TokenSnapshot | null | undefined): string | null {
  if (!token) return null;
  return createHash('sha256')
    .update(
      JSON.stringify([
        token.id,
        token.homeAccountId,
        token.accessTokenCiphertext,
        token.refreshTokenCiphertext,
      ]),
    )
    .digest('hex');
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

export function assertMailboxOAuthState(
  value: unknown,
  provider: string,
): asserts value is MailboxOAuthState {
  const s = object(value);
  if (
    !['c', 't', 'u', 'n'].every((key) => typeof s[key] === 'string' && s[key]) ||
    s.p !== provider ||
    (s.i !== 'add' && s.i !== 'reconnect') ||
    typeof s.e !== 'number' ||
    !Number.isFinite(s.e) ||
    s.e <= Math.floor(Date.now() / 1000) ||
    !['h', 'q', 'a'].every((key) => s[key] === null || typeof s[key] === 'string') ||
    (s.i === 'reconnect' && (!s.h || !s.q))
  ) {
    throw new BadRequestException('OAuth attempt is invalid or expired; restart the flow');
  }
}

export async function lockMailboxConnection(
  tx: Prisma.TransactionClient,
  tenantId: string,
  connectionId: string,
) {
  await tx.$queryRaw`SELECT id FROM engagement_connections
    WHERE id = ${connectionId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
  const connection = await tx.integrationConnection.findFirst({
    where: { id: connectionId, tenantId },
    include: { token: true },
  });
  if (!connection) throw new NotFoundException('Integration connection not found');
  return connection;
}

export async function assertActiveMailboxActor(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
) {
  const memberships = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM tenant_memberships
    WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid AND status = 'active' FOR SHARE`;
  if (memberships.length !== 1)
    throw new ForbiddenException('Current active membership is required');
}

/** A missing token must never turn an established mailbox into a new identity. */
export async function assertUnboundMailboxIsFresh(
  tx: Prisma.TransactionClient,
  connection: IntegrationConnection,
) {
  const sync = object(connection.syncState);
  const hasCursor = ['mail', 'calendar'].some((kind) =>
    ['cursor', 'historyId', 'syncToken', 'deltaLink', 'nextLink', 'updatedAt'].some((key) =>
      Boolean(object(sync[kind])[key]),
    ),
  );
  if (
    connection.status !== 'needs_configuration' ||
    connection.lastSyncAt ||
    hasCursor ||
    object(sync.webhooks).configured
  ) {
    throw new BadRequestException(
      'Mailbox history has no verified account identity; disconnect and add another mailbox',
    );
  }
  const where = { tenantId: connection.tenantId, connectionId: connection.id };
  const history = await Promise.all([
    tx.meeting.count({ where }),
    tx.mailThread.count({ where }),
    tx.mailMessage.count({ where }),
  ]);
  if (history.some((count) => count > 0)) {
    throw new BadRequestException(
      'Mailbox history has no verified account identity; disconnect and add another mailbox',
    );
  }
}

/** Reuse only an actor's fresh Add placeholder, never an established mailbox. */
export async function findFreshMailboxForAdd(
  tx: Prisma.TransactionClient,
  tenantId: string,
  actorId: string,
  provider: IntegrationConnection['provider'],
) {
  // A row lock alone cannot serialize two starts when no placeholder exists.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mailbox-add:${tenantId}:${actorId}:${provider}`}, 0))`;
  const candidates = await tx.integrationConnection.findMany({
    where: {
      tenantId,
      createdByUserId: actorId,
      provider,
      status: 'needs_configuration',
      token: { is: null },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  for (const candidate of candidates) {
    let connection: Awaited<ReturnType<typeof lockMailboxConnection>>;
    try {
      connection = await lockMailboxConnection(tx, tenantId, candidate.id);
    } catch (error) {
      if (error instanceof NotFoundException) continue;
      throw error;
    }
    if (
      connection.token ||
      connection.createdByUserId !== actorId ||
      connection.provider !== provider
    )
      continue;
    try {
      await assertUnboundMailboxIsFresh(tx, connection);
    } catch (error) {
      if (error instanceof BadRequestException) continue;
      throw error;
    }
    return connection;
  }
  return null;
}

export async function saveMailboxOAuthAttempt(
  tx: Prisma.TransactionClient,
  state: MailboxOAuthState,
  syncState: unknown,
) {
  await tx.integrationConnection.update({
    where: { id: state.c },
    data: {
      syncState: {
        ...object(syncState),
        oauthAttempt: { nonceHash: nonceHash(state.n), phase: 'pending', expiresAt: state.e },
      } as Prisma.InputJsonValue,
    },
  });
}

/** Lock, check current authority and consume the start nonce before exchanging code. */
export async function admitMailboxOAuthAttempt(
  tx: Prisma.TransactionClient,
  state: MailboxOAuthState,
  provider: string,
  phase: 'pending' | 'exchanging',
) {
  assertMailboxOAuthState(state, provider);
  const connection = await lockMailboxConnection(tx, state.t, state.c);
  if (connection.provider !== provider || connection.createdByUserId !== state.u) {
    throw new ForbiddenException('Integration connection is not available');
  }
  await assertActiveMailboxActor(tx, state.t, state.u);
  const attempt = object(object(connection.syncState).oauthAttempt);
  if (
    attempt.nonceHash !== nonceHash(state.n) ||
    attempt.phase !== phase ||
    attempt.expiresAt !== state.e ||
    tokenFingerprint(connection.token) !== state.q ||
    (connection.token?.homeAccountId ?? null) !== state.h
  ) {
    throw new BadRequestException('OAuth attempt was replaced or consumed; restart the flow');
  }
  if (phase === 'pending') {
    await tx.integrationConnection.update({
      where: { id: state.c },
      data: {
        syncState: {
          ...object(connection.syncState),
          oauthAttempt: { ...attempt, phase: 'exchanging' },
        } as Prisma.InputJsonValue,
      },
    });
  }
  return connection;
}

export async function assertReturnedMailboxIdentity(
  tx: Prisma.TransactionClient,
  state: MailboxOAuthState,
  accountId: string | null,
  email: string | null,
) {
  if (
    !accountId ||
    !email ||
    (state.i === 'reconnect' && state.h !== accountId) ||
    (state.i === 'add' && state.a && state.a !== email.toLowerCase())
  ) {
    throw new BadRequestException(
      'Selected account does not match this connection; add another mailbox',
    );
  }
  // Serialize duplicate-subject callbacks across different pending connections.
  // The existing email uniqueness is not a stable provider-identity guarantee.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${state.t}:${state.p}:${accountId}`}, 0))`;
  const duplicate = await tx.integrationConnection.findFirst({
    where: {
      tenantId: state.t,
      provider: state.p as never,
      id: { not: state.c },
      OR: [{ accountEmail: email }, { token: { is: { homeAccountId: accountId } } }],
    },
    select: { id: true },
  });
  if (duplicate)
    throw new BadRequestException(
      'This mailbox is already connected; reconnect its existing connection',
    );
}

export function completedMailboxOAuthState(syncState: unknown): Prisma.InputJsonValue {
  const { oauthAttempt: _attempt, ...rest } = object(syncState);
  return rest as Prisma.InputJsonValue;
}

/** Reject a response from before a disconnect, reconnect or winning refresh. */
export async function admitMailboxRefresh(
  tx: Prisma.TransactionClient,
  tenantId: string,
  connectionId: string,
  provider: string,
  snapshot: TokenSnapshot,
) {
  const connection = await lockMailboxConnection(tx, tenantId, connectionId);
  if (
    connection.provider !== provider ||
    !connection.createdByUserId ||
    !['connected', 'error'].includes(connection.status) ||
    tokenFingerprint(connection.token) !== tokenFingerprint(snapshot) ||
    Number(object(object(connection.syncState).oauthAttempt).expiresAt) >
      Math.floor(Date.now() / 1000)
  ) {
    throw new BadRequestException('Mailbox credentials changed; reload the connection');
  }
  await assertActiveMailboxActor(tx, tenantId, connection.createdByUserId);
  return connection;
}
