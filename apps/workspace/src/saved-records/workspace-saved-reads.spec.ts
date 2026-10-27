import {
  readWorkspaceSavedRecord,
  WORKSPACE_SAVED_READ_MAX_BYTES,
  type WorkspaceSavedReadOwners,
} from './workspace-saved-reads.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const draftId = '22222222-2222-4222-8222-222222222222';
const versionId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';
const identity = { tenantId, clerkUserId: 'user_reader' };
const savedAt = new Date('2026-10-01T12:00:00.000Z');
function fixture() {
  const snapshot = {
    docTitle: 'Saved full text',
    config: { sections: ['One'] },
    ask: { amount: '9007199254740993.01' },
    documents: [{ id: documentId, body: { blocks: [{ content: 'Saved body \u6f22\u5b57' }] } }],
  };
  const version = {
    id: versionId,
    tenantId,
    draftId,
    label: null,
    authorId: 'user_author',
    authorKind: 'person',
    createdAt: savedAt,
    snapshot,
  };
  const owners = {
    versions: {
      list: jest.fn(async () => [version]),
      getSaved: jest.fn(async (_tenant: string, _draft: string, selected: string) => {
        if (selected !== versionId)
          throw Object.assign(new Error('Version not found'), { status: 404 });
        return version;
      }),
      outreachRevision: jest.fn(async () => ({ versionId, snapshot })),
    },
    documents: {
      list: jest.fn(async () => [
        {
          id: documentId,
          name: 'Live tab',
          ordinal: 0,
          body: { content: 'LATER WORKING COPY' },
          createdAt: savedAt,
          updatedAt: savedAt,
        },
      ]),
    },
    comments: {
      list: jest.fn(async () => [
        {
          id: 'comment',
          body: 'full parent',
          quote: 'quoted',
          anchor: { from: 1 },
          replies: [{ id: 'reply', body: 'full reply' }],
        },
      ]),
    },
    hillDay: {
      listDocuments: jest.fn(async () => ({
        items: [],
        nextCursor: 'opaque-revoked-window-continuation',
      })),
      get: jest.fn(async () => ({
        id: documentId,
        sections: [{ background: 'full saved background' }],
        provenance: { sources: [] },
      })),
    },
    newsletter: {
      listSaved: jest.fn(async () => ({ items: [] })),
      getSaved: jest.fn(async () => ({
        id: documentId,
        design: { body: 'Full saved' },
        config: { clientId: null },
      })),
      stagedRevision: jest.fn(async () => null),
    },
  };
  const run = (input: Parameters<typeof readWorkspaceSavedRecord>[2]) =>
    readWorkspaceSavedRecord(owners as unknown as WorkspaceSavedReadOwners, identity, input);
  return { owners, run, snapshot, version };
}

describe('Workspace saved reads preserve source ownership', () => {
  it('selects the exact full saved snapshot and never fetches or substitutes the working copy', async () => {
    const h = fixture();
    const result = await h.run({ kind: 'saved_version', draftId, versionId });
    expect(result.data).toEqual({
      draftId,
      versionId,
      label: null,
      authorId: 'user_author',
      authorKind: 'person',
      savedAt: savedAt.toISOString(),
      snapshot: h.snapshot,
    });
    expect(h.owners.versions.getSaved).toHaveBeenCalledWith(
      tenantId,
      draftId,
      versionId,
      identity.clerkUserId,
    );
    expect(h.owners.documents.list).not.toHaveBeenCalled();
    expect(h.owners.versions.outreachRevision).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(result)).data.snapshot.ask.amount).toBe('9007199254740993.01');
  });
  it('an absent version fails instead of selecting the newest available snapshot', async () => {
    const h = fixture();
    await expect(
      h.run({ kind: 'saved_version', draftId, versionId: documentId }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.owners.documents.list).not.toHaveBeenCalled();
  });
  it('rechecks the source owner after revocation and propagates infrastructure failures', async () => {
    const h = fixture();
    await h.run({ kind: 'saved_version', draftId, versionId });
    const revoked = new Error('current authority revoked');
    h.owners.versions.getSaved.mockRejectedValueOnce(revoked);
    await expect(h.run({ kind: 'saved_version', draftId, versionId })).rejects.toBe(revoked);
    expect(h.owners.versions.getSaved).toHaveBeenCalledTimes(2);
  });
  it('metadata is explicit and does not smuggle current bodies or all version snapshots', async () => {
    const h = fixture();
    const docs = await h.run({ kind: 'documents', draftId });
    const versions = await h.run({ kind: 'versions', draftId });
    expect(JSON.stringify(docs)).not.toContain('LATER WORKING COPY');
    expect(JSON.stringify(versions)).not.toContain('Saved body');
    expect(versions.coverage.limitations.join(' ')).toContain('unpaged');
  });
  it('retains the original actor/filter-bound continuation even on an empty page', async () => {
    const h = fixture();
    const query = {
      kind: 'draft' as const,
      scope: 'shared' as const,
      cursor: 'prior-token',
      limit: '1',
    };
    const result = await h.run({ kind: 'library', query });
    expect(result.data).toEqual({ items: [], nextCursor: 'opaque-revoked-window-continuation' });
    expect(h.owners.hillDay.listDocuments).toHaveBeenCalledWith(
      tenantId,
      identity.clerkUserId,
      query,
    );
  });
  it('preserves comment bodies, quotes, anchors and full replies', async () => {
    const h = fixture();
    const result = await h.run({ kind: 'comments', documentId });
    expect(result.data).toEqual({ documentId, threads: await h.owners.comments.list() });
    expect(h.owners.comments.list).toHaveBeenNthCalledWith(
      1,
      tenantId,
      documentId,
      identity.clerkUserId,
    );
  });
  it('delegates saved Hill Day content only to the existing read owner', async () => {
    const h = fixture();
    await h.run({ kind: 'hill_day', documentId });
    expect(h.owners.hillDay.get).toHaveBeenCalledWith(tenantId, documentId, identity.clerkUserId);
  });
  it('a missing exact newsletter stage stays null and never calls invitation-activating reads', async () => {
    const h = fixture();
    const result = await h.run({ kind: 'newsletter_stage', documentId, revision: 7 });
    expect(result.data).toBeNull();
    expect(h.owners.newsletter.stagedRevision).toHaveBeenCalledWith(identity, documentId, 7);
    expect(h.owners.newsletter.listSaved).not.toHaveBeenCalled();
    expect(h.owners.newsletter.getSaved).not.toHaveBeenCalled();
  });
  it('uses the canonical transfer owner only for an explicitly requested outreach revision', async () => {
    const h = fixture();
    await h.run({ kind: 'outreach_revision', draftId, versionId });
    expect(h.owners.versions.outreachRevision).toHaveBeenCalledWith(
      tenantId,
      draftId,
      versionId,
      identity.clerkUserId,
    );
    expect(h.owners.versions.list).not.toHaveBeenCalled();
  });
  it('refuses a large multibyte snapshot whole and counts the full UTF-8 envelope', async () => {
    const h = fixture();
    h.snapshot.documents[0]!.body.blocks[0]!.content = '\u6f22'.repeat(
      Math.floor(WORKSPACE_SAVED_READ_MAX_BYTES / 3),
    );
    await expect(h.run({ kind: 'saved_version', draftId, versionId })).rejects.toMatchObject({
      status: 413,
      response: { code: 'SAVED_RECORD_RESULT_TOO_LARGE' },
    });
    h.snapshot.documents[0]!.body.blocks[0]!.content = '\u6f22'.repeat(80_000);
    const result = await h.run({ kind: 'saved_version', draftId, versionId });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      WORKSPACE_SAVED_READ_MAX_BYTES,
    );
    expect(JSON.stringify(result)).toContain('\u6f22'.repeat(80_000));
  });
  it.each([
    { kind: 'saved_version', draftId },
    { kind: 'saved_version', draftId, versionId, snapshot: {} },
    { kind: 'documents', draftId, tenantId },
    { kind: '__proto__' },
    { kind: 'library', query: { ownerId: 'someone_else' } },
    { kind: 'library', query: { limit: '1000' } },
    { kind: 'newsletter_stage', documentId, revision: 0 },
  ])('rejects malformed or authority-bearing input before owner reads: %p', async (input) => {
    const h = fixture();
    await expect(h.run(input as never)).rejects.toMatchObject({ status: 400 });
    for (const owner of Object.values(h.owners))
      for (const method of Object.values(owner)) expect(method).not.toHaveBeenCalled();
  });
});
