// Only the unused generation collaborator is replaced. The actual Workspace
// read services, collaborator resolver, member/client wall helpers all execute.
jest.mock('../generation/generation.service.js', () => ({ GenerationService: class {} }));
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { VersionsService } from '../versions/versions.service.js';
import { CommentsService } from '../comments/comments.service.js';
import {
  readWorkspaceSavedRecord,
  type WorkspaceSavedRead,
  type WorkspaceSavedReadOwners,
} from './workspace-saved-reads.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1),
  draftId = id(2),
  documentId = id(3),
  versionId = id(4),
  clientId = id(5),
  userId = id(6);
const date = new Date('2026-10-26T00:00:00Z');
function fixture() {
  const state = { member: true, wall: true, active: true, grant: true, exists: true };
  const draft = {
    id: draftId,
    tenantId,
    ownerId: 'user_owner',
    prospectId: null,
    clientId,
    client: 'Saved client',
    config: { clientId },
    documents: [],
  };
  const doc = {
    id: documentId,
    tenantId,
    draftId,
    draft,
    name: 'Saved tab',
    ordinal: 0,
    createdAt: date,
    updatedAt: date,
    body: { blocks: [] },
  };
  const version = {
    id: versionId,
    tenantId,
    draftId,
    label: null,
    authorKind: 'person',
    authorId: 'user_owner',
    createdAt: date,
    snapshot: {
      docTitle: 'Exact saved',
      documents: [{ id: documentId, body: { blocks: [{ content: 'Full saved content' }] } }],
    },
  };
  const reads: string[] = [];
  const prisma: any = {
    wsDraft: {
      findFirst: jest.fn(async ({ where }: any) =>
        state.exists && where.id === draftId && where.tenantId === tenantId ? draft : null,
      ),
    },
    wsCollaborator: {
      findFirst: jest.fn(async ({ where }: any) =>
        state.grant && where.subjectId === 'user_viewer' && where.status === 'active'
          ? { role: 'viewer' }
          : null,
      ),
    },
    wsDocument: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === documentId && where.tenantId === tenantId ? doc : null,
      ),
      findMany: jest.fn(async () => {
        reads.push('documents');
        return [doc];
      }),
    },
    wsDocVersion: {
      findFirst: jest.fn(async ({ where }: any) => {
        reads.push('version.exact');
        return where.tenantId === tenantId && where.draftId === draftId && where.id === versionId
          ? version
          : null;
      }),
      findMany: jest.fn(async () => {
        reads.push('versions');
        return [version];
      }),
    },
    wsComment: {
      findMany: jest.fn(async () => {
        reads.push('comments');
        return [{ id: id(7), body: 'Complete private note', replies: [] }];
      }),
    },
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      if (sql.includes('FROM users u JOIN tenant_memberships'))
        return values[0] === tenantId && state.member ? [{ id: userId }] : [];
      if (sql.includes('FROM clients'))
        return state.active ? [{ id: clientId, name: 'Saved client' }] : [];
      if (sql.includes('FROM ws_source_action')) return [];
      throw new Error(`Unexpected synthetic authority query: ${sql}`);
    }),
    $queryRawUnsafe: jest.fn(async (sql: string, ...values: unknown[]) => {
      if (sql.includes('AS allowed')) {
        expect(values).toEqual([tenantId, clientId, userId]);
        return [{ allowed: state.wall }];
      }
      throw new Error(`Unexpected synthetic authority query: ${sql}`);
    }),
  };
  prisma.$transaction = async (run: (db: unknown) => unknown) => run(prisma);
  prisma.withSystem = async (run: (db: unknown) => unknown) => run(prisma);
  const collaborators = new CollaboratorsService(prisma, {} as never);
  const owners = {
    documents: new DocumentsService(prisma, collaborators),
    versions: new VersionsService(prisma, collaborators),
    comments: new CommentsService(
      prisma,
      {
        suggestCommentEdit: () => {
          throw new Error('No generation allowed');
        },
      } as never,
      collaborators,
    ),
    hillDay: {
      listDocuments: () => {
        throw new Error('Not this source');
      },
      get: () => {
        throw new Error('Not this source');
      },
    },
    newsletter: {
      listSaved: () => {
        throw new Error('Not this source');
      },
      getSaved: () => {
        throw new Error('Not this source');
      },
      stagedRevision: () => {
        throw new Error('Not this source');
      },
    },
  } as WorkspaceSavedReadOwners;
  const run = (input: WorkspaceSavedRead, actor = 'user_viewer', tenant = tenantId) =>
    readWorkspaceSavedRecord(owners, { tenantId: tenant, clerkUserId: actor }, input);
  return { state, prisma, reads, run, version };
}
const reads: WorkspaceSavedRead[] = [
  { kind: 'documents', draftId },
  { kind: 'versions', draftId },
  { kind: 'saved_version', draftId, versionId },
  { kind: 'comments', documentId },
];
describe('saved adapter through real Workspace authority owners', () => {
  it.each(reads)(
    'preserves viewer read for $kind and fresh admission after revocation',
    async (input) => {
      const h = fixture();
      await expect(h.run(input)).resolves.toMatchObject({ kind: input.kind });
      expect(h.reads.length).toBe(1);
      h.reads.length = 0;
      h.state.grant = false;
      await expect(h.run(input)).rejects.toMatchObject({ status: expect.any(Number) });
      expect(h.reads).toEqual([]);
    },
  );
  it.each(['member', 'wall', 'active', 'exists'] as const)(
    'refuses saved content when current %s is lost',
    async (key) => {
      const h = fixture();
      h.state[key] = false;
      await expect(h.run({ kind: 'saved_version', draftId, versionId })).rejects.toMatchObject({
        status: expect.any(Number),
      });
      expect(h.reads).toEqual([]);
    },
  );
  it('does not treat tenant membership or client visibility as a draft collaborator grant', async () => {
    const h = fixture();
    await expect(
      h.run({ kind: 'saved_version', draftId, versionId }, 'user_unrelated'),
    ).rejects.toMatchObject({ status: 403 });
    expect(h.reads).toEqual([]);
  });
  it('refuses foreign tenant and missing actor before private content', async () => {
    const h = fixture();
    await expect(
      h.run({ kind: 'saved_version', draftId, versionId }, 'user_owner', id(99)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(h.run({ kind: 'saved_version', draftId, versionId }, '')).rejects.toMatchObject({
      status: 404,
    });
    expect(h.reads).toEqual([]);
  });
  it('an absent exact version performs no version-list or working-copy fallback', async () => {
    const h = fixture();
    await expect(
      h.run({ kind: 'saved_version', draftId, versionId: id(99) }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.prisma.wsDocVersion.findMany).not.toHaveBeenCalled();
    expect(h.prisma.wsDocument.findMany).not.toHaveBeenCalled();
    expect(h.prisma.wsDocVersion.findFirst).toHaveBeenCalledTimes(1);
  });
  it('returns the selected immutable snapshot with no live-document content fetch by the adapter', async () => {
    const h = fixture();
    const result = await h.run({ kind: 'saved_version', draftId, versionId }, 'user_owner');
    expect((result.data as { snapshot: unknown }).snapshot).toEqual(h.version.snapshot);
    expect(h.prisma.wsDocument.findMany).not.toHaveBeenCalled();
    expect(h.prisma.wsDocVersion.findMany).not.toHaveBeenCalled();
    expect(h.prisma.wsDocVersion.findFirst).toHaveBeenCalledWith({
      where: { tenantId, draftId, id: versionId },
    });
    expect(h.prisma.wsDraft.findFirst.mock.calls.some(([query]: any) => query.include)).toBe(false);
  });
});
