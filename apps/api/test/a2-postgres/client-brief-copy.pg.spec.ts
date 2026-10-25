import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ClientBriefCopyController } from '../../../workspace/src/documents/client-brief-copy.controller.js';
import { TenantGuard } from '../../../workspace/src/auth/tenant.guard.js';
import { fixture, id, tenant, actor, client, ctx, foreign, release, settled } from './fixture.js';
import { PrismaService as WorkspacePrisma } from '../../../workspace/src/prisma/prisma.service.js';
import { DraftsService } from '../../../workspace/src/drafts/drafts.service.js';
import { CollaboratorsService } from '../../../workspace/src/collaborators/collaborators.service.js';
import {
  copyBriefToClient,
  readClientBriefCopy,
} from '../../../workspace/src/documents/client-brief-copy.js';
import {
  stateHash,
  briefSectionLabels,
} from '../../../workspace/src/documents/prospect-brief-copy-contract.js';

let h: Awaited<ReturnType<typeof fixture>>, workspace: WorkspacePrisma, drafts: DraftsService;
let app: INestApplication;
const prospect = id(1400),
  brief = id(1401),
  version = id(1402),
  requestId = id(1403),
  timestamp = '2026-10-25T00:00:00.000Z';
const sections = Object.fromEntries(
  Object.keys(briefSectionLabels).map((key) => [
    key,
    { text: `${key}: Reviewed`, provenance: 'edited', citationIndexes: [] },
  ]),
);
const sourceSnapshot = { synthetic: true },
  source = {
    kind: 'core_prospect_brief_version',
    prospectId: prospect,
    briefId: brief,
    versionId: version,
    versionNumber: 1,
    sectionsHash: stateHash(sections),
    snapshotHash: stateHash(sourceSnapshot),
  };
const input = {
  schemaVersion: 1,
  requestId,
  prospectId: prospect,
  clientId: client,
  expectedProspectUpdatedAt: timestamp,
  docTitle: 'Private reviewed brief',
  source,
};
const save = (raw: unknown = input) =>
  copyBriefToClient(workspace, drafts, tenant, ctx.clerkUserId, prospect, client, raw);
const read = () =>
  readClientBriefCopy(workspace, tenant, ctx.clerkUserId, prospect, client, requestId);
const counts = async () =>
  (
    await h.sql(`SELECT
  (SELECT count(*)::int FROM ws_draft) AS drafts,(SELECT count(*)::int FROM ws_document) AS documents,
  (SELECT count(*)::int FROM ws_context_item) AS contexts,(SELECT count(*)::int FROM ws_doc_version) AS versions,
  (SELECT count(*)::int FROM ws_source_action) AS receipts,(SELECT count(*)::int FROM ws_collaborator) AS collaborators`)
  ).rows[0];
const empty = { drafts: 0, documents: 0, contexts: 0, versions: 0, receipts: 0, collaborators: 0 };
beforeAll(async () => {
  h = await fixture('files');
  try {
    await h.sql(`ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb NOT NULL DEFAULT '{"clioFeatureFlags":{"businessDevelopment.enabled":true,"businessDevelopment.brief.enabled":true}}';
      ALTER TABLE clients ADD COLUMN name text NOT NULL DEFAULT 'Synthetic client', ADD COLUMN profile_status text NOT NULL DEFAULT 'ACTIVE';
      CREATE TABLE business_development_prospects(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        linked_client_id uuid REFERENCES clients(id),converted_at timestamptz,updated_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'active',dismissed_at timestamptz);
      CREATE TABLE business_development_briefs(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,prospect_id uuid NOT NULL REFERENCES business_development_prospects(id) ON DELETE CASCADE);
      CREATE TABLE business_development_brief_versions(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,brief_id uuid NOT NULL REFERENCES business_development_briefs(id) ON DELETE CASCADE,
        version_number integer NOT NULL,sections jsonb NOT NULL,citations jsonb NOT NULL,source_snapshot jsonb NOT NULL,sections_hash text NOT NULL,snapshot_hash text NOT NULL);
      DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['business_development_prospects','business_development_briefs','business_development_brief_versions'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id())',t);
        EXECUTE format('GRANT SELECT ON %I TO capiro_app',t);
      END LOOP; END $$;
      -- Workspace's established withSystem identity reader sets this GUC and
      -- retains explicit tenant/Clerk predicates; all resource reads stay scoped.
      CREATE POLICY workspace_identity ON tenant_memberships FOR SELECT
        USING(current_setting('app.bypass_rls',true)='on');`);
    for (const name of [
      '00000000000000_init_workspace',
      '20260627185725_ws_doc_version',
      '20260627190000_ws_collaborator',
      '20260628170000_ws_draft_last_editor',
      '20260913020000_legiwatch_preparation_actions',
      '20261012030000_prospect_resource_origin',
      '20261012040000_saved_version_immutability',
      '20261013090000_prospect_brief_workspace_copy',
      '20261023120000_ws_draft_client_id',
    ])
      await h.sql(
        readFileSync(
          resolve(__dirname, '../../../workspace/prisma/migrations', name, 'migration.sql'),
          'utf8',
        ),
      );
    await h.sql(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON ws_draft,ws_document,ws_context_item,ws_doc_version,ws_collaborator TO capiro_app',
    );
    workspace = new WorkspacePrisma({ datasources: { db: { url: h.appUrl } } });
    await workspace.$connect();
    drafts = new DraftsService(workspace, new CollaboratorsService(workspace, {} as never));
    const module = await Test.createTestingModule({
      controllers: [ClientBriefCopyController],
      providers: [
        { provide: WorkspacePrisma, useValue: workspace },
        { provide: DraftsService, useValue: drafts },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().tenantContext = {
            tenantId: tenant,
            clerkUserId: ctx.clerkUserId,
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('workspace-api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  } catch (error) {
    await app?.close();
    await workspace?.$disconnect();
    await h.close();
    throw error;
  }
});
beforeEach(async () => {
  await h.sql('TRUNCATE ws_source_action,ws_draft CASCADE');
  await h.reset();
  await h.sql(
    `INSERT INTO business_development_prospects(id,tenant_id,linked_client_id,converted_at,updated_at) VALUES($1,$2,$3,$4,$4)`,
    [prospect, tenant, client, timestamp],
  );
  await h.sql('INSERT INTO business_development_briefs VALUES($1,$2,$3)', [
    brief,
    tenant,
    prospect,
  ]);
  await h.sql('INSERT INTO business_development_brief_versions VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)', [
    version,
    tenant,
    brief,
    JSON.stringify(sections),
    '[]',
    JSON.stringify(sourceSnapshot),
    source.sectionsHash,
    source.snapshotHash,
  ]);
});
afterAll(async () => {
  await app?.close();
  await workspace?.$disconnect();
  await h?.close();
});

it('concurrent copies commit one private draft/document/context/version/receipt through actual Workspace owners', async () => {
  const [a, b] = await Promise.all([save(), save()]);
  expect(a).toEqual(b);
  expect(await counts()).toEqual({
    drafts: 1,
    documents: 1,
    contexts: 1,
    versions: 1,
    receipts: 1,
    collaborators: 0,
  });
  const draft = await drafts.byId(tenant, a.draftId, ctx.clerkUserId);
  expect(draft).toMatchObject({
    ownerId: ctx.clerkUserId,
    prospectId: null,
    clientId: client,
    status: 'draft',
    isPacket: false,
  });
  expect(draft.documents[0]!.sourceBriefVersion).toBeNull();
  const saved = (await h.sql('SELECT snapshot FROM ws_doc_version')).rows[0].snapshot;
  expect(saved.privateClientBriefCopy.source).toEqual(source);
  expect(saved.sourceEvidence.sections).toEqual(sections);
  expect(await read()).toEqual(a);
});
it('independent draft remains editable/readable after source removal; request replay never overwrites it', async () => {
  const a = await save();
  await h.sql(`UPDATE ws_document SET body='{"blocks":[]}'`);
  await h.sql('DELETE FROM business_development_brief_versions');
  expect(await save()).toEqual(a);
  expect((await drafts.byId(tenant, a.draftId, ctx.clerkUserId)).documents[0]!.body).toEqual({
    blocks: [],
  });
  await expect(save({ ...input, docTitle: 'Changed request' })).rejects.toMatchObject({
    status: 409,
  });
});
it('deletion preserves an attributable consumed receipt and never resurrects the draft', async () => {
  const a = await save();
  await h.sql('DELETE FROM ws_draft WHERE id=$1', [a.draftId]);
  expect(await read()).toEqual({ ...a, available: false });
  expect(await save()).toEqual({ ...a, available: false });
  expect(await counts()).toEqual({ ...empty, receipts: 1 });
});
it.each(['ws_doc_version', 'ws_source_action'])(
  'rolls back every destination row on %s failure, including deferred COMMIT rejection',
  async (table) => {
    const trigger =
      table === 'ws_source_action'
        ? `CREATE CONSTRAINT TRIGGER synthetic_failure AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED`
        : `CREATE TRIGGER synthetic_failure BEFORE INSERT ON ${table}`;
    await h.sql(`CREATE FUNCTION synthetic_brief_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    ${trigger} FOR EACH ROW EXECUTE FUNCTION synthetic_brief_fail()`);
    try {
      if (table === 'ws_source_action') {
        // The callback produces a result before the deferred trigger rejects
        // COMMIT. A rolled-back receipt must never become completed HTTP200.
        await request(app.getHttpServer())
          .post(`/workspace-api/prospects/${prospect}/clients/${client}/brief-copies`)
          .send(input)
          .expect(500);
      } else await expect(save()).rejects.toThrow();
      expect(await counts()).toEqual(empty);
    } finally {
      await h.sql(
        `DROP TRIGGER synthetic_failure ON ${table}; DROP FUNCTION synthetic_brief_fail()`,
      );
    }
    expect((await save()).status).toBe('completed');
  },
);
it('observes current membership revoked during an actual source lock wait', async () => {
  const blocker = await h.lock(
      'SELECT id FROM business_development_prospects WHERE id=$1 FOR UPDATE',
      [prospect],
    ),
    pending = settled(save());
  try {
    await h.waitForLock('FROM business_development_prospects');
    await blocker.query("UPDATE tenant_memberships SET status='removed' WHERE user_id=$1", [actor]);
  } finally {
    await release(blocker);
  }
  expect((await pending).error).toMatchObject({ status: 404 });
  expect(await counts()).toEqual(empty);
});
it('observes a client wall enabled during the actual client lock wait', async () => {
  const blocker = await h.lock('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [client]),
    pending = settled(save());
  try {
    await h.waitForLock('SELECT status,memory_wall');
    await blocker.query('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
  } finally {
    await release(blocker);
  }
  expect((await pending).error).toMatchObject({ status: 404 });
  expect(await counts()).toEqual(empty);
});
it('rejects stale reviewed prospect/source hashes before creating a draft', async () => {
  await h.sql('UPDATE business_development_prospects SET updated_at=now()');
  await expect(save()).rejects.toMatchObject({ status: 409 });
  expect(await counts()).toEqual(empty);
  await h.sql('UPDATE business_development_prospects SET updated_at=$1', [timestamp]);
  await h.sql("UPDATE business_development_brief_versions SET sections_hash=repeat('0',64)");
  await expect(save()).rejects.toMatchObject({ status: 404 });
  expect(await counts()).toEqual(empty);
});
it('historical lookup retains current tenant, actor, prospect/client and feature boundaries', async () => {
  await save();
  await expect(
    readClientBriefCopy(workspace, foreign, ctx.clerkUserId, prospect, client, requestId),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    readClientBriefCopy(workspace, tenant, 'a2-synthetic-other', prospect, client, requestId),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    readClientBriefCopy(workspace, tenant, ctx.clerkUserId, prospect, id(1450), requestId),
  ).rejects.toMatchObject({ status: 404 });
  await h.sql("UPDATE tenants SET settings_jsonb='{}' WHERE id=$1", [tenant]);
  await expect(read()).rejects.toMatchObject({ status: 404 });
});
it('uses the existing immutable source action and saved-version protection', async () => {
  await save();
  await expect(
    workspace.$executeRaw`UPDATE ws_source_action SET input_hash='changed'`,
  ).rejects.toThrow();
  await expect(workspace.$executeRaw`DELETE FROM ws_source_action`).rejects.toThrow();
  await expect(workspace.$executeRaw`UPDATE ws_doc_version SET snapshot='{}'`).rejects.toThrow();
  await expect(h.sql("UPDATE ws_source_action SET input_hash='changed'")).rejects.toThrow(
    'IMMUTABLE',
  );
});
