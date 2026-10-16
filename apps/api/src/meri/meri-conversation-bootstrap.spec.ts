import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { randomUUID } from 'node:crypto';
import { MeriService } from './meri.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const OTHER_ACTOR = '44444444-4444-4444-8444-444444444444';
const CLIENT = '55555555-5555-4555-8555-555555555555';
const OTHER_CLIENT = '66666666-6666-4666-8666-666666666666';
const FOREIGN_CLIENT = '77777777-7777-4777-8777-777777777777';

const context = (tenantId = TENANT, userId = ACTOR) =>
  ({ tenantId, userId } as TenantContext);

interface ClientRow {
  id: string;
  tenantId: string;
  status: string;
}

interface ConversationRow {
  id: string;
  tenantId: string;
  userId: string;
  clientId: string;
  status: string;
  archivedAt: Date | null;
  title: string;
  metadata: Record<string, unknown>;
}

interface ReceiptRow {
  tenantId: string;
  actorUserId: string;
  requestId: string;
  clientId: string;
  conversationId: string | null;
}

interface Store {
  clients: ClientRow[];
  conversations: ConversationRow[];
  receipts: ReceiptRow[];
}

/** Each withTenant call has its own commit/rollback boundary, like Prisma's transaction. */
function harness(options: { raceOnFirstReceipt?: boolean } = {}) {
  const store: Store = {
    clients: [
      { id: CLIENT, tenantId: TENANT, status: 'active' },
      { id: OTHER_CLIENT, tenantId: TENANT, status: 'active' },
      { id: FOREIGN_CLIENT, tenantId: OTHER_TENANT, status: 'active' },
    ],
    conversations: [],
    receipts: [],
  };
  let transactionCount = 0;
  let raceWinnerId: string | null = null;
  let raceInjected = false;
  const prisma = {
    withTenant: async <T>(tenantId: string, run: (tx: unknown) => Promise<T>): Promise<T> => {
      transactionCount += 1;
      const snapshot = structuredClone(store);
      const tx = {
        user: {
          findUnique: async () => ({ email: 'actor@example.test', firstName: null, lastName: null }),
        },
        client: {
          findFirst: async ({ where }: { where: { id: string; tenantId: string; status?: { not: string } } }) => {
            const row = snapshot.clients.find(
              (client) =>
                client.id === where.id &&
                client.tenantId === tenantId &&
                client.tenantId === where.tenantId &&
                client.status !== where.status?.not,
            );
            return row ? { id: row.id } : null;
          },
        },
        clioConversation: {
          findFirst: async ({ where }: { where: Partial<ConversationRow> }) => {
            const row = snapshot.conversations.find(
              (conversation) =>
                conversation.tenantId === tenantId &&
                Object.entries(where).every(([key, value]) =>
                  Object.is(conversation[key as keyof ConversationRow], value),
                ),
            );
            return row ? { id: row.id } : null;
          },
          create: async ({ data }: { data: Omit<ConversationRow, 'id' | 'status' | 'archivedAt'> }) => {
            const row: ConversationRow = {
              ...data,
              id: randomUUID(),
              status: 'active',
              archivedAt: null,
            };
            snapshot.conversations.push(row);
            return { id: row.id };
          },
        },
        clioConversationBootstrapReceipt: {
          findFirst: async ({ where }: { where: Pick<ReceiptRow, 'tenantId' | 'actorUserId' | 'requestId'> }) => {
            const row = snapshot.receipts.find(
              (receipt) =>
                receipt.tenantId === tenantId &&
                receipt.tenantId === where.tenantId &&
                receipt.actorUserId === where.actorUserId &&
                receipt.requestId === where.requestId,
            );
            return row ? { clientId: row.clientId, conversationId: row.conversationId } : null;
          },
          create: async ({ data }: { data: ReceiptRow }) => {
            if (options.raceOnFirstReceipt && !raceInjected) {
              raceInjected = true;
              raceWinnerId = randomUUID();
              // Another transaction wins after our initial read and before our
              // receipt insert. Its row commits; this transaction must roll back.
              store.conversations.push({
                id: raceWinnerId,
                tenantId: data.tenantId,
                userId: data.actorUserId,
                clientId: data.clientId,
                status: 'active',
                archivedAt: null,
                title: 'New Meri session',
                metadata: {},
              });
              store.receipts.push({ ...data, conversationId: raceWinnerId });
            }
            if (
              store.receipts.some(
                (row) =>
                  row.tenantId === data.tenantId &&
                  row.actorUserId === data.actorUserId &&
                  row.requestId === data.requestId,
              ) ||
              snapshot.receipts.some(
                (row) =>
                  row.tenantId === data.tenantId &&
                  row.actorUserId === data.actorUserId &&
                  row.requestId === data.requestId,
              )
            ) {
              throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
                code: 'P2002',
                clientVersion: 'test',
              });
            }
            snapshot.receipts.push(data);
            return data;
          },
        },
      };
      const result = await run(tx);
      store.clients = snapshot.clients;
      store.conversations = snapshot.conversations;
      store.receipts = snapshot.receipts;
      return result;
    },
  };
  // No other MeriService collaborators are used by this narrow operation.
  const service = Object.assign(Object.create(MeriService.prototype), { prisma }) as MeriService;
  return { service, store, transactionCount: () => transactionCount, raceWinnerId: () => raceWinnerId };
}

const input = (requestId = randomUUID(), clientId = CLIENT) => ({
  schemaVersion: 1 as const,
  requestId,
  clientId,
});

describe('MeriService.bootstrapConversation', () => {
  test('creates one owned client conversation and returns the identical receipt on exact replay', async () => {
    const h = harness();
    const request = input();
    const first = await h.service.bootstrapConversation(context(), request);
    const conversation = h.store.conversations[0];
    if (!conversation) throw new Error('bootstrap did not create a conversation');
    conversation.title = 'Renamed later';
    const replay = await h.service.bootstrapConversation(context(), request);

    expect(replay).toEqual(first);
    expect(first).toEqual({
      schemaVersion: 1,
      requestId: request.requestId,
      conversationId: conversation.id,
      tenantId: TENANT,
      actorId: ACTOR,
      clientId: CLIENT,
    });
    expect(h.store.conversations).toHaveLength(1);
    expect(h.store.receipts).toHaveLength(1);
    expect(h.store.conversations[0]).toMatchObject({
      tenantId: TENANT,
      userId: ACTOR,
      clientId: CLIENT,
      metadata: { brand: 'Meri', runtime: 'Hermes', userEmail: 'actor@example.test' },
    });
  });

  test('same actor and requestId cannot switch clients', async () => {
    const h = harness();
    const request = input();
    await h.service.bootstrapConversation(context(), request);
    await expect(
      h.service.bootstrapConversation(context(), { ...request, clientId: OTHER_CLIENT }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.store.conversations).toHaveLength(1);
    expect(h.store.receipts).toHaveLength(1);
  });

  test('a uniqueness race rolls back the losing conversation and reads the winner in a new transaction', async () => {
    const h = harness({ raceOnFirstReceipt: true });
    const request = input();
    const receipt = await h.service.bootstrapConversation(context(), request);

    expect(receipt.conversationId).toBe(h.raceWinnerId());
    expect(h.store.conversations.map((row) => row.id)).toEqual([h.raceWinnerId()]);
    expect(h.store.receipts).toHaveLength(1);
    // Initial read, profile, failed insert, then a fresh winner read.
    expect(h.transactionCount()).toBe(4);
  });

  test('the same requestId is independent across actors and tenants', async () => {
    const h = harness();
    const requestId = randomUUID();
    const first = await h.service.bootstrapConversation(context(), input(requestId));
    const otherActor = await h.service.bootstrapConversation(
      context(TENANT, OTHER_ACTOR),
      input(requestId),
    );
    const otherTenant = await h.service.bootstrapConversation(
      context(OTHER_TENANT, ACTOR),
      input(requestId, FOREIGN_CLIENT),
    );

    expect(new Set([first.conversationId, otherActor.conversationId, otherTenant.conversationId]).size).toBe(3);
    expect(h.store.receipts).toHaveLength(3);
    expect(await h.service.bootstrapConversation(context(), input(requestId))).toEqual(first);
    expect(await h.service.bootstrapConversation(context(TENANT, OTHER_ACTOR), input(requestId))).toEqual(otherActor);
    expect(await h.service.bootstrapConversation(context(OTHER_TENANT, ACTOR), input(requestId, FOREIGN_CLIENT))).toEqual(otherTenant);
  });

  test.each([
    ['archived', (row: ConversationRow) => { row.archivedAt = new Date(); row.status = 'archived'; }],
    ['moved to another client', (row: ConversationRow) => { row.clientId = OTHER_CLIENT; }],
    ['inactive', (row: ConversationRow) => { row.status = 'paused'; }],
  ])('rejects replay after the conversation is %s', async (_label, change) => {
    const h = harness();
    const request = input();
    await h.service.bootstrapConversation(context(), request);
    const conversation = h.store.conversations[0];
    if (!conversation) throw new Error('bootstrap did not create a conversation');
    change(conversation);
    await expect(h.service.bootstrapConversation(context(), request)).rejects.toBeInstanceOf(ConflictException);
    expect(h.store.conversations).toHaveLength(1);
    expect(h.store.receipts).toHaveLength(1);
  });

  test('rejects replay when the conversation was deleted or its receipt was tombstoned', async () => {
    for (const tombstone of [false, true]) {
      const h = harness();
      const request = input();
      await h.service.bootstrapConversation(context(), request);
      if (tombstone) {
        const receipt = h.store.receipts[0];
        if (!receipt) throw new Error('bootstrap did not create a receipt');
        receipt.conversationId = null;
      } else {
        h.store.conversations.length = 0;
      }
      await expect(h.service.bootstrapConversation(context(), request)).rejects.toBeInstanceOf(ConflictException);
      expect(h.store.receipts).toHaveLength(1);
      expect(h.store.conversations).toHaveLength(tombstone ? 1 : 0);
    }
  });

  test('rechecks current client visibility on replay and refuses a new request for an archived client', async () => {
    const h = harness();
    const request = input();
    await h.service.bootstrapConversation(context(), request);
    h.store.clients.find((client) => client.id === CLIENT)!.status = 'archived';
    await expect(h.service.bootstrapConversation(context(), request)).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.bootstrapConversation(context(), input())).rejects.toBeInstanceOf(NotFoundException);
    expect(h.store.conversations).toHaveLength(1);
    expect(h.store.receipts).toHaveLength(1);
  });
});
