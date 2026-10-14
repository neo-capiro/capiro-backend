'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const e = __dirname;
const { Prisma } = require('/tmp/capirov2-local-native-prerequisite-20261012/core-client');
const schema = fs.readFileSync('/tmp/capirov2-local-native-prerequisite-20261012/core-client/schema.prisma', 'utf8');
const source = cp.execFileSync('git', ['show', '111f269d749cae0249c2141779bd6d7deb93f45c:apps/api/prisma/schema.prisma']);
if (!Buffer.from(schema).equals(source)) throw Error('Exact Core schema required');
const q = (identifier) => { if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) throw Error('Identifier refused'); return '"' + identifier + '"'; };
const lit = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const names = ['Tenant', 'User', 'TenantMembership', 'Client'];
const models = names.map((name) => Prisma.dmmf.datamodel.models.find((m) => m.name === name));
if (models.some((m) => !m)) throw Error('Canonical fixture models absent');
const scalar = (m) => m.fields.filter((f) => f.kind !== 'object');
const blocks = new Map([...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => [m[1],m[2]]));
const usedEnums = new Set(models.flatMap((m) => scalar(m).filter((f) => f.kind === 'enum').map((f) => f.type)));
const sql = ['CREATE EXTENSION IF NOT EXISTS citext;'];
for (const name of usedEnums) {
  const en = Prisma.dmmf.datamodel.enums.find((v) => v.name === name);
  sql.push(`CREATE TYPE ${q(en.dbName ?? name)} AS ENUM (${en.values.map((v) => lit(v.dbName ?? v.name)).join(',')});`);
}
const types = {};
for (const m of models) {
  const fields = scalar(m).map((f) => {
    const line = blocks.get(m.name).split('\n').find((l) => new RegExp('^\\s*'+f.name+'\\s').test(l));
    if (!line) throw Error('Source field not found');
    let type;
    if (f.kind === 'enum') type = q(Prisma.dmmf.datamodel.enums.find((v) => v.name === f.type).dbName ?? f.type);
    else type = { String:'TEXT', Int:'INTEGER', BigInt:'BIGINT', Float:'DOUBLE PRECISION', Decimal:'DECIMAL', Boolean:'BOOLEAN', DateTime:'TIMESTAMPTZ', Json:'JSONB', Bytes:'BYTEA' }[f.type];
    if (line.includes('@db.Uuid')) type='UUID';
    if (line.includes('@db.Citext')) type='CITEXT';
    if (!type) throw Error('Unsupported canonical scalar');
    if (f.isList) type+='[]';
    types[`${m.name}.${f.name}`]=type;
    return `${q(f.dbName ?? f.name)} ${type}${f.isRequired ? ' NOT NULL' : ''}${f.isId ? ' PRIMARY KEY' : ''}`;
  });
  sql.push(`CREATE TABLE ${q(m.dbName ?? m.name)} (${fields.join(',\n')});`);
}
sql.push('CREATE UNIQUE INDEX ON users (clerk_user_id);', 'CREATE UNIQUE INDEX ON tenants (clerk_org_id);', 'CREATE UNIQUE INDEX ON tenant_memberships (tenant_id,user_id);');
// Exact initial canonical invoker helpers and isolation predicates; no migration sweep.
const init = cp.execFileSync('git',['show','111f269d749cae0249c2141779bd6d7deb93f45c:apps/api/prisma/migrations/20260501000000_init_identity_tenancy/migration.sql'],{encoding:'utf8'});
const start=init.indexOf('CREATE OR REPLACE FUNCTION current_tenant_id()');
const end=init.indexOf('-- audit_logs:',start);
if (start<0 || end<0) throw Error('Exact canonical policy source missing');
sql.push(init.slice(start,end));
const clientsPolicy=cp.execFileSync('git',['show','111f269d749cae0249c2141779bd6d7deb93f45c:apps/api/prisma/migrations/20260502000000_user_admin_brand_clients/migration.sql'],{encoding:'utf8'});
const cs=clientsPolicy.indexOf('ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;');
const ce=clientsPolicy.indexOf(';',clientsPolicy.indexOf('WITH CHECK',cs))+1;
if(cs<0 || ce<=cs)throw Error('Exact clients policy missing');
sql.push(clientsPolicy.slice(cs,ce));
const allowed={User:['id','clerkUserId','email','firstName','lastName','title','emailSignatureHtml','emailSignatureEnabled','tourCompletedAt','legiwatchIntroSeenAt','legiwatchPrefs'],Tenant:['id','slug','status','clerkOrgId','name','settings','planTier'],TenantMembership:['id','tenantId','userId','role','status','updatedAt','billingAdmin'],Client:scalar(models.find(m=>m.name==='Client')).map(f=>f.name)};
for(const m of models){const cols=allowed[m.name].map(name=>q(m.fields.find(f=>f.name===name).dbName ?? name));sql.push(`GRANT SELECT (${cols.join(',')}) ON ${q(m.dbName ?? m.name)} TO capiro_app;`);}
// No sequence/function/writer grant and no existing role modification.
fs.writeFileSync(path.join(e,'fixture-schema.sql'),sql.join('\n\n')+'\n');
const ids={tenant:'11111111-1111-4111-8111-111111111111',foreignTenant:'33333333-3333-4333-8333-333333333333',user:'55555555-5555-4555-8555-555555555555',admin:'66666666-6666-4666-8666-666666666666',client:'22222222-2222-4222-8222-222222222222',foreignClient:'44444444-4444-4444-8444-444444444444',membership:'77777777-7777-4777-8777-777777777777',adminMembership:'88888888-8888-4888-8888-888888888888'};
function insert(name, overrides) {
 const m=models.find(m=>m.name===name);const fields=scalar(m).filter(f=>f.isRequired || f.name in overrides);
 const values=fields.map(f=>{
  let v=overrides[f.name];
  if(v===undefined){if(f.isList)v=[];else if(f.kind==='enum')v=Prisma.dmmf.datamodel.enums.find(en=>en.name===f.type).values[0].name;else v={String:'synthetic',Int:0,BigInt:0,Float:0,Decimal:0,Boolean:false,DateTime:'2026-10-13T00:00:00Z',Json:{},Bytes:'\\x'}[f.type];}
  if(v===null)return 'NULL';if(f.isList)return `'{}'::${types[`${name}.${f.name}`]}`;
  if(f.type==='Json')return lit(JSON.stringify(v))+'::jsonb';if(typeof v==='boolean')return v?'TRUE':'FALSE';if(typeof v==='number')return String(v);return lit(v);
 });return `INSERT INTO ${q(m.dbName ?? m.name)} (${fields.map(f=>q(f.dbName ?? f.name)).join(',')}) VALUES (${values.join(',')});`;
}
const seeds=[insert('Tenant',{id:ids.tenant,slug:'capiro-internal',name:'Synthetic internal',status:'active',clerkOrgId:'org_synthetic',planTier:'starter'}),insert('Tenant',{id:ids.foreignTenant,slug:'foreign-fixture',name:'Synthetic foreign',status:'active',clerkOrgId:'org_foreign',planTier:'starter'}),insert('User',{id:ids.user,clerkUserId:'user_synthetic',email:'member@synthetic.invalid'}),insert('User',{id:ids.admin,clerkUserId:'user_admin_fixture',email:'admin@synthetic.invalid'}),insert('TenantMembership',{id:ids.membership,tenantId:ids.tenant,userId:ids.user,role:'standard_user',status:'active',billingAdmin:false}),insert('TenantMembership',{id:ids.adminMembership,tenantId:ids.tenant,userId:ids.admin,role:'capiro_admin',status:'active',billingAdmin:false}),insert('Client',{id:ids.client,tenantId:ids.tenant,name:'Synthetic client',status:'active'}),insert('Client',{id:ids.foreignClient,tenantId:ids.foreignTenant,name:'Foreign synthetic client',status:'active'})];
fs.writeFileSync(path.join(e,'fixture-seed.sql'),seeds.join('\n')+'\n');
fs.writeFileSync(path.join(e,'fixture-projection.json'),JSON.stringify({source_sha256:crypto.createHash('sha256').update(source).digest('hex'),models:models.map(m=>({model:m.name,table:m.dbName ?? m.name,scalar_columns:scalar(m).length})),types,ids,limits:['four-table scalar projection, not full migrated schema','existing local roles only','SELECT grants confined to owned fixtures','native RLS uses exact initial canonical policies']},null,2)+'\n');
console.log(JSON.stringify({models:models.map(m=>({model:m.name,columns:scalar(m).length})),usedEnums:[...usedEnums]}));
