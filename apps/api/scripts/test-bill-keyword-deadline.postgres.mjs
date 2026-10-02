import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
require('tsx/cjs');
const { PrismaClient, Prisma } = require('@prisma/client');
const { Client } = require('pg');
const { withBillKeywordSqlDeadline, withBillKeywordProfileDeadline, BillKeywordDeadlineExceeded } = require('../src/intelligence/bill-keyword-deadline.ts');
const passed = [];
let stage = 'configuration';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
assert.ok(configPath && isAbsolute(configPath), 'Explicit owned local PostgreSQL config required');
const config = JSON.parse(await readFile(configPath, 'utf8'));
assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 55433);
assert.equal(config.scope, 'owned local disposable test cluster; no AWS connection');
assert.ok(['user', 'password', 'database', 'dataDirectory'].every((k) => typeof config[k] === 'string' && config[k]));
assert.ok(isAbsolute(config.dataDirectory));
const probe = new Client({host: config.host, port: config.port, user: config.user, password: config.password, database: config.database, connectionTimeoutMillis: 3000});
let prisma;
try {
  await probe.connect();
  const actual = (await probe.query(`SELECT current_user=$1 AS owner_matches, host(inet_server_addr()) AS address, inet_server_port() AS port, current_setting('data_directory') AS data_directory`, [config.user])).rows[0];
  assert.equal(actual.owner_matches, true); assert.equal(actual.address, config.host); assert.equal(actual.port, config.port);
  assert.equal(actual.data_directory.replaceAll('\\','/'), config.dataDirectory.replaceAll('\\','/'));
  const url = new URL(`postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@127.0.0.1:55433/${encodeURIComponent(config.database)}`);
  url.searchParams.set('connection_limit','1'); url.searchParams.set('pool_timeout','5');
  prisma = new PrismaClient({datasources:{db:{url:url.toString()}},log:[]});
  await prisma.$connect();
  const before = (await prisma.$queryRaw`SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS timeout`)[0];

  stage='count cancellation and pool reuse';
  let rowStarted=false; const start=performance.now();
  await assert.rejects(withBillKeywordSqlDeadline(prisma, async(q)=>{
    await q(Prisma.sql`SELECT 1 AS n FROM pg_sleep(3)`); rowStarted=true;
    return q(Prisma.sql`SELECT 2 AS n`);
  },150), (e)=>e.code==='P2010' && e.meta?.code==='57014');
  assert.equal(rowStarted,false); assert.ok(performance.now()-start<1500);
  let activity=(await probe.query('SELECT state FROM pg_stat_activity WHERE pid=$1',[before.pid])).rows[0];
  assert.ok(activity && activity.state!=='active' && activity.state!=='idle in transaction (aborted)');
  const after=(await prisma.$queryRaw`SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS timeout`)[0];
  assert.deepEqual(after,before); passed.push(stage);

  stage='rows share remaining count budget';
  let completedCount=false,remainingSetting=''; const started=performance.now();
  await assert.rejects(withBillKeywordSqlDeadline(prisma,async(q)=>{
    await q(Prisma.sql`SELECT 1 AS n FROM pg_sleep(0.15)`); completedCount=true;
    remainingSetting=(await q(Prisma.sql`SELECT current_setting('statement_timeout') AS timeout`))[0].timeout;
    return q(Prisma.sql`SELECT 2 AS n FROM pg_sleep(3)`);
  },300),(e)=>e.code==='P2010' && e.meta?.code==='57014');
  assert.equal(completedCount,true); assert.ok(parseInt(remainingSetting,10)>0 && parseInt(remainingSetting,10)<200);
  assert.ok(performance.now()-started<1500);
  assert.deepEqual((await prisma.$queryRaw`SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS timeout`)[0],before); passed.push(stage);

  stage='successful count and row result preserved';
  const result=await withBillKeywordSqlDeadline(prisma,async(q)=>{
    const count=await q(Prisma.sql`SELECT COUNT(*)::bigint AS total FROM generate_series(1,3)`);
    const rows=await q(Prisma.sql`SELECT n FROM generate_series(1,3) AS n ORDER BY n`);
    return {count,rows};
  });
  assert.deepEqual(result,{count:[{total:3n}],rows:[{n:1},{n:2},{n:3}]}); passed.push(stage);

  stage='late fallback cannot outlive profile scope';
  let acquired=false;
  const observed={$transaction:async(...args)=>{acquired=true; return prisma.$transaction(...args);}};
  await assert.rejects(withBillKeywordProfileDeadline(async()=>{
    await delay(35);return withBillKeywordSqlDeadline(observed,(q)=>q(Prisma.sql`SELECT 1`));
  },15),BillKeywordDeadlineExceeded);
  assert.equal(acquired,false);passed.push(stage);

  stage='serial work resumes only after cancelled query settled';
  const outcomes=[];
  for (let i=0;i<2;i++) {
    try { await withBillKeywordSqlDeadline(prisma,(q)=>q(i===0 ? Prisma.sql`SELECT 1 AS n FROM pg_sleep(3)` : Prisma.sql`SELECT 2 AS n`),120); outcomes.push('complete'); }
    catch(e) {assert.equal(e.meta?.code,'57014');outcomes.push('cancelled');}
    activity=(await probe.query('SELECT state FROM pg_stat_activity WHERE pid=$1',[before.pid])).rows[0];
    assert.ok(activity && activity.state!=='active' && !activity.state.startsWith('idle in transaction'));
  }
  assert.deepEqual(outcomes,['cancelled','complete']);passed.push(stage);
  console.log(JSON.stringify({status:'PASS',passed:passed.length,checks:passed,skipped:0,cluster:'owned loopback55433',databaseWrites:0,sharedDatabaseAccess:false}));
} catch(error) {
  console.error(JSON.stringify({status:'FAIL',stage,errorClass:error?.name??'Error',prismaCode:error?.code??null,sqlState:error?.meta?.code??null,passed}));
  process.exitCode=1;
} finally {await prisma?.$disconnect();await probe.end();}
