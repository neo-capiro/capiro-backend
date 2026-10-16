'use strict';
// Pure lexical contract checks. These do not parse SQL or prove PostgreSQL execution.
function checkSqlSource(sql) {
  const outcomes=[];
  const test=(name,condition)=>{if(!condition)throw Error(name);outcomes.push({name,passed:true});};
  const commentsRemoved=sql.replace(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\//g,' ');
  const code=commentsRemoved.replace(/'(?:''|[^'])*'/g,"''");
  const statements=code.split(';').map(s=>s.trim()).filter(Boolean);
  test('exactly BEGIN, transaction-local trusted path, catalog SELECT, ROLLBACK',statements.length===4&&
    /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/i.test(statements[0])&&
    /^SET LOCAL search_path = pg_catalog, pg_temp$/i.test(statements[1])&&
    /^WITH\s/i.test(statements[2])&&/^ROLLBACK$/i.test(statements[3]));
  const queryCode=[statements[0],statements[2],statements[3]].join(';');
  test('no SQL mutation or impersonation beyond exact transaction-local path',
    !/\b(?:DO|CALL|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|GRANT|REVOKE|CREATE|ALTER|DROP|COPY|EXECUTE|SET|RESET)\b/i.test(queryCode));
  test('no filesystem, extension or connection escape functions',
    !/\b(?:set_config|dblink|lo_import|lo_export|pg_read_file|pg_write_file|pg_ls_dir|pg_sleep)\s*\(/i.test(code));
  test('single positional value binding',JSON.stringify(code.match(/\$\d+/g))===JSON.stringify(['$1']));
  const identities=[...commentsRemoved.matchAll(/\('(engagement_[a-z_]+)'\)/g)].map(m=>m[1]).sort();
  test('four exact relation identities',JSON.stringify(identities)===JSON.stringify(
    ['engagement_plans','engagement_plan_waves','engagement_plan_command_receipts','engagement_plan_revisions'].sort()));
  test('public schema exact match',commentsRemoved.includes("n.nspname='public'"));
  test('missing relation retained by LEFT JOIN',/LEFT JOIN pg_catalog\.pg_class c ON/.test(code));
  test('unfiltered complete pg_roles enumeration',/FROM pg_catalog\.pg_roles\s*\n\),/.test(code));
  test('complete membership catalog and PG16 per-edge options',
    /FROM pg_catalog\.pg_auth_members\s*\n\),/.test(code)&&code.includes('admin_option, inherit_option, set_option'));
  test('native MEMBER, USAGE and SET probes represented',
    ['MEMBER','USAGE','SET'].every(p=>commentsRemoved.includes("pg_catalog.pg_has_role(a.oid,r.oid,'"+p+"')")));
  test('all-role by table effective matrix',code.includes('FROM roles r CROSS JOIN tables t WHERE t.oid IS NOT NULL'));
  test('owner authority independent of ordinary ACL',commentsRemoved.includes("pg_catalog.pg_has_role(r.oid,t.owner_oid,'USAGE')"));
  test('column UPDATE privilege cannot be omitted',commentsRemoved.includes("pg_catalog.has_any_column_privilege(r.oid,t.oid,'UPDATE')"));
  test('grant options included',commentsRemoved.includes("p||' WITH GRANT OPTION'"));
  test('PUBLIC and direct ACL facts expanded',code.includes('pg_catalog.aclexplode(t.acl)')&&code.includes('grantee_oid'));
  test('NULL ACL uses current-owner built-in fallback',commentsRemoved.includes("COALESCE(c.relacl, pg_catalog.acldefault('r',c.relowner))"));
  test('owner global and schema future defaults both retained',commentsRemoved.includes("d.defaclnamespace=0 OR n.nspname='public'"));
  test('catalog cardinalities for every returned collection',
    ['roles','memberships','tables','appReach','tableAcl','columns','columnAcl','roleTable','defaultAcl']
      .every(k=>new RegExp("'"+k+"'\\s*,\\s*\\(SELECT pg_catalog\\.count\\(\\*\\) FROM").test(commentsRemoved)));
  test('version and transaction modes returned',commentsRemoved.includes("'server_version_num'")&&
    commentsRemoved.includes("'transaction_read_only'")&&commentsRemoved.includes("'transaction_isolation'"));
  test('search path is returned for assessor binding',commentsRemoved.includes("'searchPath', pg_catalog.current_setting('search_path')"));
  test('no password catalog/column requested',!/\b(?:pg_authid|rolpassword)\b/i.test(code));
  test('all called PostgreSQL functions are catalog-qualified',
    !/(?<![.\w])(?:jsonb_build_object|jsonb_agg|jsonb_object_agg|to_jsonb|has_table_privilege|has_any_column_privilege|pg_has_role|aclexplode|acldefault|unnest|current_setting|current_database|statement_timestamp|version|count)\s*\(/i.test(code));
  return outcomes;
}
module.exports={checkSqlSource};
