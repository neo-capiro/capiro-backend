import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { DraftsService } from '../src/drafts/drafts.service.js';

const repoRoot = resolve(__dirname, '../../..');
const helper = require(join(repoRoot, 'scripts/testing/a1-disposable-postgres.cjs'));
const readiness = helper.nativePostgresReadiness({ repoRoot });
const native = readiness.available ? describe : describe.skip;
type Runtime = typeof import('./support/ws03-postgres-harness.js');
type Harness = Awaited<ReturnType<Runtime['createNativeWorkspaceHarness']>>;

native(`ordinary atomic save PostgreSQL16 [${readiness.reason}]`, () => {
  let database: { url: string; cleanup(): Promise<void> };
  let h: Harness;
  let runtime: Runtime;
  let service: DraftsService;
  const requestId = '00000000-0000-4000-8000-000000000090';
  beforeAll(async () => {
    database = await helper.createDisposableSchema({ repoRoot,
      coreSchemaPath: join(repoRoot, 'apps/api/prisma/schema.prisma'),
      workspaceSchemaPath: join(repoRoot, 'apps/workspace/prisma/schema.prisma'),
      extraModels: await readFile(join(__dirname, 'support/ws-source-action.fixture.prisma'), 'utf8'),
    });
    runtime = require('./support/ws03-postgres-harness.js');
    h = await runtime.createNativeWorkspaceHarness(database.url);
    const { DraftsService } = require('../src/drafts/drafts.service.js');
    service = h.app.get(DraftsService);
  }, 240_000);
  afterAll(async () => { try { await h?.close(); } finally { await database?.cleanup(); } }, 60_000);
  beforeEach(async () => { await h.reset(); });

  async function request() {
    const { tenantId, draftId, documentId } = runtime.WS03_IDS;
    const current = await service.currentState(tenantId, draftId, 'user_owner');
    return { requestId, expectedStateHash: current.stateHash, expectedClientId: null,
      draft: { docTitle: 'Submitted title' },
      documents: [{ id: documentId, body: { blocks: [{ content: 'Submitted body' }] } }],
    };
  }
  const save = (input: Awaited<ReturnType<typeof request>>) => service.save(
    runtime.WS03_IDS.tenantId, runtime.WS03_IDS.draftId, 'user_owner', input,
  );
  it('mounts the authenticated save route and requires an explicit client baseline', async () => {
    const input = await request();
    const origin = await h.app.getUrl();
    const post = (body: object) => new Promise<{ status: number; body: any }>((resolveResponse, reject) => {
      const req = httpRequest(`${origin}/workspace-api/drafts/${runtime.WS03_IDS.draftId}/save`, {
        method: 'POST', headers: { authorization: `Bearer ${runtime.NATIVE_TOKEN}`, 'content-type': 'application/json' },
      }, response => {
        let data = ''; response.setEncoding('utf8'); response.on('data', chunk => { data += chunk; });
        response.on('end', () => resolveResponse({ status: response.statusCode!, body: JSON.parse(data) }));
      });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
    const { expectedClientId, ...incomplete } = input;
    expect((await post(incomplete)).status).toBe(400);
    const accepted = await post(input);
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ replayed: false, receipt: { requestId } });
    expect((await post(input)).body).toEqual({ ...accepted.body, replayed: true });
  });
  it('serializes two different saves from one baseline and retains one new snapshot', async () => {
    const input = await request();
    const competing = { ...input, requestId: '00000000-0000-4000-8000-000000000091',
      draft: { docTitle: 'Competing title' } };
    const outcomes = await Promise.allSettled([save(input), save(competing)]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.getStatus()).toBe(409);
    const state = await h.snapshot();
    expect(state.versions).toHaveLength(2); // one seeded version, one accepted save
    const saved = state.versions.find(v => v.id !== runtime.WS03_IDS.versionId)!;
    expect(saved.snapshot).toMatchObject({ docTitle: state.drafts[0]!.docTitle,
      documents: [{ body: state.documents[0]!.body }] });
  });
  it('recovers the same committed receipt across concurrent requests and later edits', async () => {
    const input = await request();
    const outcomes = await Promise.all([save(input), save(input)]);
    expect(outcomes.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(outcomes[0]!.receipt).toEqual(outcomes[1]!.receipt);
    await service.update(runtime.WS03_IDS.tenantId, runtime.WS03_IDS.draftId, 'user_owner', { docTitle: 'Later title' });
    expect((await save(input)).receipt).toEqual(outcomes[0]!.receipt);
    const state = await h.snapshot();
    expect(state.drafts[0]!.docTitle).toBe('Later title');
    expect(state.versions).toHaveLength(2);
  });
  it('rolls back title and body when PostgreSQL refuses the snapshot, then permits exact retry', async () => {
    const input = await request();
    const before = await h.snapshot();
    await h.db.$executeRawUnsafe("ALTER TABLE ws_doc_version ADD CONSTRAINT wave3_test_reject CHECK (label IS DISTINCT FROM 'reject-native-save')");
    try {
      await expect(save({ ...input, label: 'reject-native-save' } as typeof input)).rejects.toThrow();
      expect(await h.snapshot()).toEqual(before);
    } finally {
      await h.db.$executeRawUnsafe('ALTER TABLE ws_doc_version DROP CONSTRAINT wave3_test_reject');
    }
    await expect(save(input)).resolves.toMatchObject({ replayed: false });
  });
});
