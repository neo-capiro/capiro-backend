import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import type { PoolClient } from 'pg';
import { PrismaService as IntelPrisma } from '../../../intel-api/src/prisma/prisma.service.js';
import { HearingRecordWorkflowService } from '../../../intel-api/src/hearing/hearing-record-workflow.service.js';
import { HearingRecordRetrievalController } from '../../../intel-api/src/hearing/hearing-record-retrieval.controller.js';
import { HearingCryptoService } from '../../../intel-api/src/hearing/hearing-crypto.service.js';
import { FolderTrackerService } from '../../../intel-api/src/tracker/folders/folder-tracker.service.js';
import { FolderSourceDataRepository } from '../../../intel-api/src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../../../intel-api/src/sourcedata/source-data.repository.js';
import { DraftAccessService } from '../../../intel-api/src/tracker/delivery/draft-access.service.js';
import { FeatureFlagService } from '../../../intel-api/src/feature-flags/feature-flag.service.js';
import { digest } from '../../../intel-api/src/tracker/delivery/delivery-domain.js';
import { tenant, actor, client, second, ctx, type fixture } from './fixture.js';

const sqlFile = (path: string) => readFileSync(resolve(__dirname, '../../../..', path), 'utf8');
export async function installHearingSchema(owner: PoolClient) {
  await owner.query(`ALTER TABLE clients ADD COLUMN name text DEFAULT 'Synthetic client', ADD COLUMN sector_tag text;
    CREATE TABLE intel_feature_flag(id text PRIMARY KEY,tenant_id text NOT NULL,feature text NOT NULL,enabled boolean NOT NULL,created_at timestamptz DEFAULT now(),UNIQUE(feature,tenant_id));
    GRANT SELECT,UPDATE ON intel_feature_flag TO capiro_app;`);
  for (const name of [
    '20260910130000_legiwatch_folder_tracker',
    '20260910130100_legiwatch_folder_rls',
    '20260913010000_hearing_record_reconciliation',
  ])
    await owner.query(sqlFile('apps/intel-api/prisma/migrations/' + name + '/migration.sql'));
  // Exact historical immutable trigger function prerequisite, without unrelated source tables.
  const source = sqlFile(
    'apps/api/prisma/migrations/20280913010000_legiwatch_record_revisions/migration.sql',
  );
  const start = source.indexOf('CREATE FUNCTION legiwatch_reject_record_rewrite()');
  const end = source.indexOf('$$;', start) + 3;
  if (start < 0 || end <= start) throw Error('Canonical immutable function missing');
  await owner.query(source.slice(start, end));
  await owner.query(
    sqlFile('apps/api/prisma/migrations/20280913014000_legiwatch_record_documents/migration.sql'),
  );
}

/** Actual Intel workflow, access controller, folder/feature owners and a separate
 * generated Prisma client. Only upstream public records are synthetic. */
export async function hearingOwner(h: Awaited<ReturnType<typeof fixture>>) {
  const db = new IntelPrisma({ datasources: { db: { url: h.appUrl } } });
  await db.$connect();
  // The fixture uses a non-bypass role. Restrict canonical cross-service source
  // reads to its single synthetic tenant, retaining their explicit predicates.
  const sourceDb = { withSystem: (fn: never) => db.withTenant(tenant, fn) };
  const folderSource = new FolderSourceDataRepository(sourceDb as never);
  const legacy = {
    getClientProfile: (t: string, c: string) =>
      SourceDataRepository.prototype.getClientProfile.call({ prisma: sourceDb }, t, c),
  };
  const folders = new FolderTrackerService(db, folderSource, legacy as never);
  const flags = new FeatureFlagService(db, { get: () => undefined } as never);
  const reports = new DraftAccessService(folders, flags);
  const crypto = new HearingCryptoService({
    get: (name: string) => (name === 'HEARING_ENCRYPTION_KEY' ? '11'.repeat(32) : undefined),
  } as never);
  const event = { id: 'pf16-event', title: 'Synthetic hearing' };
  const publicSource = { event: async () => event, snapshot: async () => [] };
  const workflow = new HearingRecordWorkflowService(
    reports,
    publicSource as never,
    crypto,
    {} as never,
    {} as never,
    {} as never,
  );
  const controller = new HearingRecordRetrievalController(workflow);
  let calls = 0;
  let beforeRead: ((call: number) => Promise<void>) | undefined;
  let afterRead: ((call: number, result: Record<string, unknown>) => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const n = ++calls;
      await beforeRead?.(n);
      const result = await controller.retrieve(
        req.headers['x-internal-service-secret'] as string,
        body,
      );
      await afterRead?.(n, result as unknown as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const oldOrigin = process.env.TRACKER_APP_BASE_URL,
    oldSecret = process.env.INTERNAL_SERVICE_SECRET;
  process.env.TRACKER_APP_BASE_URL =
    'http://127.0.0.1:' + (server.address() as { port: number }).port;
  process.env.INTERNAL_SERVICE_SECRET = 'pf16-local-service-only';
  const seed = async () => {
    calls = 0;
    beforeRead = undefined;
    afterRead = undefined;
    await h.sql(
      'TRUNCATE intel_hearing_record_run,intel_legiwatch_folder,intel_feature_flag CASCADE',
    );
    await h.reset();
    await h.sql(
      `INSERT INTO intel_feature_flag(id,tenant_id,feature,enabled) VALUES('f1',$1,'legiwatch_published_records_v1',true),('f2',$1,'legiwatch_record_briefs_v1',true)`,
      [tenant],
    );
    await h.sql(
      `INSERT INTO intel_legiwatch_folder(id,tenant_id,name,owner_clerk_id,client_id,version,created_by,updated_at) VALUES('pf16-folder',$1,'Synthetic folder',$2,$3,0,$2,now())`,
      [tenant, ctx.clerkUserId, client],
    );
    const sourceHash = digest([event, []]);
    const run = {
      event,
      records: [],
      sourceHash,
      claims: [],
      originalClaims: [],
      observation: null,
      sourceSelections: [],
      coverage: [],
      cutoff: '2026-10-01',
    };
    const brief = {
      schema: 'legiwatch.record-brief.v1',
      title: 'Synthetic brief',
      sourceHash,
      clientId: client,
      claims: [],
      records: [],
      cutoff: '2026-10-01',
      folders: [{ id: 'pf16-folder', version: 0, clientId: client }],
      coverage: [],
      observation: null,
    };
    const contentHash = digest(brief);
    await h.sql(
      `INSERT INTO intel_hearing_record_run(id,tenant_id,owner_clerk_id,event_id,input_hash,payload) VALUES('pf16-run',$1,$2,$3,'input',$4)`,
      [tenant, ctx.clerkUserId, event.id, crypto.encrypt(JSON.stringify(run))],
    );
    await h.sql(
      `INSERT INTO intel_hearing_record_brief(id,tenant_id,owner_clerk_id,event_id,run_id,series_id,version,client_id,content_hash,payload) VALUES('pf16-brief',$1,$2,$3,'pf16-run','pf16-series',1,$4,$5,$6)`,
      [
        tenant,
        ctx.clerkUserId,
        event.id,
        client,
        contentHash,
        crypto.encrypt(JSON.stringify(brief)),
      ],
    );
    await h.sql(
      `INSERT INTO intel_hearing_record_brief_review(id,tenant_id,owner_clerk_id,brief_id,content_hash,source_hash,payload,created_at) VALUES('pf16-review',$1,$2,'pf16-brief',$3,$4,'{}',now()-interval '3 days')`,
      [tenant, ctx.clerkUserId, contentHash, sourceHash],
    );
    await h.sql(
      `UPDATE engagement_attachments SET source_entity_type='hearing_record_brief',source_entity_id='pf16-brief' WHERE id=$1`,
      [second],
    );
    await h.sql(
      `INSERT INTO legiwatch_record_document(attachment_id,tenant_id,owner_clerk_id,client_id,event_id,brief_id,series_id,version,content_hash,source_hash) VALUES($1,$2,$3,$4,$5,'pf16-brief','pf16-series',1,$6,$7)`,
      [second, tenant, ctx.clerkUserId, client, event.id, contentHash, sourceHash],
    );
  };
  return {
    workflow,
    db,
    seed,
    get calls() {
      return calls;
    },
    beforeRead: (fn: typeof beforeRead) => {
      beforeRead = fn;
    },
    afterRead: (fn: typeof afterRead) => {
      afterRead = fn;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await db.$disconnect();
      if (oldOrigin === undefined) delete process.env.TRACKER_APP_BASE_URL;
      else process.env.TRACKER_APP_BASE_URL = oldOrigin;
      if (oldSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
      else process.env.INTERNAL_SERVICE_SECRET = oldSecret;
    },
  };
}
