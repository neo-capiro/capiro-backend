import { createRequire } from 'node:module';
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

const url = process.env.LEGIWATCH_PHASE5_UPGRADE_DATABASE_URL;
if (
  process.env.LEGIWATCH_PHASE5_TEST_DATABASE !== 'disposable' ||
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  url === process.env.DATABASE_URL
)
  throw Error('Separate disposable upgrade database required');
const root = process.cwd(),
  out = resolve(process.env.LEGIWATCH_PHASE5_UPGRADE_OUT ?? 'work/phase5-upgrade');
mkdirSync(out, { recursive: true });
const apiRequire = createRequire(join(root, 'apps/api/package.json'));
function migrate(app, baseline = false) {
  const source = join(root, 'apps', app, 'prisma'),
    destination = baseline ? join(out, 'baseline', app, 'prisma') : source;
  if (baseline) {
    mkdirSync(join(destination, 'migrations'), { recursive: true });
    cpSync(join(source, 'schema.prisma'), join(destination, 'schema.prisma'));
    for (const name of readdirSync(join(source, 'migrations')))
      if (!name.startsWith(app === 'api' ? '20280913' : '20260913'))
        cpSync(join(source, 'migrations', name), join(destination, 'migrations', name), {
          recursive: true,
        });
  }
  const run = spawnSync(
    process.execPath,
    [
      apiRequire.resolve('prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      join(destination, 'schema.prisma'),
    ],
    { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
  );
  writeFileSync(
    join(out, `${app}-${baseline ? 'baseline' : 'upgrade'}.log`),
    run.stdout + run.stderr,
  );
  if (run.status !== 0)
    throw Error(
      `${app} ${baseline ? 'baseline' : 'upgrade'} migration failed; inspect rehearsal log`,
    );
}
const { PrismaClient } = apiRequire('@prisma/client'),
  p = new PrismaClient({ datasources: { db: { url } } });
const ids = {
  bill: 'fl-2099-upgrade-' + randomUUID(),
  action: randomUUID(),
  amendment: randomUUID(),
  tenant: randomUUID(),
  session: 'upgrade-' + randomUUID(),
  publication: randomUUID(),
  owner: 'upgrade-' + randomUUID(),
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  if (
    Number(
      (
        await p.$queryRaw`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`
      )[0].n,
    ) !== 0
  )
    throw Error('Upgrade database must be empty');
  migrate('api', true);
  migrate('intel-api', true);
  // Reproduce the observed owner default privileges before applying new tables.
  await p.$executeRawUnsafe(
    'ALTER DEFAULT PRIVILEGES FOR ROLE capiro_master IN SCHEMA public GRANT ALL ON TABLES TO capiro_app',
  );
  await p.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title) VALUES(${ids.bill},'FL','2099','2099','HB 1','hb1','Synthetic upgrade source')`;
  for (const [kind, id, evidence] of [
    ['action', ids.action, { text: 'Earlier published action', date: '2099-01-02' }],
    ['amendment', ids.amendment, { text: 'Earlier amendment interpretation', adopted: false }],
  ])
    await p.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence)
      VALUES(${id}::uuid,${ids.bill},${kind},${kind},${hash(evidence)},'2099-01-02',0,${JSON.stringify(evidence)}::jsonb)`;
  await p.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${ids.tenant}::uuid,${ids.tenant},'Synthetic upgrade tenant')`;
  await p.$executeRaw`INSERT INTO intel_live_hearing_session(id,tenant_id,created_by,title,source_type,audio_source,recording_policy,status,consent_status,issue_ids,bill_ids,program_element_ids,agency_ids,updated_at)
    VALUES(${ids.session},${ids.tenant},${ids.owner},'Synthetic retained account','hearing','browser_mic','transcript_only','ended','not_required',ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],now())`;
  await p.$executeRaw`INSERT INTO intel_hearing_publication(id,tenant_id,session_id,owner_clerk_id,series_id,version,kind,content_hash,payload)
    VALUES(${ids.publication},${ids.tenant},${ids.session},${ids.owner},${ids.publication},1,'hearing_recap',${hash('retained fixture')},'{"fixture":"Preserve the earlier unofficial account"}'::jsonb)`;
  const snapshot = async () => ({
    records:
      await p.$queryRaw`SELECT id::text,evidence,revision_hash,first_observed_at FROM state_bill_published_record WHERE bill_key=${ids.bill} ORDER BY id`,
    publication:
      await p.$queryRaw`SELECT * FROM intel_hearing_publication WHERE id=${ids.publication}`,
  });
  const before = await snapshot();
  migrate('api');
  migrate('intel-api');
  const after = await snapshot();
  if (hash(before) !== hash(after))
    throw Error('Upgrade rewrote retained source/publication evidence');
  const pointers =
    await p.$queryRaw`SELECT source_key,state_record_id::text FROM published_record_source_current WHERE source_key LIKE ${'state:' + ids.bill + ':%'} ORDER BY source_key`;
  if (pointers.length !== 2) throw Error('Upgrade did not initialize source observations');
  const privileges =
    await p.$queryRaw`SELECT has_table_privilege('capiro_app','published_record_source_observation','UPDATE') AS can_rewrite,
    has_table_privilege('capiro_app','intel_hearing_record_brief','DELETE') AS can_delete_brief,
    has_table_privilege('capiro_app','legiwatch_record_document','UPDATE') AS can_rewrite_document`;
  if (Object.values(privileges[0]).some(Boolean))
    throw Error('Owner default privileges bypass immutable evidence boundaries');
  const result = {
    scope:
      'Phase 4 schema and populated source/publication records to Phase 5, API then Intel, actual capiro_master owner and broad observed default ACL',
    preservedSnapshotSha256: hash(before),
    preservedRecordCount: before.records.length,
    preservedPublicationCount: before.publication.length,
    pointers,
    privileges,
    migrations:
      await p.$queryRaw`SELECT count(*)::int AS applied FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log('PHASE5_UPGRADE ' + JSON.stringify(result));
} finally {
  await p.$disconnect();
}
