'use strict';
// Synthetic catalog facts only. No PostgreSQL, network, environment or child processes.
const {assess,TABLES,PRIVILEGES}=require('./assess-role-acl.cjs');
function role(oid,name,attrs={}) {return {oid,name,superuser:false,bypass_rls:false,create_role:false,
  create_database:false,replication:false,login:false,default_inherit:true,...attrs};}
function fixture() {
  const s={format:'engagement-role-acl-v1',boundExpectedDatabase:'synthetic_qualification',database:'synthetic_qualification',
    serverVersionNum:160014,serverVersion:'PostgreSQL 16.14 synthetic',observedAt:'2026-10-16T00:00:00Z',
    sessionUser:'authorized_reader',currentUser:'authorized_reader',transactionReadOnly:'on',transactionIsolation:'repeatable read',searchPath:'pg_catalog, pg_temp',
    roles:[role(10,'capiro_app',{login:true}),role(20,'capiro_master',{create_role:true}),
      role(30,'plain_parent'),role(40,'scratch_admin',{superuser:true})],
    memberships:[{oid:500,member_oid:20,role_oid:10,grantor_oid:40,admin_option:false,inherit_option:true,set_option:true}],
    tables:TABLES.map((name,i)=>({schema_name:'public',table_name:name,oid:100+i,owner_oid:20,owner_name:'capiro_master',
      kind:'r',persistence:'p',rls_enabled:true,rls_forced:true,raw_acl:'synthetic expanded below'})),
    tableAcl:[],columns:[],columnAcl:[],defaultAcl:[],appReach:[],roleTable:[],catalogCounts:{}};
  for (const t of s.tables) {
    s.columns.push({table_oid:t.oid,number:1,name:'id',raw_acl:null});
    for (const p of PRIVILEGES) s.tableAcl.push({table_oid:t.oid,grantor_oid:20,grantee_oid:20,privilege_type:p,is_grantable:false});
    for (const p of ['SELECT','INSERT',...(['engagement_plans','engagement_plan_waves'].includes(t.table_name)?['UPDATE']:[])])
      s.tableAcl.push({table_oid:t.oid,grantor_oid:20,grantee_oid:10,privilege_type:p,is_grantable:false});
  }
  s.defaultAcl=[{oid:700,owner_oid:20,schema_oid:2200,schema_name:'public',raw_acl:'documented ALL default',
    entries:PRIVILEGES.map(privilege_type=>({grantor:20,grantee:10,privilege_type,is_grantable:false}))}];
  return rebuild(s);
}
function inherited(s,id,option) {
  const result=new Set([id]);
  if (s.roles.find(r=>r.oid===id).superuser) return new Set(s.roles.map(r=>r.oid));
  let changed=true;
  while(changed) {changed=false; for (const m of s.memberships)
    if (result.has(m.member_oid) && (!option || m[option]) && !result.has(m.role_oid)) {
      result.add(m.role_oid); changed=true;
    }}
  return result;
}
function rebuild(s) {
  s.appReach=s.roles.map(r=>({role_oid:r.oid,member:inherited(s,10).has(r.oid),
    usage:inherited(s,10,'inherit_option').has(r.oid),can_set:inherited(s,10,'set_option').has(r.oid)}));
  s.roleTable=s.roles.flatMap(r=>s.tables.map(t=>{
    const held=inherited(s,r.oid,'inherit_option'),owner_usage=held.has(t.owner_oid),effective={},grantable={};
    for (const p of PRIVILEGES) {
      const matches=s.tableAcl.filter(a=>a.table_oid===t.oid && a.privilege_type===p &&
        (a.grantee_oid===0 || held.has(a.grantee_oid)));
      effective[p]=r.superuser || matches.length>0;
      grantable[p]=owner_usage || matches.some(a=>a.is_grantable);
    }
    return {role_oid:r.oid,table_oid:t.oid,owner_usage,effective,grantable,
      any_column_update:effective.UPDATE || s.columnAcl.some(a=>a.table_oid===t.oid&&a.privilege_type==='UPDATE'&&
        (a.grantee_oid===0||held.has(a.grantee_oid)))};
  }));
  return recount(s);
}
function recount(s) {for(const k of ['roles','memberships','tables','appReach','tableAcl','columns','columnAcl','roleTable','defaultAcl']) s.catalogCounts[k]=s[k].length;return s;}
function edge(s,member,role,inherit,set,admin=false) {
  s.memberships.push({oid:900+s.memberships.length,member_oid:member,role_oid:role,grantor_oid:40,
    inherit_option:inherit,set_option:set,admin_option:admin});return s;
}
function acl(s,table,grantee,priv,grantable=false) {
  s.tableAcl.push({table_oid:s.tables[table].oid,grantor_oid:20,grantee_oid:grantee,privilege_type:priv,is_grantable:grantable});return s;
}
const outcomes=[];
function test(name,mutate,expected='UNSAFE',check) {
  const s=fixture();mutate(s);
  const result=assess(s,'synthetic_qualification');
  if (result.status!==expected || result.qualified!==(expected==='PASS') || (check&&!check(result)))
    throw new Error(name+': '+JSON.stringify(result));
  outcomes.push({name,status:result.status,passed:true});
}
test('hardened reverse membership and future ALL defaults',()=>{},'PASS');
for (const flag of ['superuser','bypass_rls','create_role']) {
  test('app '+flag,s=>{s.roles[0][flag]=true;rebuild(s);});
  test('SET-only context '+flag,s=>{s.roles[2][flag]=true;edge(s,10,30,false,true);rebuild(s);});
}
test('direct app TRUNCATE',s=>{acl(s,0,10,'TRUNCATE');rebuild(s);});
test('PUBLIC TRUNCATE',s=>{acl(s,2,0,'TRUNCATE');rebuild(s);});
test('PUBLIC DELETE',s=>{acl(s,1,0,'DELETE');rebuild(s);});
test('direct app DELETE',s=>{acl(s,0,10,'DELETE');rebuild(s);});
test('history UPDATE',s=>{acl(s,3,10,'UPDATE');rebuild(s);});
test('history column UPDATE',s=>{s.columnAcl.push({table_oid:102,number:1,grantee_oid:10,grantor_oid:20,privilege_type:'UPDATE',is_grantable:false});rebuild(s);});
test('inherited parent TRUNCATE',s=>{acl(s,0,30,'TRUNCATE');edge(s,10,30,true,false);rebuild(s);});
test('NOINHERIT SET-only parent TRUNCATE',s=>{s.roles[0].default_inherit=false;acl(s,0,30,'TRUNCATE');edge(s,10,30,false,true);rebuild(s);});
test('per-member INHERIT overrides role default NOINHERIT',s=>{s.roles[0].default_inherit=false;acl(s,0,30,'TRUNCATE');edge(s,10,30,true,false);rebuild(s);});
test('both membership options false do not expose ordinary privileges',s=>{acl(s,0,30,'TRUNCATE');edge(s,10,30,false,false);rebuild(s);},'PASS');
test('SET then inherited dangerous role',s=>{s.roles.push(role(50,'nested_parent'));acl(s,0,50,'TRUNCATE');edge(s,10,30,false,true);edge(s,30,50,true,false);rebuild(s);});
test('owner SET-only even ordinary owner privileges revoked',s=>{s.memberships=[];s.tableAcl=s.tableAcl.filter(a=>a.grantee_oid!==20);edge(s,10,20,false,true);rebuild(s);});
test('owner INHERIT-only even ordinary owner privileges revoked',s=>{s.memberships=[];s.roles[1].create_role=false;s.tableAcl=s.tableAcl.filter(a=>a.grantee_oid!==20);edge(s,10,20,true,false);rebuild(s);});
test('SET context inherits owner without direct owner SET path',s=>{s.memberships=[];s.roles[1].create_role=false;edge(s,10,30,false,true);edge(s,30,20,true,false);rebuild(s);});
test('provider rds_superuser inheritance despite false standard flags',s=>{s.roles.push(role(50,'rds_superuser'));edge(s,10,50,true,false);rebuild(s);});
test('provider rds_superuser SET-only despite false standard flags',s=>{s.roles.push(role(50,'rds_superuser'));edge(s,10,50,false,true);rebuild(s);});
test('unreachable provider role does not imply authority',s=>{s.roles.push(role(50,'rds_superuser'));rebuild(s);},'PASS');
test('standard special attributes do not inherit as object privileges',s=>{s.roles[2].create_role=true;edge(s,10,30,true,false);rebuild(s);},'PASS');
test('ADMIN-only owner self-regrant path never qualifies',s=>{s.memberships=[];edge(s,10,20,false,false,true);rebuild(s);},'UNKNOWN');
test('ADMIN option from reachable context never qualifies',s=>{edge(s,10,30,false,true);edge(s,30,20,false,false,true);rebuild(s);},'UNKNOWN');
test('forbidden grant option even effective flag absent',s=>{const p=s.roleTable.find(p=>p.role_oid===10&&p.table_oid===100);p.grantable.TRUNCATE=true;});
test('RLS disabled',s=>{s.tables[0].rls_enabled=false;});
test('FORCE RLS disabled',s=>{s.tables[1].rls_forced=false;});
test('unexpected table owner',s=>{s.tables[0].owner_name='plain_parent';s.tables[0].owner_oid=30;rebuild(s);});
for(const [name,mutate] of [
  ['future PostgreSQL major',s=>{s.serverVersionNum=170001;}],
  ['older PostgreSQL major',s=>{s.serverVersionNum=150014;}],
  ['wrong independent database binding',s=>{s.database='other';}],
  ['missing bound database',s=>{delete s.boundExpectedDatabase;}],
  ['read-write transaction',s=>{s.transactionReadOnly='off';}],
  ['wrong isolation',s=>{s.transactionIsolation='read committed';}],
  ['missing search path metadata',s=>{delete s.searchPath;}],
  ['untrusted-first search path',s=>{s.searchPath='public, pg_catalog';}],
  ['catalog-only path leaves implicit temporary type search',s=>{s.searchPath='pg_catalog';}],
  ['missing table before migration',s=>{s.tables[0].oid=null;s.tables[0].owner_oid=null;s.tables[0].owner_name=null;}],
  ['duplicate table identity',s=>{s.tables[1]={...s.tables[0]};}],
  ['duplicate role name',s=>{s.roles[2].name='capiro_app';}],
  ['missing owner role',s=>{s.roles=s.roles.filter(r=>r.name!=='capiro_master');recount(s);}],
  ['missing role fact without cardinality update',s=>{s.roles.pop();}],
  ['missing native role-table row even counters repaired',s=>{s.roleTable.pop();recount(s);}],
  ['duplicate native role-table row',s=>{s.roleTable[0]=s.roleTable[1];}],
  ['missing privilege vector field',s=>{delete s.roleTable[0].effective.TRUNCATE;}],
  ['string boolean false',s=>{s.roleTable[0].effective.TRUNCATE='false';}],
  ['native USAGE contradicts membership',s=>{s.appReach.find(r=>r.role_oid===30).usage=true;}],
  ['native SET contradicts membership',s=>{s.appReach.find(r=>r.role_oid===30).can_set=true;}],
  ['native owner reach contradicts graph',s=>{s.roleTable.find(p=>p.role_oid===10).owner_usage=true;}],
  ['unknown ACL grantee role',s=>{s.tableAcl[0].grantee_oid=99999;}],
  ['duplicate ACL row',s=>{s.tableAcl.push({...s.tableAcl[0]});recount(s);}],
  ['unbound history column ACL',s=>{s.columnAcl.push({table_oid:102,number:99,grantee_oid:10,grantor_oid:20,privilege_type:'UPDATE',is_grantable:false});recount(s);}],
  ['missing columns',s=>{s.columns=s.columns.filter(c=>c.table_oid!==100);recount(s);}],
  ['malformed default ACL grant',s=>{s.defaultAcl[0].entries[0].grantee=99999;}],
  ['malformed role row returns UNKNOWN rather than throwing',s=>{s.roles[0]=null;}],
]) test(name,mutate,'UNKNOWN');
test('native effective privilege contradicts inherited raw ACL',s=>{acl(s,0,30,'TRUNCATE');edge(s,10,30,true,false);rebuild(s);s.roleTable.find(p=>p.role_oid===10&&p.table_oid===100).effective.TRUNCATE=false;},'UNKNOWN');
test('native owner grant-option contradiction',s=>{s.roleTable.find(p=>p.role_oid===20).grantable.TRUNCATE=false;},'UNKNOWN');
test('native column privilege contradiction',s=>{s.roleTable.find(p=>p.role_oid===10&&p.table_oid===100).any_column_update=false;},'UNKNOWN');
test('duplicate default ACL entry',s=>{s.defaultAcl[0].entries.push({...s.defaultAcl[0].entries[0]});},'UNKNOWN');
test('duplicate column names',s=>{s.columns.push({...s.columns[0],number:2});recount(s);},'UNKNOWN');
test('cyclic catalog membership is malformed even with no effective options',s=>{s.memberships=[];edge(s,10,30,false,false);edge(s,30,10,false,false);rebuild(s);},'UNKNOWN');
const malformed=assess(null,'synthetic_qualification');
if(malformed.qualified || malformed.status!=='UNKNOWN')throw Error('Null input qualified');
outcomes.push({name:'null snapshot fails closed',status:'UNKNOWN',passed:true});
console.log(JSON.stringify({mode:'pure synthetic offline only',executedAt:new Date().toISOString(),tests:outcomes.length,
  passed:outcomes.length,failed:0,outcomes},null,2));
