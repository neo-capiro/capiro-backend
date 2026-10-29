import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import request from 'supertest';
import type { DraftsService } from '../src/drafts/drafts.service.js';
const repoRoot = resolve(__dirname, '../../..');
const helper = require(join(repoRoot, 'scripts/testing/a1-disposable-postgres.cjs'));
const readiness = helper.nativePostgresReadiness({ repoRoot });
const native = readiness.available ? describe : describe.skip;
type Runtime = typeof import('./support/ws03-postgres-harness.js');
type Harness = Awaited<ReturnType<Runtime['createNativeWorkspaceHarness']>>;

native(`prospect atomic save PostgreSQL [${readiness.reason}]`, () => {
  let database: { url: string; cleanup(): Promise<void> },
    h: Harness,
    runtime: Runtime,
    service: DraftsService;
  const prospectId = '00000000-0000-4000-8000-000000000080';
  const requestId = '00000000-0000-4000-8000-000000000090';
  const userId = '00000000-0000-4000-8000-000000000020';
  beforeAll(async () => {
    database = await helper.createDisposableSchema({
      repoRoot,
      coreSchemaPath: join(__dirname, 'support/workspace-identity.fixture.prisma'),
      workspaceSchemaPath: join(repoRoot, 'apps/workspace/prisma/schema.prisma'),
      extraModels: await readFile(
        join(__dirname, 'support/ws-source-action.fixture.prisma'),
        'utf8',
      ),
    });
    runtime = require('./support/ws03-postgres-harness.js');
    h = await runtime.createNativeWorkspaceHarness(database.url);
    const { DraftsService } = require('../src/drafts/drafts.service.js');
    service = h.app.get(DraftsService);
    await h.db.$executeRawUnsafe(
      'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
      JSON.stringify({ clioFeatureFlags: { 'businessDevelopment.enabled': true } }),
      runtime.WS03_IDS.tenantId,
    );
    await h.db.$executeRawUnsafe(
      'INSERT INTO business_development_prospects (id,tenant_id,display_name,updated_at) VALUES ($1::uuid,$2::uuid,$3,now())',
      prospectId,
      runtime.WS03_IDS.tenantId,
      'Synthetic prospect',
    );
  }, 240000);
  afterAll(async () => {
    try {
      await h?.close();
    } finally {
      await database?.cleanup();
    }
  }, 60000);
  beforeEach(async () => {
    await h.reset();
    await h.db.wsDraft.update({ where: { id: runtime.WS03_IDS.draftId }, data: { prospectId } });
    await h.db.$executeRawUnsafe(
      "UPDATE business_development_prospects SET status='active',dismissed_at=NULL WHERE id=$1::uuid",
      prospectId,
    );
    await h.db.$executeRawUnsafe(
      "UPDATE tenant_memberships SET status='active' WHERE tenant_id=$1::uuid",
      runtime.WS03_IDS.tenantId,
    );
  });
  const state = () =>
    service.prospectState(
      runtime.WS03_IDS.tenantId,
      runtime.WS03_IDS.draftId,
      'user_owner',
      prospectId,
    );
  const save = (input: any) =>
    service.saveProspect(runtime.WS03_IDS.tenantId, runtime.WS03_IDS.draftId, 'user_owner', input);
  async function input() {
    return {
      requestId,
      expectedProspectId: prospectId,
      expectedStateHash: (await state()).stateHash,
      title: 'Reviewed prospect proposal',
      names: ['Scope'],
      sections: { Scope: 'Only the exact reviewed text.' },
    };
  }
  it('commits content and one version atomically; concurrent duplicate requests recover one receipt', async () => {
    const body = await input(),
      outcomes = await Promise.all([save(body), save(body)]);
    expect(outcomes.map((v) => v.replayed).sort()).toEqual([false, true]);
    expect(outcomes[0]!.receipt).toEqual(outcomes[1]!.receipt);
    expect(outcomes[0]!.receipt).toMatchObject({
      operation: 'save_prospect_draft',
      prospectId,
      requestId,
      versionId: requestId,
    });
    const after = await h.snapshot();
    expect(after.versions).toHaveLength(2);
    expect(after.drafts[0]!.config).toMatchObject({ sectionContent: body.sections });
    expect(after.versions.find((v) => v.id === requestId)?.snapshot).toMatchObject({
      prospectId,
      docTitle: body.title,
      config: { sectionContent: body.sections },
    });
  });
  it('refuses competing stale edits and replays the original after newer saves without overwriting', async () => {
    const first = await input(),
      other = { ...first, requestId: '00000000-0000-4000-8000-000000000091', title: 'Competing' };
    const results = await Promise.allSettled([save(first), save(other)]);
    expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((v) => v.status === 'rejected') as PromiseRejectedResult).reason.getStatus(),
    ).toBe(409);
    const accepted = results[0]!.status === 'fulfilled' ? first : other;
    const later = {
      ...(await input()),
      requestId: '00000000-0000-4000-8000-000000000092',
      title: 'Newer',
    };
    await save(later);
    expect((await save(accepted)).replayed).toBe(true);
    expect((await state()).draft.docTitle).toBe('Newer');
    await expect(save({ ...accepted, title: 'Changed receipt' })).rejects.toMatchObject({
      status: 409,
    });
  });
  it('rolls back content when version persistence fails and allows an exact retry', async () => {
    const body = await input(),
      before = await h.snapshot();
    await h.db.$executeRawUnsafe(
      "ALTER TABLE ws_doc_version ADD CONSTRAINT prospect_test_reject CHECK (label IS DISTINCT FROM 'Manual save')",
    );
    try {
      await expect(save(body)).rejects.toThrow();
      expect(await h.snapshot()).toEqual(before);
    } finally {
      await h.db.$executeRawUnsafe(
        'ALTER TABLE ws_doc_version DROP CONSTRAINT prospect_test_reject',
      );
    }
    expect((await save(body)).replayed).toBe(false);
  });
  it('rechecks current membership before replay or reading', async () => {
    const body = await input();
    await save(body);
    await h.db.$executeRawUnsafe(
      "UPDATE tenant_memberships SET status='removed' WHERE user_id=$1::uuid",
      userId,
    );
    await expect(save(body)).rejects.toMatchObject({ status: 404 });
    await expect(state()).rejects.toMatchObject({ status: 404 });
  });
  it('keeps archived history readable and refuses edits, ordinary substitution and foreign prospects', async () => {
    const body = await input();
    await h.db.$executeRawUnsafe(
      "UPDATE business_development_prospects SET status='archived' WHERE id=$1::uuid",
      prospectId,
    );
    expect((await state()).prospectId).toBe(prospectId);
    await expect(save(body)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.currentState(runtime.WS03_IDS.tenantId, runtime.WS03_IDS.draftId, 'user_owner'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.prospectState(
        runtime.WS03_IDS.tenantId,
        runtime.WS03_IDS.draftId,
        'user_owner',
        '00000000-0000-4000-8000-000000000099',
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.prospectState(
        runtime.WS03_IDS.tenantId,
        runtime.WS03_IDS.draftId,
        'user_unrelated',
        prospectId,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('preserves ordinary draft saves through the same snapshot owner', async () => {
    await h.db.wsDraft.update({
      where: { id: runtime.WS03_IDS.draftId },
      data: { prospectId: null },
    });
    const current = await service.currentState(
      runtime.WS03_IDS.tenantId,
      runtime.WS03_IDS.draftId,
      'user_owner',
    );
    const body = {
      requestId,
      expectedStateHash: current.stateHash,
      expectedClientId: null,
      draft: { docTitle: 'Ordinary saved title' },
    };
    const accepted = await service.save(
      runtime.WS03_IDS.tenantId,
      runtime.WS03_IDS.draftId,
      'user_owner',
      body,
    );
    expect(accepted.receipt.operation).toBe('save_ordinary_draft');
    expect(accepted.receipt.prospectId).toBeUndefined();
    expect(
      (await service.save(runtime.WS03_IDS.tenantId, runtime.WS03_IDS.draftId, 'user_owner', body))
        .receipt,
    ).toEqual(accepted.receipt);
  });
  it('mounts no-store state and atomic-save routes and refuses legacy patch or extra provenance fields', async () => {
    const path = '/workspace-api/drafts/' + runtime.WS03_IDS.draftId;
    const auth = 'Bearer ' + runtime.NATIVE_TOKEN;
    await request(h.app.getHttpServer())
      .get(path + '/prospect-state?prospectId=' + prospectId)
      .set('authorization', auth)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    const body = await input();
    await request(h.app.getHttpServer())
      .post(path + '/prospect-save')
      .set('authorization', auth)
      .send({ ...body, clientId: prospectId })
      .expect(400);
    await request(h.app.getHttpServer())
      .patch(path)
      .set('authorization', auth)
      .send({ docTitle: 'Stale legacy overwrite' })
      .expect(409);
    await request(h.app.getHttpServer())
      .post(path + '/prospect-save')
      .set('authorization', auth)
      .send(body)
      .expect(201);
  });
});
