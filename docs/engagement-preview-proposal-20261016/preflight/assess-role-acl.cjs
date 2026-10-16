'use strict';
// Pure offline assessor. No driver, connection, process, environment or database API.
const TABLES = ['engagement_plans','engagement_plan_waves','engagement_plan_command_receipts','engagement_plan_revisions'];
const PRIVILEGES = ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
const FLAGS = ['superuser','bypass_rls','create_role','create_database','replication','login','default_inherit'];
const ARRAYS = ['roles','memberships','tables','appReach','tableAcl','columns','columnAcl','roleTable','defaultAcl'];
const own = (v,k) => Object.prototype.hasOwnProperty.call(v,k);
const object = v => v !== null && typeof v==='object' && !Array.isArray(v);
const oid = v => Number.isInteger(v) && v>0 && v<=4294967295;
function assessFacts(s, expectedDatabase) {
  const unknown=[], unsafe=[], warnings=[];
  const fail = message => unknown.push(message);
  const bad = message => unsafe.push(message);
  const finish = () => ({
    scope:'Four Engagement tables: role/ACL necessary precondition only',
    status:unknown.length?'UNKNOWN':unsafe.length?'UNSAFE':'PASS',
    qualified:unknown.length===0 && unsafe.length===0, unknown, unsafe, warnings
  });
  if (!object(s)) { fail('Snapshot object missing'); return finish(); }
  if (s.format!=='engagement-role-acl-v1') fail('Unsupported snapshot format');
  if (typeof expectedDatabase!=='string' || !expectedDatabase.trim() ||
      s.boundExpectedDatabase!==expectedDatabase || s.database!==expectedDatabase)
    fail('Independently supplied database binding does not match');
  if (!Number.isInteger(s.serverVersionNum) || s.serverVersionNum<160000 || s.serverVersionNum>=170000)
    fail('Only PostgreSQL major 16 has reviewed semantics');
  if (s.transactionReadOnly!=='on' || s.transactionIsolation!=='repeatable read')
    fail('Required read-only repeatable-read envelope absent');
  if (s.searchPath!=='pg_catalog, pg_temp') fail('Required canonical search path absent or unsafe');
  if (typeof s.observedAt!=='string' || !Number.isFinite(Date.parse(s.observedAt)) ||
      typeof s.sessionUser!=='string' || !s.sessionUser || typeof s.currentUser!=='string' || !s.currentUser ||
      typeof s.serverVersion!=='string' || !s.serverVersion) fail('Observation identity metadata malformed');
  if (!object(s.catalogCounts)) fail('Catalog cardinalities absent');
  for (const key of ARRAYS) {
    if (!Array.isArray(s[key])) fail(key+' array absent');
    else if (!object(s.catalogCounts) || !Number.isInteger(s.catalogCounts[key]) ||
             s.catalogCounts[key]!==s[key].length) fail(key+' cardinality mismatch');
  }
  if (unknown.length) return finish();
  const unique = (rows,key,label) => {
    const found=new Set();
    for (const row of rows) {
      if (!object(row)) { fail(label+' malformed row'); continue; }
      const value=key(row);
      if (found.has(value)) fail(label+' duplicate row '+value);
      found.add(value);
    }
  };
  unique(s.roles,r=>r.oid,'roles'); unique(s.roles,r=>r.name,'role names');
  const roles=new Map(s.roles.map(r=>[r.oid,r]));
  for (const r of s.roles) if (!oid(r.oid) || typeof r.name!=='string' || !r.name ||
      FLAGS.some(f=>typeof r[f]!=='boolean')) fail('Malformed role attributes');
  const app=s.roles.find(r=>r.name==='capiro_app'), master=s.roles.find(r=>r.name==='capiro_master');
  if (!app || !master || !app.login) fail('Required runtime/owner role absent or runtime cannot login');
  unique(s.memberships,m=>m.oid,'memberships');
  for (const m of s.memberships) if (!oid(m.oid) || !roles.has(m.member_oid) || !roles.has(m.role_oid) ||
      !roles.has(m.grantor_oid) || ['admin_option','inherit_option','set_option'].some(k=>typeof m[k]!=='boolean'))
    fail('Membership has missing roles or flags');
  unique(s.tables,t=>t.schema_name+'.'+t.table_name,'tables');
  if (s.tables.length!==4 || TABLES.some(name=>!s.tables.some(t=>t.schema_name==='public'&&t.table_name===name)))
    fail('Exact four public table identities required');
  for (const t of s.tables) {
    if (!oid(t.oid) || !roles.has(t.owner_oid)) fail('Required table missing/unresolved: '+t.table_name);
    if (t.owner_name!=='capiro_master' || (master && t.owner_oid!==master.oid))
      bad('Unexpected table owner: '+t.table_name);
    if (t.kind!=='r' || t.persistence!=='p') fail('Expected permanent ordinary table: '+t.table_name);
    if (typeof t.rls_enabled!=='boolean' || typeof t.rls_forced!=='boolean' ||
        !(t.raw_acl===null || typeof t.raw_acl==='string')) fail('Malformed table facts');
    if (t.rls_enabled===false || t.rls_forced===false) bad('Required ENABLE/FORCE RLS absent: '+t.table_name);
  }
  unique(s.tables,t=>t.oid,'table OIDs');
  const tables=new Map(s.tables.filter(t=>oid(t.oid)).map(t=>[t.oid,t]));
  unique(s.columns,c=>c.table_oid+':'+c.number,'columns');
  unique(s.columns,c=>c.table_oid+':'+c.name,'column names');
  for (const c of s.columns) if (!tables.has(c.table_oid) || !Number.isInteger(c.number) || c.number<1 ||
      typeof c.name!=='string' || !c.name || !(c.raw_acl===null || typeof c.raw_acl==='string'))
    fail('Malformed/unbound column row');
  for (const t of tables.values()) if (!s.columns.some(c=>c.table_oid===t.oid)) fail('Column facts missing: '+t.table_name);
  const columnKeys=new Set(s.columns.map(c=>c.table_oid+':'+c.number));
  for (const [label,rows] of [['tableAcl',s.tableAcl],['columnAcl',s.columnAcl]]) {
    unique(rows,a=>[a.table_oid,a.number||0,a.grantee_oid,a.grantor_oid,a.privilege_type].join(':'),label);
    for (const a of rows) if (!tables.has(a.table_oid) || !(a.grantee_oid===0 || roles.has(a.grantee_oid)) ||
      !roles.has(a.grantor_oid) || !PRIVILEGES.includes(a.privilege_type) || typeof a.is_grantable!=='boolean' ||
      (label==='columnAcl' && (!columnKeys.has(a.table_oid+':'+a.number) ||
        !['SELECT','INSERT','UPDATE','REFERENCES'].includes(a.privilege_type)))) fail('Malformed/unbound '+label);
  }
  unique(s.defaultAcl,d=>d.oid,'default ACL');
  for (const d of s.defaultAcl) {
    if (!oid(d.oid) || !master || d.owner_oid!==master.oid ||
        !['<global>','public'].includes(d.schema_name) || !Number.isInteger(d.schema_oid) ||
        (d.schema_name==='<global>' ? d.schema_oid!==0 : d.schema_oid<=0) ||
        typeof d.raw_acl!=='string' || !Array.isArray(d.entries)) { fail('Malformed default ACL'); continue; }
    unique(d.entries,a=>[a.grantee,a.grantor,a.privilege_type].join(':'),'default ACL entries');
    for (const a of d.entries) if (!(a.grantee===0 || roles.has(a.grantee)) || !roles.has(a.grantor) ||
        !PRIVILEGES.includes(a.privilege_type) || typeof a.is_grantable!=='boolean') fail('Malformed default ACL entry');
  }
  unique(s.appReach,r=>r.role_oid,'app reach');
  if (s.appReach.length!==roles.size) fail('App reach matrix incomplete');
  for (const r of s.appReach) if (!roles.has(r.role_oid) ||
      ['member','usage','can_set'].some(k=>typeof r[k]!=='boolean')) fail('Malformed app reach row');
  unique(s.roleTable,p=>p.role_oid+':'+p.table_oid,'role/table');
  if (s.roleTable.length!==roles.size*4) fail('All-role by four-table matrix incomplete');
  for (const p of s.roleTable) {
    if (!roles.has(p.role_oid) || !tables.has(p.table_oid) || typeof p.owner_usage!=='boolean' ||
        typeof p.any_column_update!=='boolean') fail('Malformed/unbound role/table row');
    for (const key of ['effective','grantable']) if (!object(p[key]) ||
        Object.keys(p[key]).length!==PRIVILEGES.length ||
        PRIVILEGES.some(priv=>typeof p[key][priv]!=='boolean')) fail('Incomplete privilege vector');
  }
  if (unknown.length) return finish();
  const closure=(start, option) => {
    if (roles.get(start).superuser) return new Set(roles.keys());
    const result=new Set([start]), queue=[start];
    for (let n=0;n<queue.length;n++) for (const m of s.memberships)
      if (m.member_oid===queue[n] && (!option || m[option]) && !result.has(m.role_oid)) {
        result.add(m.role_oid); queue.push(m.role_oid);
      }
    return result;
  };
  const visiting=new Set(), visited=new Set();
  const cycle=id=>{
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const m of s.memberships) if (m.member_oid===id && cycle(m.role_oid)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  if ([...roles.keys()].some(cycle)) fail('Impossible cyclic membership graph');
  const usage=closure(app.oid,'inherit_option'), contexts=closure(app.oid,'set_option'), member=closure(app.oid);
  for (const r of s.appReach) if (r.member!==member.has(r.role_oid) ||
      r.usage!==usage.has(r.role_oid) || r.can_set!==contexts.has(r.role_oid))
    fail('Native membership/USAGE/SET disagrees with per-membership graph');
  for (const p of s.roleTable) if (p.owner_usage!==closure(p.role_oid,'inherit_option').has(tables.get(p.table_oid).owner_oid))
    fail('Native owner reachability disagrees with graph');
  for (const p of s.roleTable) {
    const held=closure(p.role_oid,'inherit_option');
    for (const privilege of PRIVILEGES) {
      const grants=s.tableAcl.filter(a=>a.table_oid===p.table_oid && a.privilege_type===privilege &&
        (a.grantee_oid===0 || held.has(a.grantee_oid)));
      if (grants.length && !p.effective[privilege]) fail('Native privilege contradicts expanded table ACL');
      if ((p.owner_usage || grants.some(a=>a.is_grantable)) && !p.grantable[privilege])
        fail('Native grant option contradicts owner/expanded ACL');
    }
    if ((p.effective.UPDATE || s.columnAcl.some(a=>a.table_oid===p.table_oid && a.privilege_type==='UPDATE' &&
        (a.grantee_oid===0 || held.has(a.grantee_oid)))) && !p.any_column_update)
      fail('Native column UPDATE contradicts table/column ACL');
  }
  const effectiveRoles=new Set();
  for (const context of contexts) {
    const r=roles.get(context);
    if (r.superuser || r.bypass_rls || r.create_role)
      bad('Runtime/SET context has superuser, BYPASSRLS or CREATEROLE: '+r.name);
    for (const inherited of closure(context,'inherit_option')) effectiveRoles.add(inherited);
    for (const p of s.roleTable.filter(p=>p.role_oid===context)) {
      const t=tables.get(p.table_oid), history=!['engagement_plans','engagement_plan_waves'].includes(t.table_name);
      if (p.owner_usage) bad('Runtime/SET context holds owner regrant authority: '+r.name+' / '+t.table_name);
      for (const priv of ['DELETE','TRUNCATE',...(history?['UPDATE']:[])])
        if (p.effective[priv] || p.grantable[priv]) bad('Forbidden effective/grantable '+priv+': '+r.name+' / '+t.table_name);
      if (history && p.any_column_update) bad('History column UPDATE reachable: '+r.name+' / '+t.table_name);
    }
  }
  for (const id of effectiveRoles) if (['rds_superuser','rdsadmin'].includes(roles.get(id).name))
    bad('Provider privileged role reachable despite ordinary role flags: '+roles.get(id).name);
  // Conservative fail-closed: ADMIN can self-regrant with INHERIT/SET even if both are currently false.
  // Do not claim ADMIN inheritance is identical to ordinary object-privilege inheritance.
  for (const m of s.memberships) if (m.admin_option && effectiveRoles.has(m.member_oid))
    fail('Reachable role ADMIN OPTION requires separate authority review: '+roles.get(m.role_oid).name);
  for (const a of [...s.tableAcl,...s.columnAcl]) {
    const t=tables.get(a.table_oid), history=!['engagement_plans','engagement_plan_waves'].includes(t.table_name);
    if ((a.grantee_oid===0 || a.grantee_oid===app.oid) &&
        ['DELETE','TRUNCATE',...(history?['UPDATE']:[])].includes(a.privilege_type))
      bad('Forbidden '+(a.grantee_oid===0?'PUBLIC':'direct app')+' ACL: '+t.table_name+' / '+a.privilege_type);
  }
  for (const p of s.roleTable.filter(p=>p.role_oid===app.oid)) {
    const t=tables.get(p.table_oid), required=['SELECT','INSERT',...(['engagement_plans','engagement_plan_waves'].includes(t.table_name)?['UPDATE']:[])];
    for (const priv of required) if (!p.effective[priv]) bad('Required app table privilege absent: '+t.table_name+' / '+priv);
  }
  warnings.push('Point-in-time catalog observation; repeat after migrations, role changes or any blanket grants and immediately before an authorized activation.');
  warnings.push('Owner default ACL facts apply to future objects only; they neither prove nor repair current table ACLs.');
  warnings.push('No migration-deployment, general database/provider security, function/trigger/DDL, tenant-data visibility or application-authorization certification.');
  return finish();
}
function assess(s, expectedDatabase) {
  try { return assessFacts(s, expectedDatabase); }
  catch (error) { return {scope:'Four Engagement tables: role/ACL necessary precondition only',
    status:'UNKNOWN',qualified:false,unknown:['Malformed snapshot: '+error.message],unsafe:[],warnings:[]}; }
}
module.exports={assess,TABLES,PRIVILEGES};
