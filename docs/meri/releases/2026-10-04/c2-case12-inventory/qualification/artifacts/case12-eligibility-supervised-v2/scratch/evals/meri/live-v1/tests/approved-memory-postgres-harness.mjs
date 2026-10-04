import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryFixtureSchemaSql } from './approved-memory-schema.mjs';
import { AUTHORIZED_TENANTS } from '../fixture-provisioning/contract.mjs';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { createApprovedMemoryFixtureRuntime } from '../fixture-provisioning/approved-memory-runtime.mjs';

const require = createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');
export const PROPOSER = '44444444-4444-4444-8444-444444444444';
export const REVIEWER = '66666666-6666-4666-8666-666666666666';
export const CLIENT = '11111111-1111-4111-8111-111111111111';
export const OTHER_CLIENT = '22222222-2222-4222-8222-222222222222';
export const TENANT = AUTHORIZED_TENANTS.T1.id;

/** Explicit config only; malformed JSON and connection failures never echo secrets. */
async function localConfig(path) {
  if (!path || !isAbsolute(path)) throw new Error('Explicit absolute disposable config required');
  let config;
  try {
    config = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Disposable config must be readable valid JSON');
  }
  if (
    config?.host !== '127.0.0.1' ||
    config.port !== 55433 ||
    config.scope !== 'owned local disposable test cluster; no AWS connection' ||
    !['user', 'password', 'database', 'dataDirectory'].every(
      (key) => typeof config[key] === 'string' && config[key].length > 0,
    ) ||
    !isAbsolute(config.dataDirectory)
  )
    throw new Error('Only the marked owned loopback cluster is allowed');
  return config;
}

/**
 * Actual source services and Prisma ORM on one rollback-only transaction. Only
 * the projection fast path is replaced with an owned, inert sink; canonical
 * approval, SQL, authorization, audit and durable outbox remain executable.
 */
export async function withOwnedApprovedMemory(configPath, work) {
  const config = await localConfig(configPath);
  const { Client } = require('pg');
  const probe = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: 3000,
  });
  try {
    await probe.connect();
  } catch {
    throw new Error('Could not connect to explicit disposable PostgreSQL target');
  }
  let prisma;
  const schema = `meri_approved_${randomUUID().replaceAll('-', '')}`;
  const beforeEnv = new Map();
  try {
    const actual = (
      await probe.query(
        `SELECT current_user=$1 AS owner_matches, host(inet_server_addr()) AS address,
       inet_server_port() AS port, current_setting('data_directory') AS data_directory`,
        [config.user],
      )
    ).rows[0];
    assert.equal(
      Boolean(
        actual.owner_matches &&
        actual.address === config.host &&
        actual.port === config.port &&
        actual.data_directory.replaceAll('\\', '/') === config.dataDirectory.replaceAll('\\', '/'),
      ),
      true,
      'Actual database owner, address, port and data directory must match',
    );
    for (const [key, value] of Object.entries({
      MERI_SYNTHETIC_FIXTURE_NAMESPACE: 'meri-foundation-20260928',
      MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
      MEMORY_GOVERNANCE_ENFORCE: 'enforce',
      MEMORY_GOVERNANCE_CENTER: 'enforce',
      MEMORY_GOVERNANCE_TENANTS: 'all',
      MEMORY_CLIENT_REVIEW: 'true',
    })) {
      beforeEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    require('ts-node').register({
      project: 'C:/dev/main/meri-c1-20261002/apps/api/tsconfig.json',
      transpileOnly: true,
      experimentalResolver: true,
    });
    const source = (name) =>
      require(`C:/dev/main/meri-c1-20261002/apps/api/src/${name}.ts`);
    const { MemoryCandidateService } = source('memory/memory-candidate.service');
    const { MemoryStoreService } = source('memory/memory-store.service');
    const { TenantContextStore } = source('tenant/tenant-context.store');
    const { clientMemoryAllowed } = source('memory/memory-wall.helpers');
    const { PrismaClient } = require('@prisma/client');
    const url = new URL(`postgresql://${config.host}:${config.port}/${config.database}`);
    url.username = config.user;
    url.password = config.password;
    url.searchParams.set('schema', schema);
    prisma = new PrismaClient({ datasources: { db: { url: url.href } }, log: [] });
    const rollback = new Error('owned test rollback');
    let completed = false;
    let result;
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
          for (const statement of memoryFixtureSchemaSql(schema)
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean))
            await tx.$executeRawUnsafe(statement);
          await tx.$executeRawUnsafe(
            'INSERT INTO tenants VALUES ($1::uuid,$2),($3::uuid,$4)',
            TENANT,
            AUTHORIZED_TENANTS.T1.slug,
            AUTHORIZED_TENANTS.T2.id,
            AUTHORIZED_TENANTS.T2.slug,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO tenant_memberships VALUES ($1::uuid,$2::uuid,'active','standard_user'),($1::uuid,$3::uuid,'active','user_admin')`,
            TENANT,
            PROPOSER,
            REVIEWER,
          );
          await tx.$executeRawUnsafe(
            'INSERT INTO clients(id,tenant_id) VALUES ($1::uuid,$2::uuid),($3::uuid,$2::uuid)',
            CLIENT,
            TENANT,
            OTHER_CLIENT,
          );
          let savepoint = 0;
          const scoped = async (tenantId, userId, callback) => {
            const name = `owner_call_${++savepoint}`;
            await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
            try {
              await tx.$executeRawUnsafe(
                `SELECT set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true)`,
                tenantId,
                userId ?? '',
              );
              const answer = await callback(tx);
              await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
              return answer;
            } catch (error) {
              await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
              await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
              throw error;
            }
          };
          const facade = {
            withTenantUser: scoped,
            withTenant: (tenantId, callback) => scoped(tenantId, null, callback),
            // The same owned rollback-only transaction; no production RLS claim.
            withSystem: (callback) => scoped('', null, callback),
          };
          const tenantContext = new TenantContextStore();
          const memoryStore = new MemoryStoreService(facade, tenantContext);
          const memoryCandidates = new MemoryCandidateService(facade, {}, { get: () => undefined });
          const projectionCalls = [];
          memoryCandidates.dispatchProjectionFastPath = (...args) => {
            projectionCalls.push(args.slice(0, 2));
          };
          const manifest = await buildFixtureManifest({
            fixtureInstanceId: randomUUID(),
            actors: { PAT: { tenantId: 'T1', userId: PROPOSER }, PRIYA: { tenantId: 'T1', userId: REVIEWER } },
            clients: {
              ASTER: { tenantId: 'T1', physicalId: CLIENT },
              BLUEHAVEN: { tenantId: 'T1', physicalId: OTHER_CLIENT },
              CEDAR: { tenantId: 'T2', physicalId: '33333333-3333-4333-8333-333333333333' },
            },
          });
          const deps = {
            manifest,
            memoryCandidates,
            memoryStore,
            tenantContext,
            prisma: facade,
            proposerForTenant: () => PROPOSER,
            reviewerForTenant: () => REVIEWER,
            clientMemoryAllowed,
          };
          const runtime = createApprovedMemoryFixtureRuntime(deps);
          result = await work({
            runtime,
            deps,
            tx,
            manifest,
            projectionCalls,
            memoryStore,
            memoryCandidates,
            tenantContext,
          });
          completed = true;
          throw rollback;
        },
        { timeout: 240_000, maxWait: 10_000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
    assert.equal(completed, true, 'Qualification callback completed before rollback');
    return result;
  } finally {
    await prisma?.$disconnect();
    for (const [key, value] of beforeEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      const residue = await probe.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
      assert.equal(
        residue.rowCount,
        0,
        'Owned schema and all fixture data must be absent after rollback',
      );
    } finally {
      await probe.end();
    }
  }
}
