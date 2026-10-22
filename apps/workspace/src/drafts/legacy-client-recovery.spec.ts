import { createHash } from 'node:crypto';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { ShareLinkService } from '../delivery/share-link.service.js';
import { HillDayDocumentService } from '../hillday/hillday-document.service.js';
import { DraftsService } from './drafts.service.js';
import { workspaceSavedOutreachRevisionWithinTx } from '@capiro/shared';

const T = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const D = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';

function fixture() {
  const state = { member: true, wall: true, client: true };
  const draft = {
    id: D, tenantId: T, ownerId: 'owner', prospectId: null,
    clientId: null as string | null, client: 'Legacy name',
    config: { client: 'Legacy name' } as Record<string, unknown>,
    docTitle: 'Private legacy draft', product: null, ask: null,
    documents: [], status: 'draft', updatedAt: new Date('2026-10-21T00:00:00Z'),
  };
  const version = { id: V, snapshot: { docTitle: draft.docTitle, config: draft.config, ask: null, documents: [] } };
  const link = {
    id: 'share', draftId: D, tenantId: T, createdById: 'owner', versionId: V,
    tokenHash: createHash('sha256').update('token').digest('hex'),
    expiresAt: null, revokedAt: null, createdAt: new Date(), label: null,
  };
  const db: any = {
    wsDraft: {
      findFirst: jest.fn(async ({ where }: any) => where.tenantId === T && where.id === D ? draft : null),
      findFirstOrThrow: jest.fn(async () => draft),
      findMany: jest.fn(async () => [draft]),
      update: jest.fn(async ({ data }: any) => Object.assign(draft, data)),
    },
    wsCollaborator: { findFirst: jest.fn(async () => ({ role: 'editor' })), findMany: jest.fn(async () => [{ draftId: D }]) },
    wsDocVersion: { findFirst: jest.fn(async () => version) },
    wsShareLink: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => [link]), create: jest.fn() },
    wsGuestComment: { create: jest.fn(), groupBy: jest.fn(async () => []) },
    wsHillDayDocument: { findMany: jest.fn(async () => []) },
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      if (sql.includes('FROM users')) return state.member ? [{ id: C }] : [];
      if (sql.includes('FROM clients')) return state.client && values[0] === T && values[1] === C ? [{ id: C, name: 'Canonical client' }] : [];
      return [];
    }),
    $queryRawUnsafe: jest.fn(async () => [{ allowed: state.wall }]),
  };
  db.$transaction = jest.fn(async (fn: any) => fn(db));
  db.withSystem = jest.fn(async (fn: any) => fn(db));
  const collaborators = new CollaboratorsService(db, {} as never);
  const drafts = new DraftsService(db, collaborators);
  const share = new ShareLinkService(db, collaborators);
  const source = { userDisplays: async () => new Map(), resolveUserId: async () => C, getClient: async () => ({ id: C, name: 'Canonical client', wallAllowed: true }) };
  const library = new HillDayDocumentService(db, source as never, {} as never, collaborators);
  return { state, draft, db, drafts, share, library };
}

describe('WS-04 legacy owner recovery', () => {
  it('returns the held draft to its active owner through read and both unfiltered lists', async () => {
    const h = fixture();
    expect(await h.drafts.byId(T, D, 'owner')).toMatchObject({ id: D, clientAssociation: 'held' });
    expect((await h.drafts.list(T, 'owner', {})).drafts).toEqual([expect.objectContaining({ id: D, clientAssociation: 'held' })]);
    expect((await h.library.listDocuments(T, 'owner', {})).items).toEqual([expect.objectContaining({ id: D, clientAssociation: 'held' })]);
  });

  it.each(['collaborator', 'removed owner'])('refuses %s access without exposing the held row', async (caseName) => {
    const h = fixture();
    if (caseName === 'removed owner') h.state.member = false;
    const actor = caseName === 'collaborator' ? 'collaborator' : 'owner';
    await expect(h.drafts.byId(T, D, actor)).rejects.toMatchObject({ status: 404 });
    expect((await h.drafts.list(T, actor, {})).drafts).toEqual([]);
  });

  it('allows owner edits but preserves the unresolved association when labels are cleared', async () => {
    const h = fixture();
    const result = await h.drafts.update(T, D, 'owner', { docTitle: 'Recovered content', client: '', config: { client: null } });
    expect(result).toMatchObject({ docTitle: 'Recovered content', client: 'Legacy name', clientAssociation: 'held', config: { client: 'Legacy name', clientId: null } });
    await expect(h.share.createShareLink(T, D, 'owner', { versionId: V })).rejects.toMatchObject({ status: 409 });
    expect(h.db.wsShareLink.create).not.toHaveBeenCalled();
  });

  it('refuses collaborator edits with an opaque 404 and no write', async () => {
    const h = fixture();
    await expect(h.drafts.update(T, D, 'collaborator', { docTitle: 'Unauthorized edit' })).rejects.toMatchObject({ status: 404 });
    expect(h.db.wsDraft.update).not.toHaveBeenCalled();
  });

  it.each(['draft list', 'library'])('excludes the held row from the client-filtered %s', async (surface) => {
    const h = fixture();
    const result = surface === 'draft list'
      ? (await h.drafts.list(T, 'owner', { clientId: C })).drafts
      : (await h.library.listDocuments(T, 'owner', { clientId: C })).items;
    expect(result).toEqual([]);
  });

  it('rechecks held ownership under the write lock before editing', async () => {
    const h = fixture();
    h.db.wsDraft.findFirstOrThrow.mockImplementation(async () => ({ ...h.draft, ownerId: 'new-owner' }));
    await expect(h.drafts.update(T, D, 'owner', { docTitle: 'Stale owner edit' })).rejects.toMatchObject({ status: 404 });
    expect(h.db.wsDraft.update).not.toHaveBeenCalled();
  });

  it.each(['create share', 'public read', 'guest comment'])('refuses %s while the client is held', async (surface) => {
    const h = fixture();
    const call = surface === 'create share'
      ? h.share.createShareLink(T, D, 'owner', { versionId: V })
      : surface === 'public read' ? h.share.getByToken('token') : h.share.addGuestComment('token', 'hello');
    await expect(call).rejects.toMatchObject({ status: 409 });
    expect(h.db.wsShareLink.create).not.toHaveBeenCalled();
    expect(h.db.wsGuestComment.create).not.toHaveBeenCalled();
  });

  it('omits held titles and comment counts from the share index', async () => {
    const h = fixture();
    expect(await h.share.listShares(T, 'owner')).toEqual({ shares: [] });
    expect(h.db.wsGuestComment.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: T, shareLinkId: { in: [] } } }));
  });

  it.each(['walled', 'missing or archived'])('refuses binding to a %s client with no write', async (reason) => {
    const h = fixture();
    h.state.wall = reason !== 'walled';
    h.state.client = reason !== 'missing or archived';
    await expect(h.drafts.update(T, D, 'owner', { clientId: C })).rejects.toMatchObject({ status: 404 });
    expect(h.db.wsDraft.update).not.toHaveBeenCalled();
  });

  it('binds through the existing wall check and returns canonical identity without a held flag', async () => {
    const h = fixture();
    const result = await h.drafts.update(T, D, 'owner', { clientId: C });
    expect(result).toMatchObject({ clientId: C, client: 'Canonical client', config: { clientId: C, client: 'Canonical client' } });
    expect(result).not.toHaveProperty('clientAssociation');
    expect(h.db.$queryRawUnsafe).toHaveBeenCalled();
  });

  it('retains the canonical staging owner refusal for unresolved legacy client names', async () => {
    const writes = jest.fn();
    const tx: any = { $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (sql.includes('FROM tenants')) return [{ id: T }];
      if (sql.includes('FROM tenant_memberships')) return [{ userId: C }];
      if (sql.includes('FROM ws_draft')) return [{ ownerId: 'owner', prospectId: null, client: 'Legacy name', config: {} }];
      if (sql.includes('FROM ws_doc_version')) return [{ id: V, authorId: 'owner', authorKind: 'person', createdAt: new Date(), snapshot: { docTitle: 'Saved', config: {}, documents: [{ body: { blocks: [{ content: 'Text' }] } }] } }];
      return [];
    }), $executeRaw: writes };
    await expect(workspaceSavedOutreachRevisionWithinTx(tx, { tenantId: T, clerkUserId: 'owner', userId: C, draftId: D, versionId: V })).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
  });
});
