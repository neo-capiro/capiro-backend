import { NotFoundException } from '@nestjs/common';
import { Packer } from 'docx';
import {
  withProspectDraft,
  assertProspectDraft,
  requireProspectInvitee,
} from './prospect-draft-access.js';
import { createProspectDraft } from './prospect-draft-create.js';
import { prospectNotificationVisible } from './prospect-notification-access.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { CommentsService } from '../comments/comments.service.js';
import { DraftsService } from '../drafts/drafts.service.js';
import { VersionsService } from '../versions/versions.service.js';
import { ContextService } from '../context/context.service.js';
import { ExportService } from '../export/export.service.js';
import { EditLockService } from '../edit-lock/edit-lock.service.js';
import { ChecksService } from '../checks/checks.service.js';
import { ShareLinkService } from '../delivery/share-link.service.js';
import { MemoryPromotionService } from '../generation/memory-promotion.service.js';
import { GenerationService } from '../generation/generation.service.js';
import { canRead, canEdit } from '../collaborators/role-policy.js';
const tenantId = '11111111-1111-4111-8111-111111111111',
  prospectId = '33333333-3333-4333-8333-333333333333',
  draftId = '44444444-4444-4444-8444-444444444444';
const actor = 'user_owner';
function fixture() {
  const draft: any = {
    id: draftId,
    tenantId,
    prospectId,
    ownerId: actor,
    docTitle: 'Private prospect plan',
    config: { sections: [], sectionContent: {} },
    ask: 'n/a',
    documents: [],
    updatedAt: new Date(),
    product: null,
    client: 'This free text is not authority',
    isPacket: false,
  };
  const state = {
    exists: true,
    member: true,
    flag: true,
    wall: false,
    grant: false,
    linkedClientId: null as string | null,
    role: null as string | null,
    inviteStatus: 'pending',
    sourceRows: [] as any[],
  };
  const receipts: any[] = [];
  const writes: string[] = [];
  const matchDraft = (where: any) =>
    state.exists &&
    (where.prospectId === undefined || where.prospectId === draft.prospectId) &&
    (!where.tenantId || where.tenantId === tenantId) &&
    (!where.id || where.id === draftId);
  const tx: any = {
    $executeRaw: jest.fn(async () => 1),
    $queryRawUnsafe: jest.fn(
      async (sql: string, _tenant: string, userId: string | null, clerk: string) => {
        if (sql.includes('FROM business_development_prospects'))
          return [{ status: 'active', dismissedAt: null, linkedClientId: state.linkedClientId }];
        if (sql.includes('FROM tenants'))
          return [
            { settings: { clioFeatureFlags: { 'businessDevelopment.enabled': state.flag } } },
          ];
        if (sql.includes('FROM tenant_memberships'))
          return state.member && clerk !== 'user_foreign'
            ? [{ userId: '22222222-2222-4222-8222-222222222222', clerkUserId: clerk }]
            : [];
        if (sql.includes('set_config')) return [];
        if (sql.includes('SELECT status,memory_wall'))
          return [{ status: 'active', memoryWall: state.wall }];
        if (sql.includes('SELECT id FROM client_memory_access'))
          return state.grant ? [{ id: 'grant' }] : [];
        if (sql.includes('AS allowed')) return [{ allowed: !state.wall || state.grant }];
        throw Error(sql);
      },
    ),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM ws_source_action')) return state.sourceRows;
      if (sql.includes('FROM ws_draft'))
        return state.exists
          ? [{ id: draftId, ownerId: draft.ownerId, prospectId: draft.prospectId }]
          : [];
      if (sql.includes('SELECT role::text')) return state.role ? [{ role: state.role }] : [];
      if (sql.includes('FROM ws_collaborator'))
        return values.includes('user_foreign') ? [] : [{ id: 'invite' }];
      throw Error(sql);
    }),
    wsDraft: {
      findFirst: jest.fn(async ({ where }: any) => (matchDraft(where) ? draft : null)),
      findFirstOrThrow: jest.fn(async () => draft),
      findMany: jest.fn(async () => [draft]),
      create: jest.fn(async ({ data }: any) => {
        writes.push('draft.create');
        Object.assign(draft, data);
        return draft;
      }),
      update: jest.fn(async ({ data }: any) => {
        writes.push('draft.update');
        Object.assign(draft, data);
        return draft;
      }),
      delete: jest.fn(async () => {
        writes.push('draft.delete');
        state.exists = false;
        return draft;
      }),
    },
    wsCollaborator: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.subjectId === 'user_foreign'
          ? null
          : state.role || where.id
            ? {
                id: 'invite',
                tenantId,
                draftId,
                subjectId: 'user_editor',
                role: state.role ?? 'editor',
                status: state.inviteStatus,
              }
            : null,
      ),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({ ...data, id: 'invite' })),
      update: jest.fn(async ({ data }: any) => {
        writes.push('collaborator.update');
        state.inviteStatus = data.status ?? state.inviteStatus;
        return { ...data, id: 'invite' };
      }),
      delete: jest.fn(async () => ({})),
    },
    wsProspectDraftReceipt: {
      findFirst: jest.fn(async () => receipts[0] ?? null),
      create: jest.fn(async ({ data }: any) => {
        receipts.push(data);
        return data;
      }),
    },
    wsDocument: {
      findMany: jest.fn(async () => [{ id: 'doc', body: { blocks: [{ content: 'protected' }] } }]),
      findFirst: jest.fn(async () => ({ id: 'doc', tenantId, draftId, draft })),
      create: jest.fn(async ({ data }: any) => ({ ...data, id: 'doc' })),
      count: jest.fn(async () => 1),
      update: jest.fn(async () => {
        writes.push('document.update');
        return {};
      }),
    },
    wsComment: {
      findMany: jest.fn(async () => [{ body: 'protected' }]),
      create: jest.fn(async () => {
        writes.push('comment.create');
        return {};
      }),
    },
    wsContextItem: { findMany: jest.fn(async () => [{ payload: { text: 'protected' } }]) },
    wsDocVersion: {
      findMany: jest.fn(async () => [{ id: 'version', snapshot: { docTitle: 'historical' } }]),
      create: jest.fn(async ({ data }: any) => {
        writes.push('version.create');
        return { ...data, id: 'version' };
      }),
      findFirst: jest.fn(async () => ({
        snapshot: { docTitle: 'restored', prospectId: 'forged', config: { prospectId: 'ignored' } },
      })),
    },
    wsEditLock: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({
        ...data,
        acquiredAt: new Date(),
        lastHeartbeatAt: new Date(),
      })),
      delete: jest.fn(async () => {
        writes.push('lock.delete');
        return {};
      }),
      update: jest.fn(async () => {
        writes.push('lock.update');
        return {};
      }),
    },
    wsShareLink: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async () => {
        writes.push('share.create');
        return {};
      }),
    },
  };
  tx.$transaction = jest.fn(async (fn: any) => fn(tx));
  const prisma = tx as any;
  const notifications = {
    create: jest.fn(async () => ({})),
    resolveInvite: jest.fn(async () => undefined),
  };
  const collaborators = new CollaboratorsService(prisma, notifications as never);
  return { draft, state, tx, prisma, collaborators, receipts, writes, notifications };
}

describe('prospect Workspace resource boundaries (synthetic only)', () => {
  afterEach(() => jest.restoreAllMocks());
  it('requires a current Core identity even for the Workspace owner and never treats client text as a grant', async () => {
    const h = fixture();
    await expect(assertProspectDraft(h.prisma, h.draft, actor)).resolves.toBeUndefined();
    h.state.member = false;
    await expect(assertProspectDraft(h.prisma, h.draft, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    h.state.member = true;
    h.state.linkedClientId = '77777777-7777-4777-8777-777777777777';
    h.state.wall = true;
    await expect(assertProspectDraft(h.prisma, h.draft, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    h.state.grant = true;
    await expect(assertProspectDraft(h.prisma, h.draft, actor)).resolves.toBeUndefined();
  });
  it.each([undefined, 'user_foreign'])(
    'rejects missing/foreign actor %p without an operation',
    async (actorId) => {
      const h = fixture();
      const action = jest.fn(async () => true);
      await expect(
        withProspectDraft(h.prisma, h.draft, actorId, canRead, 'read', action),
      ).rejects.toMatchObject({ status: 404 });
      expect(action).not.toHaveBeenCalled();
    },
  );
  it('requires active collaborator role separately from current Core scope', async () => {
    const h = fixture();
    await expect(assertProspectDraft(h.prisma, h.draft, 'user_editor')).rejects.toMatchObject({
      status: 404,
    });
    h.state.role = 'viewer';
    await expect(assertProspectDraft(h.prisma, h.draft, 'user_editor')).resolves.toBeUndefined();
    const write = jest.fn(async () => true);
    await expect(
      withProspectDraft(h.prisma, h.draft, 'user_editor', canEdit, 'write', write),
    ).rejects.toMatchObject({ status: 404 });
    expect(write).not.toHaveBeenCalled();
    h.state.role = 'editor';
    await expect(
      withProspectDraft(h.prisma, h.draft, 'user_editor', canEdit, 'write', write),
    ).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith(h.tx);
  });
  it('keeps legacy drafts on their original callback path', async () => {
    const h = fixture();
    h.draft.prospectId = null;
    const action = jest.fn(async () => true);
    await expect(
      withProspectDraft(h.prisma, h.draft, undefined, canRead, 'read', action),
    ).resolves.toBe(true);
    expect(h.tx.$transaction).not.toHaveBeenCalled();
  });
  it('composes prospect scope with existing private Intel source authority', async () => {
    const h = fixture();
    h.state.sourceRows = [
      { source_key: 'private', owner_id: 'other', source_type: 'legiwatch_research' },
    ];
    expect(await h.collaborators.resolveRole(tenantId, draftId, actor)).toBeNull();
    h.state.sourceRows = [];
    expect(await h.collaborators.resolveRole(tenantId, draftId, actor)).toBe('owner');
    h.state.member = false;
    expect(await h.collaborators.resolveRole(tenantId, draftId, actor)).toBeNull();
  });
  it('creates draft, initial document and immutable receipt together, recovers the same id, and does not resurrect deleted drafts', async () => {
    const h = fixture();
    const service = new DraftsService(h.prisma, h.collaborators);
    const dto = {
      prospectId,
      requestId: '88888888-8888-4888-8888-888888888888',
      docTitle: 'Proposal',
    };
    const first = await service.create(tenantId, actor, dto);
    expect(await service.create(tenantId, actor, dto)).toBe(first);
    expect(h.tx.wsDraft.create).toHaveBeenCalledTimes(1);
    expect(h.tx.wsDocument.create).toHaveBeenCalledTimes(1);
    expect(h.receipts).toHaveLength(1);
    await expect(
      service.create(tenantId, actor, { ...dto, docTitle: 'different' }),
    ).rejects.toMatchObject({ response: { code: 'prospect_draft_request_conflict' } });
    h.state.exists = false;
    await expect(service.create(tenantId, actor, dto)).rejects.toMatchObject({
      response: { code: 'prospect_draft_consumed' },
    });
  });
  it('rejects rebinding by update and restores only whitelisted snapshot fields', async () => {
    const h = fixture();
    const drafts = new DraftsService(h.prisma, h.collaborators);
    await expect(
      drafts.update(tenantId, draftId, actor, { prospectId: null } as never),
    ).rejects.toMatchObject({ response: { code: 'PROSPECT_ORIGIN_IMMUTABLE' } });
    const versions = new VersionsService(h.prisma, h.collaborators);
    await versions.restore(tenantId, draftId, 'version', actor);
    expect(h.draft.prospectId).toBe(prospectId);
    expect(h.draft.docTitle).toBe('restored');
    expect(h.tx.wsDraft.update.mock.calls[0][0].data).not.toHaveProperty('prospectId');
  });
  it('protects documents/comments/versions/context/checks/anonymize by ID after revocation', async () => {
    const h = fixture();
    h.state.member = false;
    const calls = [
      () => new DocumentsService(h.prisma, h.collaborators).list(tenantId, draftId, actor),
      () =>
        new CommentsService(h.prisma, {} as never, h.collaborators).list(tenantId, 'doc', actor),
      () => new VersionsService(h.prisma, h.collaborators).list(tenantId, draftId, actor),
      () => new ContextService(h.prisma, h.collaborators).listItems(tenantId, draftId, actor),
      () => new ChecksService(h.prisma).evaluate(tenantId, draftId, actor),
      () =>
        new DraftsService(h.prisma, h.collaborators).detectAnonymizeNames(tenantId, draftId, actor),
    ];
    for (const call of calls) await expect(call()).rejects.toBeDefined();
    expect(h.tx.wsDocument.findMany).not.toHaveBeenCalled();
    expect(h.tx.wsComment.findMany).not.toHaveBeenCalled();
    expect(h.tx.wsDocVersion.findMany).not.toHaveBeenCalled();
    expect(h.tx.wsContextItem.findMany).not.toHaveBeenCalled();
  });
  it('protects actual document and draft mutation boundaries and saved versions', async () => {
    const h = fixture();
    const docs = new DocumentsService(h.prisma, h.collaborators);
    await docs.update(tenantId, draftId, 'doc', actor, { name: 'Updated' });
    expect(h.writes).toContain('document.update');
    h.state.member = false;
    await expect(
      docs.update(tenantId, draftId, 'doc', actor, { name: 'Denied' }),
    ).rejects.toBeDefined();
    expect(h.writes.filter((w) => w === 'document.update')).toHaveLength(1);
    await expect(
      new VersionsService(h.prisma, h.collaborators).create(tenantId, draftId, actor, {}),
    ).rejects.toBeDefined();
    expect(h.tx.wsDocVersion.create).not.toHaveBeenCalled();
  });
  it('filters prospect draft list after collaborator/current scope revalidation', async () => {
    const h = fixture();
    const svc = new DraftsService(h.prisma, h.collaborators);
    expect((await svc.list(tenantId, actor, { prospectId })).drafts).toHaveLength(1);
    h.state.member = false;
    expect((await svc.list(tenantId, actor, { prospectId })).drafts).toEqual([]);
    expect(h.tx.wsDraft.findMany.mock.calls[0][0].where.prospectId).toBe(prospectId);
  });
  it('rechecks client authority after export rendering before returning bytes', async () => {
    const h = fixture();
    const svc = new ExportService(h.prisma, h.collaborators);
    jest.spyOn(Packer, 'toBuffer').mockImplementation(async () => {
      h.state.member = false;
      return Buffer.from('synthetic-export');
    });
    await expect(svc.buildDocx(tenantId, draftId, undefined, actor)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('denies public token reads/comments and new shares before any content output or mutation', async () => {
    const h = fixture();
    const svc = new ShareLinkService(h.prisma, h.collaborators);
    const token = 'synthetic-token';
    h.tx.wsShareLink.findMany.mockResolvedValue([
      {
        id: 'share',
        tenantId,
        draftId,
        tokenHash: svc.hashToken(token),
        revokedAt: null,
        expiresAt: null,
      },
    ]);
    await expect(svc.getByToken(token)).rejects.toMatchObject({ status: 404 });
    await expect(svc.addGuestComment(token, 'text', 'Name')).rejects.toMatchObject({ status: 404 });
    await expect(svc.createShareLink(tenantId, draftId, actor, {})).rejects.toMatchObject({
      status: 403,
    });
    expect(h.tx.wsShareLink.create).not.toHaveBeenCalled();
  });
  it('refuses Meri import, firm-memory promotion and generation before downstream calls', async () => {
    const h = fixture();
    const docs = new DocumentsService(h.prisma, h.collaborators);
    await expect(docs.listForMeriImport(tenantId, draftId, actor)).rejects.toMatchObject({
      status: 403,
    });
    await expect(docs.readForMeriImport(tenantId, draftId, 'doc', actor)).rejects.toMatchObject({
      status: 403,
    });
    const client = { promote: jest.fn() };
    await expect(
      new MemoryPromotionService(h.prisma, client as never).promoteDraft(tenantId, actor, draftId),
    ).rejects.toMatchObject({ status: 404 });
    expect(client.promote).not.toHaveBeenCalled();
    const generation = Object.create(GenerationService.prototype);
    Object.assign(generation, { prisma: h.prisma });
    await expect(generation.generateAllSections(tenantId, draftId, actor)).rejects.toMatchObject({
      status: 403,
    });
  });
  it('does not invite external/foreign recipients, but preserves the pending-to-active internal flow', async () => {
    const h = fixture();
    await expect(
      h.collaborators.invite(tenantId, draftId, actor, {
        email: 'external@example.test',
        role: 'viewer',
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      h.collaborators.invite(tenantId, draftId, actor, {
        subjectId: 'user_foreign',
        role: 'viewer',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.tx.wsCollaborator.create).not.toHaveBeenCalled();
    await h.collaborators.invite(tenantId, draftId, actor, {
      subjectId: 'user_editor',
      role: 'editor',
    });
    expect(h.tx.wsCollaborator.create).toHaveBeenCalledTimes(1);
    await h.collaborators.accept(tenantId, draftId, 'invite', 'user_editor');
    expect(h.writes).toContain('collaborator.update');
    h.state.member = false;
    await expect(
      h.collaborators.accept(tenantId, draftId, 'invite', 'user_editor'),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('keeps removed collaborators and deleted drafts out of notification metadata', async () => {
    const h = fixture();
    const notice = { draftId, collaboratorId: 'invite', kind: 'collab_invite' };
    expect(await prospectNotificationVisible(h.prisma, tenantId, actor, notice)).toBe(true);
    h.state.member = false;
    expect(await prospectNotificationVisible(h.prisma, tenantId, actor, notice)).toBe(false);
    h.state.member = true;
    h.state.exists = false;
    expect(await prospectNotificationVisible(h.prisma, tenantId, actor, notice)).toBe(false);
  });
  it('clears a lock handoff when the saved requester is no longer eligible', async () => {
    const h = fixture();
    const lock = {
      draftId,
      tenantId,
      holderId: actor,
      holderName: 'Owner',
      acquiredAt: new Date(),
      lastHeartbeatAt: new Date(),
      requestedById: 'user_foreign',
      requestedByName: 'Former teammate',
      requestedAt: new Date(),
    };
    h.tx.wsEditLock.findFirst.mockResolvedValue(lock);
    const result = await new EditLockService(h.prisma, h.collaborators).release(
      tenantId,
      draftId,
      actor,
    );
    expect(result.held).toBe(false);
    expect(h.writes).toEqual(['lock.delete']);
  });
});
