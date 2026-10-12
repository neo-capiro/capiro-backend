'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TARGET, SOURCE_HEAD, validateTarget, adapter, main } = require('./native-contract-harness.cjs');
const { verifyBindings, loadCanonical } = require('./canonical-loader.cjs');
const { assembleFixture, between } = require('./fixture-assembly.cjs');
const base = { dataDirectory: TARGET.dataDirectory, user: TARGET.user, database: TARGET.database, systemIdentifier: TARGET.systemIdentifier, listenAddresses: '', inetServerAddr: null, version: 'PostgreSQL 16.15 (Debian synthetic receipt)', publicTables: 0 };

test('all 59 pinned source byte hashes verify without database',()=>{ const receipt=verifyBindings();assert.equal(receipt.sourceHead,SOURCE_HEAD);assert.equal(receipt.entries.length,59); });
test('fixture source parts assemble without SQL execution',()=>{const parts=assembleFixture();assert.equal(parts.length,21);assert(parts.some(p=>p.sql.includes('REVOKE UPDATE, DELETE ON "outreach_events"')));assert(parts.some(p=>p.sql.includes('client_objective_revisions')));assert(!parts.some(p=>p.sql.includes('UPDATE "context_embeddings" ce')));});
test('source extraction rejects missing or duplicate boundaries',()=>{assert.throws(()=>between('abc','missing',null));assert.throws(()=>between('start\nstart\nend','start','end'));assert.equal(between('before start payload end after','start','end'),'start payload ');});
for(const [key,value] of [['dataDirectory','/tmp/unknown'],['user','capiro'],['database','capiro'],['systemIdentifier','0'],['listenAddresses','localhost'],['inetServerAddr','127.0.0.1'],['version','PostgreSQL 15.0'],['publicTables',1]])test(`target refuses mismatched ${key}`,()=>assert.throws(()=>validateTarget({...base,[key]:value})));
for(const key of ['password','connectionString','url'])test(`target refuses ${key} input`,()=>assert.throws(()=>validateTarget({...base,[key]:'inert'})));
for(const args of [[],['--run'],['--run','--run'],['--plan','--run'],['--unknown'],['--run','--verified-target','unused','--output',path.join(__dirname,'README.md')]])test(`CLI rejects before driver work: ${JSON.stringify(args)}`,async()=>{await assert.rejects(()=>main(args));});
test('actual canonical pure owners and reducers load through finite refusal loader',()=>{
 const owners=loadCanonical();assert.equal(owners.workspace.canonicalWorkspaceSnapshot({z:2,a:1}),' {"a":1,"z":2}'.trim());
 assert.equal(owners.workspace.workspaceCanRead('pending'),false);assert.equal(owners.workspace.workspaceCanRead('viewer'),true);
 const spec=owners.campaign.createBlankCampaignSpecV1();assert.equal(owners.campaign.hashCampaignSpecV1(spec).length,64);
 const evidence=owners.evidence.buildEffectiveDateEvidence({document_number:'2026-12345',type:'RULE',publication_date:'2026-10-01',effective_on:null,pdf_url:null,correction_of:null,corrections:[]},new Date('2026-10-12T00:00:00Z'));
 assert.equal(evidence.status,'missing_date');assert.equal(evidence.date,null);assert.equal(evidence.dateKind,'effective');
 assert.equal(owners.loadedFiles.length,19);assert(!owners.loadedFiles.some(f=>f.endsWith('prisma.service.ts')));
});
test('PG transaction adapter binds tagged values without interpolation and preserves rowCount',async()=>{
 const seen=[];const client={query:async(text,values)=>{seen.push({text,values});return{rows:[{ok:true}],rowCount:1};}};
 const tx=adapter(client);const hostile="literal ' ; DROP TABLE not_executed";
 assert.deepEqual(await tx.$queryRaw`SELECT ${hostile}::text AS value,${7} AS n`,[{ok:true}]);
 assert.deepEqual(seen[0],{text:'SELECT $1::text AS value,$2 AS n',values:[hostile,7]});
 assert.equal(await tx.$executeRaw`UPDATE inert SET n=${1}`,1);
 assert.deepEqual(await tx.$queryRawUnsafe('SELECT $1::text',hostile),[{ok:true}]);
});
test('PG model projection adapters refuse unexpected arguments',async()=>{
 const tx=adapter({query:async()=>{throw new Error('query must not be called');}});
 await assert.rejects(()=>tx.client.findFirst({where:{id:'x'},select:{id:true}}));
 await assert.rejects(()=>tx.syncRun.findFirst({where:{source:'x',tenantId:'x'},orderBy:{startedAt:'desc'},select:{}}));
});
test('harness contains no credential/database/extension installer or blanket cleanup',()=>{
 const source=fs.readFileSync(path.join(__dirname,'native-contract-harness.cjs'),'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,'');
 assert(!/CREATE\s+(?:DATABASE|EXTENSION)|LOGIN\s+PASSWORD|DROP\s+OWNED|DATABASE_URL/.test(source));
 assert(source.includes('NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'));
});
