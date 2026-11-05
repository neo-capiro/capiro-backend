import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nativePostgresHarnessPaths, sourcePathAllowed } from './first-chat-source-policy.mjs';

const bundlePath='apps/api/scripts/funding-worker/rds-global-bundle.pem';
const result=spawnSync('git',['show',`HEAD:${bundlePath}`],{cwd:fileURLToPath(new URL('../..',import.meta.url)),maxBuffer:1000000});
assert.equal(result.status,0);
test('allows only the exact public RDS certificate blob at its required runtime path',()=>{
  assert.equal(sourcePathAllowed(bundlePath,()=>result.stdout),true);
  assert.equal(sourcePathAllowed(bundlePath,()=>Buffer.concat([result.stdout,Buffer.from('\n')])),false);
  assert.equal(sourcePathAllowed('apps/api/scripts/other.pem',()=>result.stdout),false);
});
test('ordinary secret paths remain denied without reading their contents',()=>{
  for(const path of ['.env','apps/api/.env.local','.aws','id_rsa','apps/api/service-account.json','private.key','secret.p12'])
    assert.equal(sourcePathAllowed(path,()=>{throw Error('must not read');}),false);
  assert.equal(sourcePathAllowed('apps/api/src/safe.ts',()=>{throw Error('must not read');}),true);
});

test('the verified archive admits only the required test harness and Docker never copies it', () => {
  const harness = 'apps/api/test/memory-postgres-qualification/harness.ts';
  assert.deepEqual(nativePostgresHarnessPaths, [harness]);
  const unread = () => { throw Error('ordinary paths do not need secret-blob inspection'); };
  assert.equal(sourcePathAllowed(harness, unread), true);
  for (const path of [
    'apps/api/test/other.ts',
    'apps/api/test/memory-postgres-qualification/credentials.json',
    'apps/api/test/memory-postgres-qualification/harness.ts/extra',
  ]) assert.equal(sourcePathAllowed(path, unread), false);
  const preparer = readFileSync(new URL('./prepare-first-chat-core-source.mjs', import.meta.url), 'utf8');
  assert.match(preparer, /import \{ nativePostgresHarnessPaths, sourcePathAllowed \}/);
  assert.match(preparer, /\.\.\.nativePostgresHarnessPaths,/);
  const dockerfile = readFileSync(new URL('../../apps/api/Dockerfile.alpine-qualification', import.meta.url), 'utf8');
  for (const line of dockerfile.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)) {
    const match = /^\s*COPY\s+(.+)$/i.exec(line);
    if (!match) continue;
    const tokens = match[1].trim().split(/\s+/);
    if (tokens.some(token => token.startsWith('--from='))) continue;
    for (const source of tokens.filter(token => !token.startsWith('--')).slice(0, -1)) {
      assert(source !== '.' && source !== './' && source !== harness && !harness.startsWith(`${source.replace(/\/$/, '')}/`),
        `Test-only harness would enter image through COPY ${source}`);
    }
  }
});

test('native preservation probes use the same build stage and explicit isolated fixture contracts', () => {
  const script = readFileSync(new URL('../../apps/api/scripts/qualification/run-bill-postgres-probes.sh', import.meta.url), 'utf8');
  assert.match(script, /docker network create --internal/);
  assert.doesNotMatch(script, /--network\s+host|--publish(?:=|\s)|docker run[^\n]*\s-p\s/);
  assert.match(script, /pg_image=967807252336\.dkr\.ecr\.us-east-1\.amazonaws\.com\/capiro\/dev\/scratch-pg-ssl@sha256:016a18f2a5269b23ca05de83826094011cc4e1a9e9cb28c186a3ba9f079ef1d9(?:\r?\n|$)/);
  assert.match(script, /dst=\/workspace\/\$memory_harness,readonly/);
  assert.match(script, /--entrypoint \/bin\/sh "\$builder" -ec/);
  assert.match(script, /MEMORY_POSTGRES_OWNED_ENDPOINT_ACK=127\.0\.0\.1:55433/);
  assert.match(script, /MEMORY_POSTGRES_REQUIRE_VECTOR=1/);
  assert.match(script, /CAPIRO_DATA_TEST_DATABASE_URL=postgresql:\/\/postgres:api_fixture@127\.0\.0\.1:55433\/api_reader_test/);
  assert.match(script, /owned local disposable test cluster; no AWS connection/);
  for (const spec of [
    'src/retrieval/bill-text.pg.spec.ts',
    'src/ingestion/state-bill-writer.pg.spec.ts',
    'src/ingestion/state-document-queue.pg.spec.ts',
    'src/ingestion/legiscan-provider-capacity.pg.spec.ts',
    'src/ingestion/bill-text-extraction-postgres.spec.ts',
    'src/ingestion/legiscan-document-evidence-postgres.spec.ts',
    'src/engagement/mail-query-plan.postgres.spec.ts',
    'src/meri/analytics/capiro-data-reader-roles.integration.spec.ts',
    'src/meri/semantic-search.postgres.spec.ts',
    'src/retrieval/adapters/memory-embedding-retention-policy.postgres.spec.ts',
  ]) assert.equal(script.split(spec).length - 1, 1, `${spec} executes once`);
  assert.match(script, /node --import tsx scripts\/bill-text-postgres-smoke\.ts/);
});
