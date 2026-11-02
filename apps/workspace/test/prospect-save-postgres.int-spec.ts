import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import request from 'supertest';
import type { DraftsService } from '../src/drafts/drafts.service.js';
import { TemplateValidator } from '../src/template-studio/template-validator.js';
import { ProspectPublicationService } from '../src/versions/prospect-publication.service.js';
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
    const immutableMigration = await readFile(
      join(
        repoRoot,
        'apps/workspace/prisma/migrations/20261012040000_saved_version_immutability/migration.sql',
      ),
      'utf8',
    );
    const triggerAt = immutableMigration.indexOf('CREATE TRIGGER');
    await h.db.$executeRawUnsafe(immutableMigration.slice(0, triggerAt));
    await h.db.$executeRawUnsafe(immutableMigration.slice(triggerAt));
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
    await h.db.wsProspectDraftReceipt.deleteMany({});
    await h.db.wsBlueprintVersion.deleteMany({});
    await h.db.wsBlueprint.deleteMany({});
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

  async function publicationInput() {
    const saved = await save(await input());
    return {
      requestId: '00000000-0000-4000-8000-000000000091',
      expectedProspectId: prospectId,
      expectedStateHash: saved.receipt.stateHash,
      sourceVersionId: saved.receipt.versionId,
      sourceSnapshotHash: saved.receipt.snapshotHash,
      expectedPublicationId: null as string | null,
    };
  }
  const publication = () => h.app.get(ProspectPublicationService);
  const publish = (body: Awaited<ReturnType<typeof publicationInput>>) =>
    publication().publish(runtime.WS03_IDS.tenantId, runtime.WS03_IDS.draftId, 'user_owner', body);
  const publicationState = () =>
    publication().read(
      runtime.WS03_IDS.tenantId,
      runtime.WS03_IDS.draftId,
      prospectId,
      'user_owner',
    );

  it('publishes the exact saved revision, preserves working content and recovers the original receipt', async () => {
    const body = await publicationInput(),
      before = await state();
    const first = await publish(body);
    expect(first.receipt.sourceVersionId).toBe(body.sourceVersionId);
    expect(first.receipt.sourceSnapshotHash).toBe(body.sourceSnapshotHash);
    expect(first.receipt.actorId).toBe('user_owner');
    expect((await state()).stateHash).toBe(before.stateHash);
    const source = await h.db.wsDocVersion.findUniqueOrThrow({
      where: { id: body.sourceVersionId },
    });
    const published = await h.db.wsDocVersion.findUniqueOrThrow({
      where: { id: first.receipt.versionId },
    });
    const { prospectPublication, ...bytes } = published.snapshot as Record<string, unknown>;
    expect(bytes).toEqual(source.snapshot);
    await expect(
      h.db.wsDocVersion.update({ where: { id: published.id }, data: { label: 'Overwritten' } }),
    ).rejects.toThrow();
    expect((await publish(body)).receipt).toEqual(first.receipt);
    expect((await publicationState()).current).toEqual(first.receipt);
    // Later edits leave the published revision untouched; an exact retry still
    // recovers its original receipt without accidentally publishing later bytes.
    await save({
      ...(await input()),
      requestId: '00000000-0000-4000-8000-000000000092',
      title: 'Later working draft',
    });
    expect((await publish(body)).receipt).toEqual(first.receipt);
    expect((await publicationState()).current).toEqual(first.receipt);
    await expect(publish({ ...body, sourceSnapshotHash: 'f'.repeat(64) })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('serializes racing publishers and refuses stale draft or fabricated source versions', async () => {
    const body = await publicationInput();
    await expect(publish({ ...body, sourceSnapshotHash: 'f'.repeat(64) })).rejects.toMatchObject({
      status: 409,
    });
    const results = await Promise.allSettled([
      publish(body),
      publish({ ...body, requestId: '00000000-0000-4000-8000-000000000093' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const current = (await publicationState()).current!;
    const next = {
      ...body,
      requestId: '00000000-0000-4000-8000-000000000094',
      expectedPublicationId: current.versionId,
    };
    await save({
      ...(await input()),
      requestId: '00000000-0000-4000-8000-000000000095',
      title: 'Changed before publish',
    });
    await expect(publish(next)).rejects.toMatchObject({ status: 409 });
    expect((await publicationState()).current?.versionId).toBe(current.versionId);
  });

  it('rechecks access on publication, replay and history while allowing archived read only', async () => {
    const body = await publicationInput();
    await publish(body);
    await h.db.$executeRawUnsafe(
      "UPDATE business_development_prospects SET status='archived' WHERE id=$1::uuid",
      prospectId,
    );
    expect((await publicationState()).current?.versionId).toBe(body.requestId);
    await expect(publish(body)).rejects.toMatchObject({ status: 404 });
    await h.db.$executeRawUnsafe(
      "UPDATE tenant_memberships SET status='removed' WHERE user_id=$1::uuid",
      userId,
    );
    await expect(publicationState()).rejects.toMatchObject({ status: 404 });
    await expect(publish(body)).rejects.toMatchObject({ status: 404 });
  });

  it('mounts publication independently of save and rejects client substitution and missing prior-version pins', async () => {
    const body = await publicationInput();
    const path = '/workspace-api/drafts/' + runtime.WS03_IDS.draftId + '/prospect-publication';
    const auth = 'Bearer ' + runtime.NATIVE_TOKEN;
    await request(h.app.getHttpServer())
      .get(path + '?prospectId=' + prospectId)
      .set('authorization', auth)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    await request(h.app.getHttpServer())
      .post(path)
      .set('authorization', auth)
      .send({ ...body, clientId: prospectId })
      .expect(400);
    const { expectedPublicationId, ...missing } = body;
    await request(h.app.getHttpServer())
      .post(path)
      .set('authorization', auth)
      .send(missing)
      .expect(400);
    await request(h.app.getHttpServer())
      .post(path)
      .set('authorization', auth)
      .send(body)
      .expect(201)
      .expect('Cache-Control', 'no-store');
  });
  async function template(tenantId: string | null = runtime.WS03_IDS.tenantId) {
    const definition = {
      schemaVersion: 1 as const,
      documentType: { id: 'proposal', label: 'Proposal', product: 'Proposal' },
      intakeQuestions: [],
      sections: ['Overview', 'Overview'].map((title, i) => ({
        id: `section-${i}`,
        title,
        purpose: 'Describe the proposed work',
        instructions: 'Use verified evidence',
        required: true,
        removable: false,
        reorderable: false,
        lockedByDefault: false,
        targetWords: { min: 0, max: 200 },
        evidenceRules: [],
      })),
      evidencePolicy: {
        minimumSources: 0,
        primarySourcesPreferred: false,
        citationRequiredFor: [],
        freshnessRules: [],
      },
      contentRules: {
        requiredTerms: [],
        prohibitedTerms: [],
        requiredDisclaimers: [],
        instructions: [],
      },
      defaultTheme: { id: 'default', name: 'Default', settings: {} },
    };
    const blueprint = await h.db.wsBlueprint.create({
      data: {
        tenantId,
        scope: tenantId ? 'firm' : 'capiro',
        slug: 'proposal',
        name: 'Proposal',
        product: 'Proposal',
      },
    });
    const version = await h.db.wsBlueprintVersion.create({
      data: {
        tenantId,
        blueprintId: blueprint.id,
        version: 1,
        status: 'published',
        definition,
        definitionHash: new TemplateValidator().computeDefinitionHash(definition),
        createdById: 'user_owner',
        publishedAt: new Date(),
      },
    });
    return {
      blueprintId: blueprint.id,
      versionId: version.id,
      version: 1,
      definitionHash: version.definitionHash,
    };
  }
  it('creates and recovers one exact template-bound prospect draft and preserves its pin through atomic save', async () => {
    const pin = await template(),
      body = { requestId, prospectId, docTitle: 'Pinned proposal', blueprintPin: pin };
    const create = () => service.create(runtime.WS03_IDS.tenantId, 'user_owner', body);
    const [first, replay] = await Promise.all([create(), create()]);
    expect(first.id).toBe(replay.id);
    expect(first.config).toMatchObject({
      documentAgent: { blueprintPin: pin },
      sections: ['1. Overview', '2. Overview'],
      sectionContent: { '1. Overview': '', '2. Overview': '' },
    });
    expect(await h.db.wsProspectDraftReceipt.count()).toBe(1);
    const baseline = await service.prospectState(
      runtime.WS03_IDS.tenantId,
      first.id,
      'user_owner',
      prospectId,
    );
    await service.saveProspect(runtime.WS03_IDS.tenantId, first.id, 'user_owner', {
      requestId: '00000000-0000-4000-8000-000000000093',
      expectedProspectId: prospectId,
      expectedStateHash: baseline.stateHash,
      title: 'Edited proposal',
      names: ['1. Overview', '2. Overview'],
      sections: { '1. Overview': 'User-authored content', '2. Overview': '' },
    });
    const saved = await h.db.wsDocVersion.findFirstOrThrow({ where: { draftId: first.id } });
    expect(saved.snapshot).toMatchObject({
      prospectId,
      config: { documentAgent: { blueprintPin: pin } },
    });
    await h.db.wsBlueprintVersion.update({
      where: { id: pin.versionId },
      data: { status: 'retired', retiredAt: new Date() },
    });
    expect((await create()).id).toBe(first.id);
    await expect(
      service.create(runtime.WS03_IDS.tenantId, 'user_owner', {
        ...body,
        requestId: '00000000-0000-4000-8000-000000000094',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.create(runtime.WS03_IDS.tenantId, 'user_owner', {
        ...body,
        blueprintPin: { ...pin, version: 2 },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('refuses foreign, corrupt and unpublished templates without persisting a draft or receipt', async () => {
    const pin = await template('00000000-0000-4000-8000-000000000099');
    const body = { requestId, prospectId, docTitle: 'Foreign template', blueprintPin: pin };
    await expect(
      service.create(runtime.WS03_IDS.tenantId, 'user_owner', body),
    ).rejects.toMatchObject({ status: 404 });
    await h.db.wsBlueprint.update({
      where: { id: pin.blueprintId },
      data: { tenantId: runtime.WS03_IDS.tenantId },
    });
    await h.db.wsBlueprintVersion.update({
      where: { id: pin.versionId },
      data: { status: 'draft' },
    });
    await expect(
      service.create(runtime.WS03_IDS.tenantId, 'user_owner', body),
    ).rejects.toMatchObject({ status: 409 });
    await h.db.wsBlueprintVersion.update({
      where: { id: pin.versionId },
      data: { status: 'published', definition: {} },
    });
    await expect(
      service.create(runtime.WS03_IDS.tenantId, 'user_owner', body),
    ).rejects.toMatchObject({ status: 409 });
    expect(await h.db.wsProspectDraftReceipt.count()).toBe(0);
    expect(await h.db.wsDraft.count()).toBe(1);
  });
  it('keeps legacy blank creation recoverable and supplies an editable empty Body section', async () => {
    const body = { requestId, prospectId, docTitle: 'Blank proposal' };
    const first = await service.create(runtime.WS03_IDS.tenantId, 'user_owner', body);
    expect(first.config).toMatchObject({ sections: ['Body'], sectionContent: { Body: '' } });
    expect((await service.create(runtime.WS03_IDS.tenantId, 'user_owner', body)).id).toBe(first.id);
    await expect(
      service.create(runtime.WS03_IDS.tenantId, 'user_owner', { ...body, clientId: prospectId }),
    ).rejects.toMatchObject({ status: 409 });
  });
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
