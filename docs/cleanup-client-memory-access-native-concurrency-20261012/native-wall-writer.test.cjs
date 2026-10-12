'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { TARGET, validateTarget, boundTag, adapter, verifyBindings, loadOwners, main } = require('./native-wall-writer.cjs');
const apiRequire = createRequire(path.resolve(__dirname, '../../apps/api/package.json'));
const base = { dataDirectory: TARGET.dataDirectory, user: TARGET.user, database: TARGET.database, systemIdentifier: TARGET.systemIdentifier, listenAddresses: '', inetServerAddr: null, version: 'PostgreSQL 16.15 (synthetic receipt)', publicTables: 0 };

test('two actual owner source hashes and original writer snapshot verify without driver loading',()=>{
  const binding=verifyBindings();assert.equal(binding.entries.length,2);assert.equal(binding.sourceHead,'926b269ad6e3b5ed789b5d18f55306df310d046c');
});
test('baseline validateTarget and boundTag protocol bodies are byte-exact',()=>{
  const ts=apiRequire('typescript');
  function extract(text,name){const file=ts.createSourceFile('protocol.cjs',text,ts.ScriptTarget.Latest,true);const nodes=file.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.equal(nodes.length,1);return nodes[0].getText(file);}
  const old=fs.readFileSync(path.join(__dirname,'evidence/baseline-harness.cjs.txt'),'utf8');
  const current=fs.readFileSync(path.join(__dirname,'native-wall-writer.cjs'),'utf8');
  for(const name of ['validateTarget','boundTag'])assert.equal(extract(current,name),extract(old,name));
});
test('exact root target protocol accepts the pinned receipt without connecting',()=>assert.deepEqual(validateTarget(base),TARGET));
for(const [key,value] of [['dataDirectory','/tmp/foreign'],['user','foreign'],['database','foreign'],['systemIdentifier','0'],['listenAddresses','localhost'],['inetServerAddr','127.0.0.1'],['version','PostgreSQL 15.0'],['publicTables',1]])test(`target mismatch refuses ${key}`,()=>assert.throws(()=>validateTarget({...base,[key]:value})));
for(const key of ['password','connectionString','url'])test(`credential/URL input refuses ${key}`,()=>assert.throws(()=>validateTarget({...base,[key]:'inert'})));
test('target protocol refuses a symlinked data/socket envelope',()=>{
  const original=fs.realpathSync;fs.realpathSync=()=>'/tmp/foreign';
  try{assert.throws(()=>validateTarget(base),/symlink/);}finally{fs.realpathSync=original;}
});
for(const args of [[],['--run'],['--run','--run'],['--plan','--run'],['--unknown'],['--run','--verified-target','not-read','--output',path.join(__dirname,'fixture.sql')]])test(`CLI refuses before native driver/SQL: ${JSON.stringify(args)}`,async()=>assert.rejects(()=>main(args)));
test('tagged SQL separates hostile values from static SQL',()=>{
  const hostile="literal ' ; DROP TABLE never_executed";
  const tag=(strings,...values)=>boundTag(strings,values);
  assert.deepEqual(tag`SELECT ${hostile}::text,${7}::int`,{text:'SELECT $1::text,$2::int',values:[hostile,7]});
  assert.throws(()=>boundTag(['not a tag'],[]));
});
test('adapter preserves actual current argument shapes and binds every model operation',async()=>{
  const calls=[];const tx=adapter({query:async(text,values)=>{calls.push({text,values});return {rows:[{id:'synthetic',memoryWall:true}],rowCount:1};}});
  await tx.client.findFirst({where:{id:'c',tenantId:'t'},select:{id:true,memoryWall:true}});
  await tx.client.update({where:{id:'c'},data:{memoryWall:false}});
  await tx.tenantMembership.findMany({where:{tenantId:'t',userId:{in:['u']}},select:{userId:true}});
  await tx.clientMemoryAccess.findMany({where:{tenantId:'t',clientId:'c'},select:{userId:true}});
  await tx.clientMemoryAccess.createMany({data:[{tenantId:'t',clientId:'c',userId:'u',grantedBy:'a'}]});
  await tx.clientMemoryAccess.deleteMany({where:{tenantId:'t',clientId:'c',userId:{in:['old']}}});
  await tx.auditLog.create({data:{tenantId:'t',actorUserId:'a',actorRole:'user_admin',action:'client.memory_wall.update',entityType:'client',entityId:'c',before:{memoryWall:true,grantedUserIds:['old']},after:{memoryWall:false,grantedUserIds:['u']}}});
  assert.equal(calls.length,7);assert.deepEqual(calls[0].values,['c','t']);assert.deepEqual(calls[4].values,['t','c','u','a']);
  assert.deepEqual(JSON.parse(calls[6].values[6]),{memoryWall:true,grantedUserIds:['old']});
  assert.deepEqual(JSON.parse(calls[6].values[7]),{memoryWall:false,grantedUserIds:['u']});
});
test('adapter refuses unexpected ORM shapes before fake query',async()=>{
  let queries=0;const tx=adapter({query:async()=>{queries++;throw new Error('must not query');}});
  await assert.rejects(()=>tx.client.findFirst({where:{id:'c'},select:{id:true}}));
  await assert.rejects(()=>tx.client.update({where:{id:'c',tenantId:'t'},data:{memoryWall:true}}));
  await assert.rejects(()=>tx.clientMemoryAccess.createMany({data:[{tenantId:'t',clientId:'c',userId:'u',grantedBy:'a',skipDuplicates:true}]}));
  await assert.rejects(()=>tx.auditLog.create({data:{tenantId:'t'}}));assert.equal(queries,0);
});
test('same-realm actual original/candidate fragments execute through fake adapter; only candidate starts with bound lock',async()=>{
  const owners=loadOwners();const context={tenantId:'t',userId:'a',role:'user_admin'};
  async function run(Owner){
    const calls=[];
    const client={query:async(text,values)=>{
      calls.push({text,values});
      const rows=text.includes('memory_wall AS')?[{id:'c',memoryWall:true}]:text.includes('FROM tenant_memberships')?[{userId:'u'}]:text.includes('FROM client_memory_access')?[{userId:'u'}]:[{id:'c'}];
      return {rows,rowCount:rows.length};
    }};
    const fragment=new Owner({withTenant:async(tenant,callback)=>{assert.equal(tenant,'t');return callback(adapter(client));}});
    const result=await fragment.setMemoryAccess(context,'c',{memoryWall:true,userIds:['u','u']});
    return {calls,result};
  }
  const old=await run(owners.original),candidate=await run(owners.candidate);
  assert.match(old.calls[0].text,/FROM clients WHERE id/);assert.match(candidate.calls[0].text,/FOR UPDATE/);
  assert.deepEqual(candidate.calls[0].values,['t','c']);assert.deepEqual(old.calls,candidate.calls.slice(1));assert.deepEqual(old.result,candidate.result);
});
test('runner performs no native Prisma/client/installer or blanket cleanup',()=>{
  const text=fs.readFileSync(path.join(__dirname,'native-wall-writer.cjs'),'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,'');
  assert(!/CREATE\s+(?:DATABASE|EXTENSION)|DROP\s+OWNED|DATABASE_URL|PrismaClient|prisma\s+generate/.test(text));
  assert(text.includes('NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'));
  assert(text.includes('createdRoles.push(role)'));assert(text.includes('if(schemaCreated)'));
  assert(text.includes('nativePrisma:false'));assert(text.includes('fullClientAuditLogSchema:false'));
});
