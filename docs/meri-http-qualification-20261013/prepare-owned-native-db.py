from pathlib import Path
import json,hashlib,re,subprocess
ROOT=Path(__file__).resolve().parents[2]
p=Path(__file__).parent
target=json.loads((p/'OWNED-TARGET-PLAN.json').read_text());db=target['database'];assert re.fullmatch(r'capiro_auth_http_20261013_[0-9a-f]{10}',db)
container='capiro-postgres';system_id='7695590366852821031'
def pg(sql,database='postgres'):
 r=subprocess.run(['docker','exec','-i',container,'psql','-U','capiro','-d',database,'-X','-A','-t','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout.strip()
assert pg('SELECT system_identifier::text FROM pg_control_system();')==system_id
assert pg(f"SELECT count(*) FROM pg_database WHERE datname='{db}';")=='0','owned database must not preexist'
full=(p/'evidence/01-current-schema-native-diff.sql').read_text()
tables={'tenants','users','tenant_memberships','impersonation_sessions','clients','client_memory_access','clio_conversations','audit_logs'}
blocks=re.split(r'(?m)(?=^-- \w)',full);kept=[];created=[]
for block in blocks:
 if block.startswith(('-- CreateExtension','-- CreateEnum')):kept.append(block)
 elif block.startswith('-- CreateTable'):
  name=re.search(r'CREATE TABLE "([^"\n]+)"',block).group(1)
  if name in tables:kept.append(block);created.append(name)
 elif block.startswith('-- CreateIndex'):
  match=re.search(r' ON "([^"\n]+)"',block)
  if match and match.group(1) in tables:kept.append(block)
 elif block.startswith('-- AddForeignKey'):
  match=re.search(r'ALTER TABLE "([^"\n]+)".*REFERENCES "([^"\n]+)"',block,re.S)
  if match and set(match.groups())<=tables:kept.append(block)
assert set(created)==tables and len(created)==8
fixture_sql=''.join(kept)
bindings=[];policies=[]
paths=['20260501000000_init_identity_tenancy','20260502000000_user_admin_brand_clients','20260510010000_clio_nanoclaw_workspace','20260719220000_client_memory_walls']
for migration in paths:
 path=f'apps/api/prisma/migrations/{migration}/migration.sql';raw=subprocess.check_output(['git','show',target['head']+':'+path],cwd=ROOT).decode()
 bindings.append({'path':path,'head':target['head'],'sha256':hashlib.sha256(raw.encode()).hexdigest()})
 if migration==paths[0]:
  for name in ['current_tenant_id','rls_bypass']:
   m=re.search(r'CREATE OR REPLACE FUNCTION '+name+r'\(\).*?\$\$ LANGUAGE plpgsql STABLE;',raw,re.S);assert m,name;policies.append(m.group())
 for statement in re.findall(r'ALTER TABLE "[^"\n]+" (?:ENABLE|FORCE) ROW LEVEL SECURITY;',raw):
  if re.search(r'ALTER TABLE "([^"\n]+)"',statement).group(1) in tables:policies.append(statement)
 for m in re.finditer(r'CREATE POLICY "[^"\n]+" ON "([^"\n]+)"\s+.*?;',raw,re.S):
  if m.group(1) in tables:policies.append(m.group())
assert len([s for s in policies if s.startswith('CREATE POLICY')])==6
fixture_sql+='\n\n-- Exact existing selected RLS statements; full migrations are not replayed.\n'+'\n\n'.join(policies)+'\n'
(p/'evidence/02-selected-current-schema-and-rls.sql').write_text(fixture_sql)
role=db+'_rls';assert len(role)<63
assert pg(f"SELECT count(*) FROM pg_roles WHERE rolname='{role}';")=='0','fixture NOLOGIN role must not preexist'
pg(f'CREATE DATABASE "{db}";')
pg(f"COMMENT ON DATABASE \"{db}\" IS 'owned /root authority HTTP fixture at {target['head']}';")
oid=pg(f"SELECT oid FROM pg_database WHERE datname='{db}';")
# Record ownership before any application schema/role operation so every failure is recoverable.
receipt={**target,'databaseOid':oid,'createdDatabase':True,'role':role,'roleCreated':False,'schemaApplied':False,'fullMigrationHistoryReplayed':False,'selectedExistingPolicyStatements':len(policies),'sourceBindings':bindings,'generatedFullDiffSha256':hashlib.sha256(full.encode()).hexdigest(),'selectedFixtureSqlSha256':hashlib.sha256(fixture_sql.encode()).hexdigest(),'runtimeOwnerRoleBypassesRls':True,'directControlledRlsScopeSeparate':True}
(p/'OWNED-DB-RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n')
pg(fixture_sql,db);receipt['schemaApplied']=True;(p/'OWNED-DB-RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n')
pg(f'CREATE ROLE "{role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE;')
receipt['roleCreated']=True;(p/'OWNED-DB-RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n')
pg(f'GRANT USAGE ON SCHEMA public TO "{role}"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "{role}";',db)
metadata=pg("SELECT json_build_object('database',current_database(),'user',current_user,'server',current_setting('server_version'),'tables',(SELECT json_agg(t) FROM (SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname) t));",db)
(p/'evidence/02-applied-owned-db-metadata.json').write_text(json.dumps(json.loads(metadata),indent=2)+'\n')
print(json.dumps({'ownedDatabase':db,'oid':oid,'tables':len(created),'rlsPolicies':6,'role':role,'credentialsCreated':False,'containerCreatedOrChanged':False}))
