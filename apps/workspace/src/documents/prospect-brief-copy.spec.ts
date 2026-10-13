import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PATH_METADATA, GUARDS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants';
import {
  copyProspectBrief,
  saveProspectBriefCopy,
  prospectBriefCopyState,
} from './prospect-brief-copy.js';
import {
  stateHash,
  briefSectionLabels,
  validateBriefCopyEdit,
} from './prospect-brief-copy-contract.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { TenantGuard } from '../auth/tenant.guard.js';
import { VersionsService } from '../versions/versions.service.js';
import { DraftsService } from '../drafts/drafts.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const prospectId = '22222222-2222-4222-8222-222222222222';
const draftId = '33333333-3333-4333-8333-333333333333';
const briefId = '44444444-4444-4444-8444-444444444444';
const versionId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';
const nextRequestId = '77777777-7777-4777-8777-777777777777';
const clientId = '88888888-8888-4888-8888-888888888888';
const actorId = 'user_synthetic_owner';

function fixture() {
  const citations = [{ sourceFamily: 'synthetic', recordId: 'record-1', title: 'Saved evidence' }];
  const sections = Object.fromEntries(
    Object.keys(briefSectionLabels).map((key) => [
      key,
      {
        text: `${key}: <script>alert("synthetic")</script> & retained text`,
        provenance: 'edited',
        citationIndexes: [0],
      },
    ]),
  );
  const sourceSnapshot = {
    generatedAt: '2026-10-13T00:00:00Z',
    evidence: [{ recordId: 'record-1' }],
  };
  const source = {
    kind: 'core_prospect_brief_version' as const,
    prospectId,
    briefId,
    versionId,
    versionNumber: 1,
    sectionsHash: stateHash(sections),
    snapshotHash: stateHash(sourceSnapshot),
  };
  const controls = {
    member: true,
    briefFlag: true,
    prospectFlag: true,
    status: 'active',
    linkedClientId: null as string | null,
    wall: false,
    grant: true,
    role: null as string | null,
    versionExists: true,
    interrupt: false,
    beforeParentLock: null as null | (() => void),
    coreCurrentVersionId: versionId,
    sourceSections: sections as unknown,
  };
  let draft: any = {
    id: draftId,
    tenantId,
    prospectId,
    ownerId: actorId,
    docTitle: 'Workspace product',
    config: { sections: [] },
    ask: 'n/a',
    industry: null,
    product: null,
    client: null,
    status: 'draft',
    isPacket: false,
    docCount: 0,
  };
  let documents: any[] = [];
  let versions: any[] = [];
  const coreReads: unknown[][] = [];
  let writes = 0;
  const tx: any = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      if (sql.includes('FROM business_development_prospects'))
        return [
          { linkedClientId: controls.linkedClientId, status: controls.status, dismissedAt: null },
        ];
      if (sql.includes('FROM tenants'))
        return [
          {
            settings: {
              clioFeatureFlags: {
                'businessDevelopment.enabled': controls.prospectFlag,
                'businessDevelopment.brief.enabled': controls.briefFlag,
              },
            },
          },
        ];
      if (sql.includes('FROM tenant_memberships'))
        return controls.member
          ? [
              {
                userId: '99999999-9999-4999-8999-999999999999',
                clerkUserId: args[2],
              },
            ]
          : [];
      if (sql.includes('set_config')) return [];
      if (sql.includes('SELECT status,memory_wall'))
        return [{ status: 'active', memoryWall: controls.wall }];
      if (sql.includes('AS allowed')) return [{ allowed: !controls.wall || controls.grant }];
      if (sql.includes('FROM client_memory_access')) return controls.grant ? [{ id: 'grant' }] : [];
      if (sql.includes('FROM business_development_briefs')) {
        coreReads.push(args);
        if (
          !controls.versionExists ||
          args.join() !== [tenantId, prospectId, briefId, versionId, 1].join()
        )
          return [];
        return [
          {
            sections: controls.sourceSections,
            citations,
            sourceSnapshot,
            sectionsHash: source.sectionsHash,
            snapshotHash: source.snapshotHash,
          },
        ];
      }
      throw Error(`Unexpected synthetic source query ${sql}`);
    },
    $queryRaw: async (strings: TemplateStringsArray, ...args: any[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM ws_draft')) {
        controls.beforeParentLock?.();
        controls.beforeParentLock = null;
        return draft ? [{ ownerId: draft.ownerId, prospectId: draft.prospectId }] : [];
      }
      if (sql.includes('FROM ws_collaborator'))
        return controls.role ? [{ role: controls.role }] : [];
      if (sql.includes('FROM ws_document')) {
        const selected = documents.filter((d) => d.sourceBriefVersion);
        if (sql.includes('LIMIT 1'))
          return selected
            .filter((d) => !args[2] || d.id === String(args[2]).toLowerCase())
            .slice(0, 1);
        if (sql.includes('source_brief_version IS NOT NULL')) return structuredClone(selected);
        return structuredClone(
          [...documents].sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id)),
        );
      }
      throw Error(`Unexpected synthetic destination query ${sql}`);
    },
    $executeRaw: async (strings: TemplateStringsArray, ...args: any[]) => {
      const sql = strings.join('?');
      if (sql.includes('set_config')) return 1;
      if (sql.includes('INSERT INTO ws_document')) {
        documents.push({
          id: args[0],
          name: args[3],
          ordinal: args[4],
          body: JSON.parse(args[5]),
          sourceBriefVersion: JSON.parse(args[6]),
          createdAt: new Date(0),
          updatedAt: new Date(0),
        });
        writes++;
        return 1;
      }
      if (sql.includes('UPDATE ws_document')) {
        const d = documents.find((d) => d.id === args[5]);
        if (!d) throw Error('Synthetic foreign document mutation');
        Object.assign(d, { body: JSON.parse(args[0]), name: args[1], ordinal: args[2] });
        writes++;
        return 1;
      }
      throw Error(`Unexpected synthetic mutation ${sql}`);
    },
    wsDraft: {
      findFirst: async ({ where }: any) =>
        draft && where.id === draftId && where.tenantId === tenantId
          ? structuredClone({ ...draft, documents })
          : null,
      findFirstOrThrow: async () => structuredClone({ ...draft, documents }),
      update: async ({ data }: any) => {
        Object.assign(draft, data);
        writes++;
        return structuredClone(draft);
      },
      delete: async () => {
        draft = null;
        documents = [];
        versions = [];
        return {};
      },
    },
    wsDocument: {
      findFirst: async ({ where }: any) => documents.find((d) => d.id === where.id) ?? null,
    },
    wsDocVersion: {
      findFirst: async ({ where }: any) =>
        structuredClone(
          versions.find(
            (v) =>
              v.id === where.id && v.tenantId === where.tenantId && v.draftId === where.draftId,
          ) ?? null,
        ),
      create: async ({ data }: any) => {
        if (controls.interrupt) throw Error('Synthetic interruption before durable receipt');
        if (versions.some((v) => v.id === data.id))
          throw Object.assign(Error('Synthetic collision'), { code: 'P2002' });
        const v = { ...structuredClone(data), id: data.id ?? nextRequestId };
        versions.push(v);
        writes++;
        return v;
      },
    },
  };
  let queue = Promise.resolve();
  const prisma: any = {
    ...tx,
    $transaction: (fn: any) => {
      const run = queue.then(async () => {
        const previous = structuredClone({ draft, documents, versions, writes });
        try {
          return await fn(tx);
        } catch (e) {
          ({ draft, documents, versions, writes } = previous);
          throw e;
        }
      });
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  const baseline = () => prospectBriefCopyState(prisma, tenantId, draftId, actorId);
  const copy = async (overrides: any = {}) =>
    copyProspectBrief(prisma, tenantId, draftId, actorId, {
      requestId,
      expectedClientId: controls.linkedClientId,
      expectedStateHash: (await baseline()).stateHash,
      source,
      ...overrides,
    });
  return {
    prisma,
    tx,
    controls,
    source,
    sections,
    citations,
    sourceSnapshot,
    coreReads,
    baseline,
    copy,
    documents: () => documents,
    versions: () => versions,
    writes: () => writes,
    draft: () => draft,
  };
}

describe('pinned Core brief Workspace copy and atomic history', () => {
  it('mounts private reads and existing TenantGuard, with separate copy/save commands', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, DocumentsController)).toContain(TenantGuard);
    expect(Reflect.getMetadata(PATH_METADATA, DocumentsController.prototype.copyBrief)).toBe(
      'core-brief-copy',
    );
    expect(Reflect.getMetadata(PATH_METADATA, DocumentsController.prototype.saveBriefCopy)).toBe(
      ':docId/brief-copy-save',
    );
    expect(
      Reflect.getMetadata(HEADERS_METADATA, DocumentsController.prototype.briefCopyState),
    ).toContainEqual({ name: 'Cache-Control', value: 'private, no-store' });
  });
  it('copies the selected historical version with escaped text, citations and exact durable association', async () => {
    const f = fixture();
    f.controls.coreCurrentVersionId = nextRequestId;
    const result = await f.copy();
    const d = f.documents()[0];
    expect(result.receipt.source).toEqual(f.source);
    expect(result.receipt.tenantId).toBe(tenantId);
    expect(result.receipt.versionId).toBe(requestId);
    expect(d.sourceBriefVersion).toEqual(f.source);
    expect(d.body.blocks.map((b: any) => b.title)).toEqual(Object.values(briefSectionLabels));
    expect(d.body.blocks[0].content).toContain('&lt;script&gt;');
    expect(d.body.blocks[0].content).not.toContain('<script>');
    expect(f.versions()[0].snapshot.sourceEvidence).toEqual({
      sections: f.sections,
      citations: f.citations,
      sourceSnapshot: f.sourceSnapshot,
    });
    expect(f.draft().isPacket).toBe(false); // One new tab in a previously empty draft.
    expect(f.coreReads.every((args) => args[3] === versionId)).toBe(true);
  });
  it('replays a lost copy response with the original stale baseline and no second write', async () => {
    const f = fixture();
    const initial = (await f.baseline()).stateHash;
    const first = await f.copy({ expectedStateHash: initial });
    const writes = f.writes();
    const second = await f.copy({ expectedStateHash: initial });
    expect(second.replayed).toBe(true);
    expect(second.receipt).toEqual(first.receipt);
    expect(f.writes()).toBe(writes);
    expect(f.documents()).toHaveLength(1);
    expect(f.versions()).toHaveLength(1);
  });
  it('round-trips complete ordered rich fields and creates history atomically without changing Core', async () => {
    const f = fixture();
    const initial = await f.copy();
    const documentId = initial.receipt.documentId;
    const body = {
      blocks: [
        {
          id: 'rich',
          type: 'section',
          content: '<p>Independent edit <b>bold</b></p>',
          marks: [{ from: 0, to: 4 }],
        },
        { id: 'table', type: 'table', table: { rows: [[{ text: 'Cell', marks: ['bold'] }]] } },
        { id: 'photo', type: 'photo', src: 'data:image/png;base64,synthetic', caption: 'Photo' },
      ],
    };
    const input = {
      requestId: nextRequestId,
      expectedClientId: null,
      expectedStateHash: (await f.baseline()).stateHash,
      body,
      docTitle: 'Independent title',
    };
    const result = await saveProspectBriefCopy(
      f.prisma,
      tenantId,
      draftId,
      documentId,
      actorId,
      input,
    );
    const reload = await prospectBriefCopyState(f.prisma, tenantId, draftId, actorId, documentId);
    expect(reload.document?.body).toEqual(body);
    expect(result.receipt.source).toEqual(f.source);
    expect(f.versions()[1].snapshot.documents[0].body).toEqual(body);
    expect(f.versions()[1].snapshot.sourceEvidence.citations).toEqual(f.citations);
    const replay = await saveProspectBriefCopy(
      f.prisma,
      tenantId,
      draftId,
      documentId,
      actorId,
      input,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(result.receipt);
    expect(f.versions()).toHaveLength(2);
    expect(f.sections.companyAndFirmImplication?.text).toContain('<script>');
  });
  it('permits only one of two competing edits against the same baseline', async () => {
    const f = fixture();
    const d = (await f.copy()).receipt.documentId;
    const before = (await f.baseline()).stateHash;
    const save = (id: string, text: string) =>
      saveProspectBriefCopy(f.prisma, tenantId, draftId, d, actorId, {
        requestId: id,
        expectedClientId: null,
        expectedStateHash: before,
        body: { blocks: [{ id: 'edit', type: 'section', content: text }] },
      });
    const results = await Promise.allSettled([
      save(nextRequestId, 'first'),
      save(clientId, 'second'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(f.versions()).toHaveLength(2);
  });
  it('rolls back content and history on interruption, then accepts exactly one explicit retry', async () => {
    const f = fixture();
    const before = (await f.baseline()).stateHash;
    f.controls.interrupt = true;
    await expect(f.copy({ expectedStateHash: before })).rejects.toThrow('Synthetic interruption');
    expect(f.documents()).toHaveLength(0);
    expect(f.versions()).toHaveLength(0);
    expect((await f.baseline()).stateHash).toBe(before);
    f.controls.interrupt = false;
    await f.copy({ expectedStateHash: before });
    expect(f.documents()).toHaveLength(1);
  });
  it('rolls back an interrupted edit and returns an older durable receipt after a later successful edit', async () => {
    const f = fixture();
    const d = (await f.copy()).receipt.documentId;
    const before = (await f.baseline()).stateHash;
    const input = {
      requestId: nextRequestId,
      expectedClientId: null,
      expectedStateHash: before,
      body: { blocks: [{ id: 'edit', type: 'section', content: 'First edit' }] },
    };
    f.controls.interrupt = true;
    await expect(
      saveProspectBriefCopy(f.prisma, tenantId, draftId, d, actorId, input),
    ).rejects.toThrow('Synthetic interruption');
    expect((await f.baseline()).stateHash).toBe(before);
    expect(f.versions()).toHaveLength(1);
    f.controls.interrupt = false;
    const saved = await saveProspectBriefCopy(f.prisma, tenantId, draftId, d, actorId, input);
    await saveProspectBriefCopy(f.prisma, tenantId, draftId, d, actorId, {
      ...input,
      requestId: clientId,
      expectedStateHash: (await f.baseline()).stateHash,
      body: { blocks: [{ id: 'edit', type: 'section', content: 'Later edit' }] },
    });
    const writes = f.writes();
    const replay = await saveProspectBriefCopy(f.prisma, tenantId, draftId, d, actorId, input);
    expect(replay.receipt).toEqual(saved.receipt);
    expect(replay.receipt.stateHash).not.toBe((await f.baseline()).stateHash);
    expect(f.writes()).toBe(writes);
    expect(f.documents()[0].body.blocks[0].content).toBe('Later edit');
  });
  it('makes a UUID collision with another destination a generic conflict and rolls back the inserted tab', async () => {
    const f = fixture();
    f.versions().push({
      id: requestId,
      tenantId: clientId,
      draftId: nextRequestId,
      authorId: 'other',
      snapshot: { private: 'must not leak' },
    });
    await expect(f.copy()).rejects.toMatchObject({
      response: { code: 'WORKSPACE_BRIEF_REQUEST_CONFLICT' },
    });
    expect(f.documents()).toHaveLength(0);
    expect(f.versions()).toHaveLength(1);
    expect(f.writes()).toBe(0);
  });
  it('bounds copied tabs and deduplicates identical source revalidation without limiting ordinary tabs', async () => {
    const f = fixture();
    const first = await f.copy();
    const original = f.documents()[0];
    for (let i = 1; i < 20; i++)
      f.documents().push({
        ...structuredClone(original),
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        ordinal: i,
      });
    f.coreReads.length = 0;
    await f.baseline();
    expect(f.coreReads).toHaveLength(1);
    await expect(f.copy({ requestId: nextRequestId })).rejects.toMatchObject({
      response: { code: 'WORKSPACE_BRIEF_COPY_LIMIT' },
    });
    expect(f.documents()).toHaveLength(20);
    expect(first.receipt.source).toEqual(f.source);
  });
  it.each(['briefFlag', 'prospectFlag', 'member', 'versionExists'] as const)(
    'revoked current %s denies a replay without duplicate mutation',
    async (gate) => {
      const f = fixture();
      const before = (await f.baseline()).stateHash;
      await f.copy({ expectedStateHash: before });
      const writes = f.writes();
      f.controls[gate] = false;
      await expect(f.copy({ expectedStateHash: before })).rejects.toBeInstanceOf(NotFoundException);
      expect(f.writes()).toBe(writes);
    },
  );
  it('denies wrong client and wrong prospect before probing saved version conflicts', async () => {
    const f = fixture();
    f.controls.linkedClientId = clientId;
    const before = (await f.baseline()).stateHash;
    await expect(
      f.copy({ expectedClientId: null, expectedStateHash: before }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      f.copy({ source: { ...f.source, prospectId: nextRequestId }, expectedStateHash: before }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.coreReads).toHaveLength(0);
    expect(f.writes()).toBe(0);
  });
  it('applies the current client wall and denies viewers, including replay', async () => {
    const f = fixture();
    await f.copy();
    f.controls.linkedClientId = clientId;
    f.controls.wall = true;
    f.controls.grant = false;
    await expect(f.baseline()).rejects.toBeInstanceOf(NotFoundException);
    f.controls.grant = true;
    f.draft().ownerId = 'other';
    f.controls.role = 'viewer';
    await expect(f.copy()).rejects.toBeInstanceOf(NotFoundException);
  });
  it('rejects key reuse, foreign root/version IDs and corrupted persisted source hashes', async () => {
    const f = fixture();
    const before = (await f.baseline()).stateHash;
    await f.copy({ expectedStateHash: before });
    await expect(f.copy({ expectedStateHash: 'a'.repeat(64) })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      f.copy({ source: { ...f.source, briefId: nextRequestId } }),
    ).rejects.toBeInstanceOf(NotFoundException);
    f.controls.sourceSections = {
      ...f.sections,
      judgment: { ...f.sections.judgment, text: 'Corrupted' },
    };
    await expect(f.copy()).rejects.toBeInstanceOf(NotFoundException);
  });
  it('conceals a wrong-draft document and never recreates after whole-draft deletion', async () => {
    const f = fixture();
    await f.copy();
    await expect(
      prospectBriefCopyState(f.prisma, tenantId, draftId, actorId, nextRequestId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await f.tx.wsDraft.delete();
    await expect(f.copy()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.documents()).toHaveLength(0);
  });
  it('fences legacy body update/tab removal/restore under the parent lock but allows non-receipt snapshots', async () => {
    const f = fixture();
    const d = (await f.copy()).receipt.documentId;
    const collaborators: any = { assertCan: async () => 'owner' };
    const documents = new DocumentsService(f.prisma, collaborators);
    const versions = new VersionsService(f.prisma, collaborators);
    await expect(
      documents.update(tenantId, draftId, d, actorId, { body: { blocks: [] } }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(documents.remove(tenantId, draftId, d, actorId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      documents.update(tenantId, draftId, d.toUpperCase(), actorId, { body: { blocks: [] } }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(versions.restore(tenantId, draftId, requestId, actorId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const v = await versions.create(tenantId, draftId, actorId, { label: 'Snapshot only' });
    expect((v.snapshot as any).documents[0].sourceBriefVersion).toEqual(f.source);
    expect((v.snapshot as any).atomicBriefSave).toBeUndefined();
  });
  it('merges a legacy prospect config PATCH from the fresh locked state', async () => {
    const f = fixture();
    f.controls.beforeParentLock = () => {
      f.draft().config = { sections: [], concurrent: 'retained' };
    };
    const service = new DraftsService(f.prisma, { assertCan: async () => 'owner' } as any);
    await service.update(tenantId, draftId, actorId, { config: { tone: 'formal' } });
    expect(f.draft().config).toEqual({ sections: [], concurrent: 'retained', tone: 'formal' });
  });
  it('requires explicit nullable client and rejects malformed ordered blocks before persistence', async () => {
    const f = fixture();
    const input: any = { requestId, expectedStateHash: 'a'.repeat(64), source: f.source };
    await expect(
      copyProspectBrief(f.prisma, tenantId, draftId, actorId, input),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(() =>
      validateBriefCopyEdit({
        requestId,
        expectedClientId: null,
        expectedStateHash: 'a'.repeat(64),
        body: {
          blocks: [
            { id: 'x', type: 'section' },
            { id: 'x', type: 'section' },
          ],
        },
      }),
    ).toThrow(BadRequestException);
    expect(f.writes()).toBe(0);
  });
});
