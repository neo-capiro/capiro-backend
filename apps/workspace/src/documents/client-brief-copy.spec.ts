import { BadRequestException } from '@nestjs/common';
import {
  copyBriefToClient,
  readClientBriefCopy,
  parseClientBriefCopy,
} from './client-brief-copy.js';
import { briefSectionLabels, stateHash } from './prospect-brief-copy-contract.js';
import { DraftsService } from '../drafts/drafts.service.js';
import { denyProspectTransfer } from '../prospect-resources/prospect-draft-access.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1),
  prospect = id(2),
  client = id(3),
  actor = 'synthetic-brief-owner',
  timestamp = '2026-10-25T00:00:00.000Z';
type Row = Record<string, any>;
function harness() {
  const sections = Object.fromEntries(
    Object.keys(briefSectionLabels).map((key) => [
      key,
      { text: `${key}: <b>Reviewed</b>`, provenance: 'edited', citationIndexes: [0] },
    ]),
  );
  const sourceSnapshot = { evidence: [{ id: 'synthetic-record' }] },
    citations = [{ recordId: 'synthetic-record', title: 'Reviewed source' }];
  const source = {
    kind: 'core_prospect_brief_version',
    prospectId: prospect,
    briefId: id(4),
    versionId: id(5),
    versionNumber: 1,
    sectionsHash: stateHash(sections),
    snapshotHash: stateHash(sourceSnapshot),
  };
  const input = () => ({
    schemaVersion: 1,
    requestId: id(6),
    prospectId: prospect,
    clientId: client,
    expectedProspectUpdatedAt: timestamp,
    docTitle: 'Reviewed client brief',
    source,
  });
  const state = {
    drafts: [] as Row[],
    documents: [] as Row[],
    contexts: [] as Row[],
    versions: [] as Row[],
    receipts: new Map<string, Row>(),
  };
  const controls = {
    member: true,
    feature: true,
    briefFeature: true,
    client: true,
    wall: false,
    grant: true,
    prospect: true,
    linked: client,
    converted: true,
    time: timestamp,
    sourcePresent: true,
    hashValid: true,
    failVersion: false,
    failReceipt: false,
    lostResponse: false,
  };
  const key = (t: string, a: string, k: string) => JSON.stringify([t, a, k]);
  const tx: any = {
    $queryRaw: async (parts: TemplateStringsArray, ...v: any[]) => {
      const sql = parts.join('?');
      if (sql.includes('pg_advisory')) {
        expect(sql).toContain('::text');
        return [];
      }
      if (sql.includes('FROM business_development_prospects'))
        return controls.prospect && v[0] === tenant && v[1] === prospect
          ? [
              {
                updatedAt: new Date(controls.time),
                linkedClientId: controls.linked,
                convertedAt: controls.converted ? new Date(timestamp) : null,
              },
            ]
          : [];
      if (sql.includes('FROM users u JOIN tenant_memberships'))
        return controls.member && v[0] === tenant && v[1] === actor ? [{ id: id(7) }] : [];
      if (sql.includes('FROM clients'))
        return controls.client && v[0] === tenant && v[1] === client
          ? [{ id: client, name: 'Synthetic client' }]
          : [];
      if (sql.includes('FROM ws_source_action')) {
        const saved = state.receipts.get(key(v[0], v[1], v[2]));
        return saved ? [structuredClone(saved)] : [];
      }
      throw Error(`Unexpected synthetic read ${sql}`);
    },
    $queryRawUnsafe: async (sql: string, ...v: any[]) => {
      if (sql.includes('FROM business_development_prospects'))
        return controls.prospect
          ? [{ linkedClientId: controls.linked, status: 'active', dismissedAt: null }]
          : [];
      if (sql.includes('FROM tenants'))
        return [
          {
            settings: {
              clioFeatureFlags: {
                'businessDevelopment.enabled': controls.feature,
                'businessDevelopment.brief.enabled': controls.briefFeature,
              },
            },
          },
        ];
      if (sql.includes('FROM tenant_memberships'))
        return controls.member && v[2] === actor ? [{ userId: id(7), clerkUserId: actor }] : [];
      if (sql.includes('SELECT (NOT c.memory_wall'))
        return [{ allowed: !controls.wall || controls.grant }];
      if (sql.includes('FROM client_memory_access')) return controls.grant ? [{ id: id(8) }] : [];
      if (sql.includes('FROM clients'))
        return controls.client ? [{ status: 'active', memoryWall: controls.wall }] : [];
      if (sql.includes('set_config')) return [];
      if (sql.includes('FROM business_development_briefs')) {
        expect(v).toEqual([tenant, prospect, source.briefId, source.versionId, 1]);
        return controls.sourcePresent
          ? [
              {
                sections,
                citations,
                sourceSnapshot,
                sectionsHash: controls.hashValid ? source.sectionsHash : '0'.repeat(64),
                snapshotHash: source.snapshotHash,
              },
            ]
          : [];
      }
      throw Error(`Unexpected synthetic source query ${sql}`);
    },
    $executeRaw: async (parts: TemplateStringsArray, ...v: any[]) => {
      const sql = parts.join('?');
      if (sql.includes('set_config')) return 1;
      if (sql.includes('INSERT INTO ws_source_action')) {
        if (controls.failReceipt) throw Error('receipt insert failed');
        state.receipts.set(key(v[0], v[1], v[2]), {
          inputHash: v[3],
          draftId: v[4],
          contextItemId: v[5],
          createdAt: new Date(timestamp),
        });
        return 1;
      }
      throw Error(`Unexpected synthetic write ${sql}`);
    },
    wsDraft: {
      create: async ({ data }: Row) => {
        const draft = { ...data, id: id(20 + state.drafts.length), status: 'draft' };
        state.drafts.push(draft);
        return structuredClone(draft);
      },
      findFirstOrThrow: async ({ where }: Row) => {
        const draft = state.drafts.find((d) => d.id === where.id && d.tenantId === where.tenantId);
        if (!draft) throw Error('missing draft');
        return {
          ...structuredClone(draft),
          documents: structuredClone(state.documents.filter((d) => d.draftId === draft.id)),
        };
      },
      findFirst: async ({ where }: Row) =>
        state.drafts.find((d) => Object.entries(where).every(([k, v]) => d[k] === v)) ?? null,
    },
    wsDocument: {
      create: async ({ data }: Row) => {
        const doc = { ...data, id: id(40 + state.documents.length), sourceBriefVersion: null };
        state.documents.push(doc);
        return structuredClone(doc);
      },
      update: async ({ where, data }: Row) => {
        const doc = state.documents.find((d) =>
          Object.entries(where).every(([k, v]) => d[k] === v),
        );
        if (!doc) throw Error('foreign document');
        Object.assign(doc, data);
        return structuredClone(doc);
      },
    },
    wsContextItem: {
      create: async ({ data }: Row) => {
        const item = { ...data, id: id(60 + state.contexts.length) };
        state.contexts.push(item);
        return structuredClone(item);
      },
    },
    wsDocVersion: {
      create: async ({ data }: Row) => {
        if (controls.failVersion) throw Error('version insert failed');
        const version = { ...data, id: id(80 + state.versions.length) };
        state.versions.push(version);
        return structuredClone(version);
      },
    },
  };
  const prisma: any = {
    withSystem: (run: (t: any) => unknown) => run(tx),
    $transaction: async (run: (t: any) => Promise<unknown>) => {
      const before = structuredClone(state);
      let result;
      try {
        result = await run(tx);
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
      if (controls.lostResponse) {
        controls.lostResponse = false;
        throw Error('commit response lost');
      }
      return result;
    },
  };
  const drafts = new DraftsService(prisma, {} as never);
  return {
    state,
    controls,
    input,
    source,
    save: (raw: unknown = input()) =>
      copyBriefToClient(prisma, drafts, tenant, actor, prospect, client, raw),
    read: (t = tenant, a = actor, p = prospect, c = client) =>
      readClientBriefCopy(prisma, t, a, p, c, id(6)),
  };
}

test('uses the real Drafts owner to create one private client draft with independent body/context and exact initial evidence', async () => {
  const h = harness(),
    result = await h.save();
  expect(result).toMatchObject({
    status: 'completed',
    operation: 'copy_core_brief_to_client',
    prospectId: prospect,
    clientId: client,
    actorId: actor,
    available: true,
  });
  expect(h.state.drafts).toHaveLength(1);
  expect(h.state.documents).toHaveLength(1);
  expect(h.state.drafts[0]).toMatchObject({
    tenantId: tenant,
    ownerId: actor,
    prospectId: null,
    clientId: client,
    status: 'draft',
    docCount: 1,
    isPacket: false,
    config: { clientId: client, clientAssociated: false, clientPersons: [], linkedData: [] },
  });
  expect(h.state.documents[0]!.sourceBriefVersion).toBeNull();
  expect(h.state.documents[0]!.body.blocks[0].content).toContain('&lt;b&gt;Reviewed&lt;/b&gt;');
  expect(h.state.contexts[0]).toMatchObject({
    kind: 'free-text',
    payload: { text: expect.stringContaining('Reviewed') },
  });
  expect(h.state.versions[0]!.snapshot).toMatchObject({
    clientId: client,
    privateClientBriefCopy: { source: h.source },
    sourceEvidence: { sections: expect.any(Object), citations: expect.any(Array) },
  });
  expect(await h.read()).toEqual(result);
});
test('retry returns the original receipt without re-copying a later edited body', async () => {
  const h = harness(),
    first = await h.save();
  h.state.documents[0]!.body = { blocks: [{ id: 'edited', type: 'section', content: 'Later' }] };
  expect(await h.save()).toEqual(first);
  expect(h.state.documents[0]!.body.blocks[0].content).toBe('Later');
  expect(h.state.versions).toHaveLength(1);
  await expect(h.save({ ...h.input(), docTitle: 'Changed command' })).rejects.toMatchObject({
    status: 409,
  });
});
test('deleted draft remains consumed and cannot be resurrected; source deletion does not falsify history', async () => {
  const h = harness();
  await h.save();
  h.state.drafts = [];
  h.state.documents = [];
  h.state.contexts = [];
  h.state.versions = [];
  h.controls.sourcePresent = false;
  expect(await h.save()).toMatchObject({ status: 'completed', available: false });
  expect(await h.read()).toMatchObject({ status: 'completed', available: false });
  expect(h.state.drafts).toHaveLength(0);
});
test('lost commit acknowledgement recovers the same private draft and initial version', async () => {
  const h = harness();
  h.controls.lostResponse = true;
  await expect(h.save()).rejects.toThrow('response lost');
  expect(await h.save()).toEqual(await h.read());
  expect(h.state.drafts).toHaveLength(1);
  expect(h.state.versions).toHaveLength(1);
});
test.each(['failVersion', 'failReceipt'])(
  'rolls back draft, document, context and version on %s',
  async (field) => {
    const h = harness();
    (h.controls as Row)[field] = true;
    await expect(h.save()).rejects.toThrow();
    for (const rows of [h.state.drafts, h.state.documents, h.state.contexts, h.state.versions])
      expect(rows).toEqual([]);
    expect(h.state.receipts.size).toBe(0);
  },
);
test.each([
  'member',
  'feature',
  'briefFeature',
  'client',
  'prospect',
  'converted',
  'sourcePresent',
  'hashValid',
])('denies current %s before destination writes', async (field) => {
  const h = harness();
  (h.controls as Row)[field] = false;
  await expect(h.save()).rejects.toMatchObject({ status: 404 });
  expect(h.state.drafts).toHaveLength(0);
});
test('requires the reviewed prospect timestamp and linked client', async () => {
  const h = harness();
  h.controls.time = '2026-10-25T01:00:00.000Z';
  await expect(h.save()).rejects.toMatchObject({ status: 409 });
  h.controls.time = timestamp;
  h.controls.linked = id(100);
  await expect(h.save()).rejects.toMatchObject({ status: 404 });
  expect(h.state.drafts).toHaveLength(0);
});
test('historical lookup still checks current tenant, actor, client and wall', async () => {
  const h = harness();
  await h.save();
  await expect(h.read(id(101))).rejects.toMatchObject({ status: 404 });
  await expect(h.read(tenant, 'different-actor')).rejects.toMatchObject({ status: 404 });
  await expect(h.read(tenant, actor, prospect, id(102))).rejects.toMatchObject({ status: 404 });
  h.controls.wall = true;
  h.controls.grant = false;
  await expect(h.read()).rejects.toMatchObject({ status: 404 });
});
test('ordinary prospect-origin transfer denial remains intact', () => {
  expect(() => denyProspectTransfer({ prospectId: prospect })).toThrow();
  expect(() => denyProspectTransfer({ prospectId: null })).not.toThrow();
});
test.each([
  { extra: true },
  { clientId: id(100) },
  { prospectId: id(101) },
  { requestId: 'bad' },
  { schemaVersion: 2 },
  { docTitle: '' },
  { expectedProspectUpdatedAt: '2026-10-25' },
])('strict input rejects unreviewed command shape %#', (patch) => {
  const h = harness();
  expect(() => parseClientBriefCopy(prospect, client, { ...h.input(), ...patch })).toThrow(
    BadRequestException,
  );
});
