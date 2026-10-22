import { createDescendantHarness, WS03_IDS } from './support/ws03-descendant-harness.js';
import { VersionsService } from '../src/versions/versions.service.js';

const { tenantId, draftId, documentId, foreignId } = WS03_IDS;
const operations = ['list', 'create', 'restore'] as const;
type Operation = typeof operations[number];

function fixture() {
  const h = createDescendantHarness();
  const version = {
    id: 'saved-version', tenantId, draftId,
    snapshot: {
      config: h.draft.config,
      documents: [{ id: documentId, body: { text: 'SAVED_VERSION_CONTENT' } }],
    },
  };
  h.db.wsDocVersion = {
    findMany: jest.fn(async () => { h.reads.push('version.list'); return [version]; }),
    findFirst: jest.fn(async () => { h.reads.push('version.read'); return version; }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      h.effects.push('version.create'); return { ...version, ...data };
    }),
  };
  h.db.wsDraft.update = jest.fn(async () => {
    h.effects.push('draft.update'); return h.draft;
  });
  h.db.wsDocument.update = jest.fn(async () => {
    h.effects.push('document.update'); return h.draft.documents[0];
  });
  const service = new VersionsService(h.db, h.collaborators);
  const run = (operation: Operation, actorId = h.state.actorId, selectedDraftId = draftId) => {
    if (operation === 'list') return service.list(tenantId, selectedDraftId, actorId);
    if (operation === 'create') return service.create(tenantId, selectedDraftId, actorId, {});
    return service.restore(tenantId, selectedDraftId, version.id, actorId);
  };
  return { ...h, service, run };
}

describe('version admission precedes full snapshot reads', () => {
  it.each(operations)('%s denies an unrelated actor before draft/document or version content', async operation => {
    const h = fixture();
    h.reset({ actorId: 'user_unrelated' });
    await expect(h.run(operation)).rejects.toMatchObject({ status: 403 });
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  });

  it.each(operations)('%s rechecks revoked membership before full content', async operation => {
    const h = fixture();
    h.reset({ member: false });
    await expect(h.run(operation)).rejects.toMatchObject({ status: 403 });
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  });

  it.each(operations)('%s rechecks a revoked client wall before full content', async operation => {
    const h = fixture();
    h.reset({ wallAllowed: false });
    await expect(h.run(operation)).rejects.toMatchObject({ status: 403 });
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  });

  it.each(operations)('%s rejects a forged parent using only the minimal lookup', async operation => {
    const h = fixture();
    await expect(h.run(operation, 'user_owner', foreignId)).rejects.toMatchObject({ status: 404 });
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
    expect(h.authorityQueries).toEqual([]);
  });

  it.each(operations)('%s rejects an invalid prospect copy receipt before full content', async operation => {
    const h = fixture();
    h.reset({ prospect: true, invalidCopiedBrief: true });
    await expect(h.run(operation)).rejects.toMatchObject({ status: 404 });
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
    expect(h.authorityQueries.some(query => query.includes('source_brief_version'))).toBe(true);
  });

  it.each(['reviewer', 'commenter', 'viewer'] as const)(
    'keeps %s list access while refusing snapshot writes before full content', async role => {
      const h = fixture();
      h.reset({ actorId: `user_${role}` });
      expect(await h.run('list')).toHaveLength(1);
      expect(h.reads).toContain('version.list');
      for (const operation of ['create', 'restore'] as const) {
        h.clearObservations();
        await expect(h.run(operation)).rejects.toMatchObject({ status: 403 });
        expect(h.reads).toEqual([]);
        expect(h.effects).toEqual([]);
      }
    },
  );

  it.each(['owner', 'editor'] as const)('preserves %s snapshot create and restore', async role => {
    const h = fixture();
    h.reset({ actorId: `user_${role}` });
    await expect(h.run('create')).resolves.toMatchObject({ authorId: `user_${role}` });
    expect(h.effects).toEqual(['version.create']);
    h.clearObservations();
    await expect(h.run('restore')).resolves.toMatchObject({ id: draftId });
    expect(h.effects).toEqual(['draft.update', 'document.update']);
  });

  it('preserves an authorized prospect owner list and snapshot', async () => {
    const h = fixture();
    h.reset({ prospect: true });
    h.db.wsDraft.findFirstOrThrow = h.db.wsDraft.findFirst;
    await expect(h.run('list')).resolves.toHaveLength(1);
    await expect(h.run('create')).resolves.toMatchObject({ authorId: 'user_owner' });
    expect(h.effects).toEqual(['version.create']);
  });

  it('preserves the existing internal ordinary-list signature without creating an actorless prospect path', async () => {
    const h = fixture();
    await expect(h.service.list(tenantId, draftId)).resolves.toHaveLength(1);
    h.reset({ prospect: true });
    await expect(h.service.list(tenantId, draftId)).rejects.toMatchObject({ status: 404 });
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  });
});
