import { createRequire } from 'node:module';
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
const root = process.cwd(),
  out = resolve(process.env.LEGIWATCH_PHASE8_UPGRADE_OUT ?? 'work/phase8-upgrade'),
  require = createRequire(join(root, 'apps/api/package.json'));
const urls = [
  process.env.LEGIWATCH_PHASE8_CLEAN_DATABASE_URL,
  process.env.LEGIWATCH_PHASE8_UPGRADE_DATABASE_URL,
];
if (
  process.env.LEGIWATCH_PHASE8_TEST_DATABASE !== 'disposable' ||
  urls.some((u) => !u || !['localhost', '127.0.0.1'].includes(new URL(u).hostname)) ||
  new Set(urls).size !== 2 ||
  urls.includes(process.env.DATABASE_URL)
)
  throw Error('Two separate empty disposable local databases required');
mkdirSync(out, { recursive: true });
const { PrismaClient } = require('@prisma/client'),
  hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function migrate(app, url, label, baseline = false) {
  const source = join(root, 'apps', app, 'prisma'),
    destination = baseline ? join(out, 'baseline', app, 'prisma') : source;
  if (baseline) {
    mkdirSync(join(destination, 'migrations'), { recursive: true });
    cpSync(join(source, 'schema.prisma'), join(destination, 'schema.prisma'));
    for (const name of readdirSync(join(source, 'migrations')))
      if (!name.startsWith(app === 'api' ? '2028091403' : '2026091403'))
        cpSync(join(source, 'migrations', name), join(destination, 'migrations', name), {
          recursive: true,
        });
  }
  const run = spawnSync(
    process.execPath,
    [
      require.resolve('prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      join(destination, 'schema.prisma'),
    ],
    { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
  );
  writeFileSync(
    join(out, `${label}-${app}-${baseline ? 'baseline' : 'upgrade'}.log`),
    run.stdout + run.stderr,
  );
  if (run.status !== 0) throw Error(`${label} ${app} migration failed; inspect retained log`);
}
const results = [];
for (const [i, url] of urls.entries()) {
  const label = i === 0 ? 'clean' : 'populated',
    p = new PrismaClient({ datasources: { db: { url } } });
  try {
    const [{ n }] =
      await p.$queryRaw`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`;
    if (n) throw Error(`${label} database must be empty`);
    await p.$executeRawUnsafe(
      'ALTER DEFAULT PRIVILEGES FOR ROLE capiro_master IN SCHEMA public GRANT ALL ON TABLES TO capiro_app',
    );
    let before = null,
      after = null;
    if (i === 1) {
      for (const app of ['api', 'intel-api', 'workspace']) migrate(app, url, label, true);
      const tenant = randomUUID(),
        actor = 'fixture-' + randomUUID(),
        folder = randomUUID(),
        bill = 'fl-' + randomUUID(),
        assignment = randomUUID(),
        record = randomUUID(),
        session = randomUUID(),
        publication = randomUUID();
      await p.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenant}::uuid,${tenant},'Synthetic Phase 8 upgrade')`;
      const user = randomUUID();
      await p.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${user}::uuid,${actor},${actor + '@example.invalid'})`;
      await p.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${user}::uuid,'standard_user','active')`;
      await p.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title) VALUES(${bill},'FL','2099','2099','HB 1','hb1','Synthetic health care bill')`;
      await p.$executeRaw`INSERT INTO intel_legiwatch_folder(id,tenant_id,name,owner_clerk_id,created_by,updated_at) VALUES(${folder},${tenant},'Synthetic preserved folder',${actor},${actor},now())`;
      await p.$executeRaw`INSERT INTO intel_legiwatch_folder_bill(id,tenant_id,folder_id,bill_id,session_key,jurisdiction,position,top_priority,importance,internal_comments,external_comments,updated_by,updated_at,provenance)
    VALUES(${assignment},${tenant},${folder},${bill},'2099','FL','oppose',true,'high','Synthetic internal context','Synthetic approved public comment',${actor},now(),'{"origin":"lobbytools:synthetic"}'::jsonb)`;
      await p.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence)
    VALUES(${record}::uuid,${bill},'action','synthetic-action',${hash({ text: 'Retained action' })},'2099-01-02',0,'{"text":"Retained action"}'::jsonb)`;
      await p.$executeRaw`INSERT INTO intel_live_hearing_session(id,tenant_id,created_by,title,source_type,audio_source,recording_policy,status,consent_status,issue_ids,bill_ids,program_element_ids,agency_ids,updated_at)
    VALUES(${session},${tenant},${actor},'Synthetic earlier account','hearing','browser_mic','transcript_only','ended','not_required',ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],now())`;
      await p.$executeRaw`INSERT INTO intel_hearing_publication(id,tenant_id,session_id,owner_clerk_id,series_id,version,kind,content_hash,payload)
    VALUES(${publication},${tenant},${session},${actor},${publication},1,'hearing_recap',${hash('retained')},'{"fixture":"Preserved unofficial account"}'::jsonb)`;
      const snapshot = async () => ({
        assignment:
          await p.$queryRaw`SELECT * FROM intel_legiwatch_folder_bill WHERE id=${assignment}`,
        source:
          await p.$queryRaw`SELECT * FROM state_bill_published_record WHERE id=${record}::uuid`,
        publication:
          await p.$queryRaw`SELECT * FROM intel_hearing_publication WHERE id=${publication}`,
      });
      before = await snapshot();
      for (const app of ['api', 'intel-api', 'workspace']) migrate(app, url, label);
      after = await snapshot();
      if (hash(before) !== hash(after))
        throw Error('Upgrade changed imported context or retained source/publication bytes');
    } else for (const app of ['api', 'intel-api', 'workspace']) migrate(app, url, label);
    const privileges =
      await p.$queryRaw`SELECT has_table_privilege('capiro_app','intel_legiwatch_news_match','UPDATE') AS can_rewrite_decision,
   has_table_privilege('capiro_app','intel_legiwatch_keyword_control_history','DELETE') AS can_delete_controls,
   has_table_privilege('capiro_app','intel_legiwatch_keyword_delivery_reference','UPDATE') AS can_rewrite_delivery_reference,
   has_table_privilege('capiro_app','ws_source_action','DELETE') AS can_delete_remote_receipt,
   has_table_privilege('capiro_app','legiwatch_news_observation','UPDATE') AS can_rewrite_legal_text,
   has_table_privilege('capiro_app','intel_legiwatch_legal_decision','UPDATE') AS can_rewrite_legal_decision,
   has_table_privilege('capiro_app','intel_legiwatch_editorial_selection','DELETE') AS can_delete_research_selection`;
    if (Object.values(privileges[0]).some(Boolean))
      throw Error('Broad owner default ACL defeated immutable history');
    const migrations =
      await p.$queryRaw`SELECT migration_name,checksum,finished_at FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
    const newMigrations = migrations.filter((m) => /^202[68]091403/.test(m.migration_name));
    if (newMigrations.length !== 2) throw Error('Expected 2 Phase 8 owner migrations');
    results.push({
      label,
      scope:
        'API then Intel then Workspace; capiro_master owner with observed broad default table ACL',
      preservedSnapshotHash: before ? hash(before) : null,
      privileges: privileges[0],
      appliedCount: migrations.length,
      newMigrations,
    });
  } finally {
    await p.$disconnect();
  }
}
writeFileSync(join(out, 'result.json'), JSON.stringify({ results }, null, 2));
console.log(JSON.stringify({ passed: true, results }));
