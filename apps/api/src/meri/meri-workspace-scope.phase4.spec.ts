import { ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriVNextLibraryService } from './meri-vnext-library.service.js';
import { MeriService } from './meri.service.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
const clientA = '11111111-1111-4111-8111-111111111111';
const clientB = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-09-09T00:00:00Z');
type Workspace = { id: string; tenantId: string; userId: string; name: string; clientId: string | null; createdAt: Date; updatedAt: Date };
type Conversation = { id: string; tenantId: string; userId: string; clientId: string | null; workspaceId: string | null; archivedAt: Date | null; title: string };
type Where = Record<string, unknown>;
const matches = (row: object, where: Where) => Object.entries(where).every(([key, value]) => (row as Where)[key] === value);

function setup() {
  const workspaces: Workspace[] = [
    { id: 'workspace-a', ...ctx, name: 'Client A work', clientId: clientA, createdAt: now, updatedAt: now },
    { id: 'workspace-all', ...ctx, name: 'All clients work', clientId: null, createdAt: now, updatedAt: now },
  ];
  const conversations: Conversation[] = [
    { id: 'chat-a', ...ctx, clientId: clientA, workspaceId: null, archivedAt: null, title: 'Client A chat' },
    { id: 'chat-b', ...ctx, clientId: clientB, workspaceId: null, archivedAt: null, title: 'Client B chat' },
    { id: 'chat-general', ...ctx, clientId: null, workspaceId: null, archivedAt: null, title: 'General chat' },
  ];
  const tx = {
    client: { findFirst: jest.fn(async ({ where }: { where: Where }) =>
      where.tenantId === ctx.tenantId && [clientA, clientB].includes(String(where.id)) ? { id: where.id } : null) },
    meriWorkspace: {
      create: jest.fn(async ({ data }: { data: Workspace }) => {
        const row = { ...data, id: 'workspace-created', createdAt: now, updatedAt: now }; workspaces.push(row); return row;
      }),
      findFirst: jest.fn(async ({ where }: { where: Where }) => workspaces.find((row) => matches(row, where)) ?? null),
      findFirstOrThrow: jest.fn(async ({ where }: { where: Where }) => {
        const row = workspaces.find((item) => matches(item, where)); if (!row) throw new Error('Missing workspace'); return row;
      }),
      findMany: jest.fn(async ({ where, include }: { where: Where; include: { _count: { select: { conversations: { where: Where } } } } }) =>
        workspaces.filter((row) => matches(row, where)).map((row) => ({ ...row, _count: {
          conversations: conversations.filter((chat) => chat.workspaceId === row.id && matches(chat, include._count.select.conversations.where)).length,
        } }))),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Partial<Workspace> }) => {
        const rows = workspaces.filter((row) => matches(row, where)); rows.forEach((row) => Object.assign(row, data)); return { count: rows.length };
      }),
      update: jest.fn(async ({ where, data }: { where: Where; data: Partial<Workspace> }) => {
        const row = workspaces.find((item) => matches(item, where)); if (!row) throw new Error('Missing workspace'); Object.assign(row, data); return row;
      }),
      delete: jest.fn(async ({ where }: { where: Where }) => { workspaces.splice(workspaces.findIndex((row) => matches(row, where)), 1); }),
    },
    clioConversation: {
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const row = conversations.find((item) => matches(item, where));
        return row ? { ...row, workspace: workspaces.find((workspace) => workspace.id === row.workspaceId) ?? null } : null;
      }),
      count: jest.fn(async ({ where }: { where: Where }) => conversations.filter((row) => matches(row, where)).length),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Partial<Conversation> }) => {
        const rows = conversations.filter((row) => matches(row, where)); rows.forEach((row) => Object.assign(row, data)); return { count: rows.length };
      }),
      update: jest.fn(async ({ where, data }: { where: Where; data: { title?: string; client?: { connect?: { id: string }; disconnect?: boolean } } }) => {
        const row = conversations.find((item) => matches(item, where)); if (!row) throw new Error('Missing chat');
        if (data.title) row.title = data.title;
        if (data.client) row.clientId = data.client.connect?.id ?? null;
        return row;
      }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    clioMessage: { updateMany: jest.fn(async () => ({ count: 1 })), deleteMany: jest.fn(async () => ({ count: 0 })) },
    clioArtifact: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const prisma = { withTenant: jest.fn(async (_tenantId: string, callback: (db: typeof tx) => unknown) => callback(tx)) };
  const library = new MeriVNextLibraryService(prisma as never);
  const meri = Object.assign(Object.create(MeriService.prototype), { prisma }) as MeriService;
  return { library, meri, tx, workspaces, conversations };
}

describe('Phase 4 canonical workspace membership and client scope', () => {
  it('creates an owned workspace and lists active owned thread counts', async () => {
    const { library, tx, conversations } = setup();
    const created = await library.createWorkspace(ctx, { name: '  New client work  ', clientId: clientA });
    expect(created).toMatchObject({ name: 'New client work', clientId: clientA, threadCount: 0 });
    expect(tx.meriWorkspace.create).toHaveBeenCalledWith({ data: { ...ctx, name: 'New client work', clientId: clientA } });
    conversations[0]!.workspaceId = 'workspace-a';
    conversations.push({ ...conversations[0]!, id: 'archived', archivedAt: now });
    conversations.push({ ...conversations[0]!, id: 'other-user', userId: 'other-user' });
    conversations.push({ ...conversations[0]!, id: 'other-tenant', tenantId: 'other-tenant' });
    const result = await library.listWorkspaces(ctx);
    expect(result.workspaces.find((row) => row.id === 'workspace-a')?.threadCount).toBe(1);
    expect(tx.meriWorkspace.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ...ctx }, include: { _count: { select: { conversations: { where: { ...ctx, archivedAt: null } } } } },
    }));
  });

  it('assigns, moves and removes an owned chat without changing its client', async () => {
    const { library, conversations } = setup();
    await expect(library.assignConversation(ctx, 'chat-a', 'workspace-a')).resolves.toEqual({ id: 'chat-a', workspaceId: 'workspace-a' });
    expect(conversations[0]).toMatchObject({ workspaceId: 'workspace-a', clientId: clientA });
    await library.assignConversation(ctx, 'chat-a', 'workspace-all');
    expect(conversations[0]).toMatchObject({ workspaceId: 'workspace-all', clientId: clientA });
    await library.assignConversation(ctx, 'chat-a', null);
    expect(conversations[0]).toMatchObject({ workspaceId: null, clientId: clientA });
  });

  it.each(['chat-b', 'chat-general'])('rejects incompatible bound-client assignment for %s', async (chatId) => {
    const { library, tx } = setup();
    await expect(library.assignConversation(ctx, chatId, 'workspace-a')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.clioConversation.updateMany).not.toHaveBeenCalled();
  });

  it('allows different client and general chats in an All clients workspace', async () => {
    const { library, conversations } = setup();
    for (const chat of conversations) await library.assignConversation(ctx, chat.id, 'workspace-all');
    expect(conversations.map((chat) => chat.workspaceId)).toEqual(['workspace-all', 'workspace-all', 'workspace-all']);
    expect(conversations.map((chat) => chat.clientId)).toEqual([clientA, clientB, null]);
  });

  it.each([{ ...ctx, userId: 'another-user' }, { ...ctx, tenantId: 'another-tenant' }])('rejects foreign workspace ownership for assignment/update/delete', async (foreign) => {
    const { library, tx } = setup();
    await expect(library.assignConversation(foreign, 'chat-a', 'workspace-a')).rejects.toBeInstanceOf(NotFoundException);
    await expect(library.updateWorkspace(foreign, 'workspace-a', { name: 'Renamed' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(library.deleteWorkspace(foreign, 'workspace-a')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.clioConversation.updateMany).not.toHaveBeenCalled();
    expect(tx.meriWorkspace.delete).not.toHaveBeenCalled();
  });

  it.each(['missing', 'foreign-user', 'foreign-tenant', 'archived'])('rejects %s conversation assignment/removal', async (condition) => {
    const { library, conversations, tx } = setup();
    const chat = conversations[0]!;
    if (condition === 'foreign-user') chat.userId = 'other-user';
    if (condition === 'foreign-tenant') chat.tenantId = 'other-tenant';
    if (condition === 'archived') chat.archivedAt = now;
    const id = condition === 'missing' ? 'missing-chat' : chat.id;
    await expect(library.assignConversation(ctx, id, 'workspace-a')).rejects.toBeInstanceOf(NotFoundException);
    await expect(library.assignConversation(ctx, id, null)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.clioConversation.updateMany).not.toHaveBeenCalled();
  });

  it('rejects unknown workspace and unavailable client records', async () => {
    const { library, tx } = setup();
    await expect(library.assignConversation(ctx, 'chat-a', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(library.createWorkspace(ctx, { name: 'Missing client', clientId: '33333333-3333-4333-8333-333333333333' })).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.meriWorkspace.create).not.toHaveBeenCalled();
  });

  it.each([null, now])('requires removing every member before workspace client change, archivedAt=%s', async (archivedAt) => {
    const { library, tx, conversations } = setup();
    Object.assign(conversations[0]!, { workspaceId: 'workspace-a', archivedAt });
    await expect(library.updateWorkspace(ctx, 'workspace-a', { clientId: clientB })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.clioConversation.count).toHaveBeenCalledWith({ where: { ...ctx, workspaceId: 'workspace-a' } });
    expect(tx.meriWorkspace.update).not.toHaveBeenCalled();
  });

  it('allows renaming a populated workspace and changing an empty workspace client', async () => {
    const { library, conversations } = setup(); conversations[0]!.workspaceId = 'workspace-a';
    await expect(library.updateWorkspace(ctx, 'workspace-a', { name: 'Renamed' })).resolves.toMatchObject({ name: 'Renamed', clientId: clientA });
    await expect(library.updateWorkspace(ctx, 'workspace-all', { clientId: clientB })).resolves.toMatchObject({ clientId: clientB });
  });

  it('deletes the workspace and clears active/archived membership while preserving chats and messages', async () => {
    const { library, tx, conversations, workspaces } = setup();
    Object.assign(conversations[0]!, { workspaceId: 'workspace-a' });
    conversations.push({ ...conversations[0]!, id: 'archived', archivedAt: now });
    await expect(library.deleteWorkspace(ctx, 'workspace-a')).resolves.toEqual({ ok: true, id: 'workspace-a' });
    expect(workspaces.some((row) => row.id === 'workspace-a')).toBe(false);
    expect(conversations).toHaveLength(4);
    expect(conversations.filter((row) => row.workspaceId === 'workspace-a')).toHaveLength(0);
    expect(tx.clioConversation.updateMany).toHaveBeenCalledWith({ where: { ...ctx, workspaceId: 'workspace-a' }, data: { workspaceId: null } });
    expect(tx.meriWorkspace.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.clioConversation.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.clioConversation.deleteMany).not.toHaveBeenCalled();
    expect(tx.clioMessage.deleteMany).not.toHaveBeenCalled();
  });

  it('does not unlink chats if workspace ownership disappears before the delete lock', async () => {
    const { library, tx } = setup(); tx.meriWorkspace.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(library.deleteWorkspace(ctx, 'workspace-a')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.clioConversation.updateMany).not.toHaveBeenCalled();
    expect(tx.meriWorkspace.delete).not.toHaveBeenCalled();
  });

  it('rejects assignment if the selected conversation changed after it was read', async () => {
    const { library, tx } = setup(); tx.clioConversation.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(library.assignConversation(ctx, 'chat-a', 'workspace-a')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.clioConversation.updateMany).toHaveBeenCalledWith({ where: {
      ...ctx, id: 'chat-a', archivedAt: null, clientId: clientA,
    }, data: { workspaceId: 'workspace-a' } });
  });

  it.each([clientB, null])('guards conversation client changes to %s while bound to a client workspace', async (clientId) => {
    const { meri, conversations, tx } = setup(); conversations[0]!.workspaceId = 'workspace-a';
    await expect(meri.updateConversation(ctx, 'chat-a', { clientId })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.clioConversation.update).not.toHaveBeenCalled();
    expect(tx.clioMessage.updateMany).not.toHaveBeenCalled();
    expect(tx.clioArtifact.updateMany).not.toHaveBeenCalled();
  });

  it.each([null, 'workspace-all'])('allows client changes when membership is %s', async (workspaceId) => {
    const { meri, conversations, tx } = setup(); conversations[0]!.workspaceId = workspaceId;
    await expect(meri.updateConversation(ctx, 'chat-a', { clientId: clientB })).resolves.toMatchObject({ clientId: clientB });
    expect(tx.clioMessage.updateMany).toHaveBeenCalledWith({ where: { ...ctx, conversationId: 'chat-a' }, data: { clientId: clientB } });
  });

  it('permits a title change and unchanged client within a bound workspace', async () => {
    const { meri, conversations } = setup(); conversations[0]!.workspaceId = 'workspace-a';
    await expect(meri.updateConversation(ctx, 'chat-a', { title: 'New title', clientId: clientA })).resolves.toMatchObject({ title: 'New title', clientId: clientA });
  });

  it('fails closed when conversation ownership disappears before the client update lock', async () => {
    const { meri, tx } = setup(); tx.clioConversation.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(meri.updateConversation(ctx, 'chat-a', { clientId: clientB })).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.clioConversation.update).not.toHaveBeenCalled();
  });
});
