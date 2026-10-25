import { ordinaryDraftState, saveOrdinaryDraft } from './ordinary-draft-save.js';
import { ConflictException, NotFoundException } from '@nestjs/common';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = uuid(1), draftId = uuid(2), documentId = uuid(3), actorId = 'synthetic_author';
function fixture() {
  let draft: any = {
    id: draftId, tenantId, ownerId: actorId, prospectId: null, clientId: null, client: null,
    docTitle: 'Before', config: { clientId: null, preserved: { future: true } }, ask: 'n/a',
    industry: null, product: null, status: 'draft', isPacket: false, docCount: 1,
    documents: [{ id: documentId, name: 'Document', ordinal: 0, body: { blocks: [], custom: { untouched: true } } }],
  };
  let versions: any[] = [];
  const tx: any = {
    $executeRaw: jest.fn(async () => 1), $queryRaw: jest.fn(async () => [{ id: draftId }]),
    wsDraft: { findFirst: jest.fn(async ({ where }) => where.id === draftId && where.tenantId === tenantId ? structuredClone(draft) : null) },
    wsCollaborator: { findFirst: jest.fn(async () => null) },
    wsDocument: { update: jest.fn(async ({ where, data }) => {
      const doc = draft.documents.find((d: any) => d.id === where.id);
      if (!doc || where.tenantId !== tenantId || where.draftId !== draftId) throw new Error('Foreign document');
      Object.assign(doc, data); return structuredClone(doc);
    }) },
    wsDocVersion: {
      findFirst: jest.fn(async ({ where }) => versions.find(v => v.id === where.id && v.tenantId === where.tenantId && v.draftId === where.draftId) ?? null),
      create: jest.fn(async ({ data }) => {
        const version = { ...structuredClone(data), createdAt: new Date('2026-10-25T12:00:00Z') };
        versions.push(version); return version;
      }),
    },
  };
  let queue = Promise.resolve();
  const prisma: any = {
    withSystem: jest.fn(async (fn) => fn({ $queryRaw: async () => [{ id: uuid(9) }] })),
    $transaction: jest.fn((fn) => {
      const result = queue.then(async () => {
        const before = structuredClone({ draft, versions });
        try { return await fn(tx); } catch (error) { draft = before.draft; versions = before.versions; throw error; }
      });
      queue = result.then(() => undefined, () => undefined); return result;
    }),
  };
  const collaborators: any = { sourceAccess: jest.fn(async () => true) };
  const state = () => ordinaryDraftState(prisma, collaborators, tenantId, draftId, actorId);
  const save = (input: any, actor = actorId) => saveOrdinaryDraft(prisma, collaborators, tenantId, draftId, actor, input, async () => {
    Object.assign(draft, input.draft);
  });
  const input = async () => ({ requestId: uuid(4), expectedClientId: null,
    expectedStateHash: (await state()).stateHash, draft: { docTitle: 'After' },
    documents: [{ id: documentId, body: { blocks: [{ content: 'Authored content' }], custom: { untouched: true } } }],
  });
  return { tx, prisma, collaborators, state, save, input, current: () => draft, versions: () => versions };
}

describe('ordinary atomic draft save', () => {
  it('commits the supplied title/body and one immutable snapshot with the same receipt', async () => {
    const f = fixture();
    const input = await f.input();
    const result = await f.save(input);
    expect(result.receipt).toMatchObject({ requestId: input.requestId, versionId: input.requestId,
      draftId, actorId, clientId: null, stateHash: (await f.state()).stateHash });
    expect(f.versions()).toHaveLength(1);
    expect(f.versions()[0].snapshot).toMatchObject({ docTitle: 'After', config: { preserved: { future: true } },
      documents: [{ body: input.documents[0]!.body }], atomicSave: { requestHash: result.receipt.requestHash } });
  });
  it('rejects a stale editor instead of overwriting the committed title or body', async () => {
    const f = fixture(); const input = await f.input();
    await f.save(input);
    await expect(f.save({ ...input, requestId: uuid(5), draft: { docTitle: 'Stale overwrite' } }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(f.current().docTitle).toBe('After'); expect(f.versions()).toHaveLength(1);
  });
  it('replays the exact original receipt after later edits without overwriting newer content', async () => {
    const f = fixture(); const first = await f.input();
    const accepted = await f.save(first);
    await f.save({ ...await f.input(), requestId: uuid(5), draft: { docTitle: 'Newer' } });
    const replay = await f.save(first);
    expect(replay).toEqual({ ...accepted, replayed: true });
    expect(f.current().docTitle).toBe('Newer'); expect(f.versions()).toHaveLength(2);
  });
  it('rejects changed payload under the same request identity', async () => {
    const f = fixture(); const input = await f.input(); await f.save(input);
    await expect(f.save({ ...input, draft: { docTitle: 'Changed request' } })).rejects.toBeInstanceOf(ConflictException);
    expect(f.current().docTitle).toBe('After'); expect(f.versions()).toHaveLength(1);
  });
  it('rejects a foreign tab before writing any supplied title', async () => {
    const f = fixture(); const input = await f.input();
    await expect(f.save({ ...input, documents: [{ id: uuid(99), body: {} }] })).rejects.toBeInstanceOf(NotFoundException);
    expect(f.current().docTitle).toBe('Before'); expect(f.versions()).toHaveLength(0);
  });
  it.each(['document', 'version'])('rolls back title and body if the %s write fails', async (point) => {
    const f = fixture(); const input = await f.input();
    if (point === 'document') f.tx.wsDocument.update.mockRejectedValueOnce(new Error('Injected write failure'));
    else f.tx.wsDocVersion.create.mockRejectedValueOnce(new Error('Injected write failure'));
    await expect(f.save(input)).rejects.toThrow('Injected write failure');
    expect(f.current().docTitle).toBe('Before');
    expect(f.current().documents[0].body).toEqual({ blocks: [], custom: { untouched: true } });
    expect(f.versions()).toHaveLength(0);
    await expect(f.save(input)).resolves.toMatchObject({ replayed: false });
  });
  it('rechecks source access and actor scope before replay', async () => {
    const f = fixture(); const input = await f.input(); await f.save(input);
    f.collaborators.sourceAccess.mockResolvedValue(false);
    await expect(f.save(input)).rejects.toBeInstanceOf(NotFoundException);
    f.collaborators.sourceAccess.mockResolvedValue(true);
    await expect(f.save(input, 'synthetic_other')).rejects.toBeInstanceOf(NotFoundException);
    expect(f.versions()).toHaveLength(1);
  });
  it('keeps prospect copies on their established save owner', async () => {
    const f = fixture(); const input = await f.input(); f.current().prospectId = uuid(10);
    await expect(f.save(input)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.versions()).toHaveLength(0);
  });
});
