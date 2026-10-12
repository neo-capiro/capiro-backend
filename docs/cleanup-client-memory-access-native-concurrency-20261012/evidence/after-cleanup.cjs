'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { TARGET, SCHEMA, OWNER, APP, validateTarget, verifyBindings } = require('../native-wall-writer.cjs');
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== '--run' || args[1] !== '--output') throw new Error('Usage: --run --output <new own receipt>');
const output = path.resolve(args[2]);
if (path.dirname(output) !== __dirname || fs.existsSync(output) || fs.realpathSync(__dirname) !== __dirname) throw new Error('Fresh unsymlinked packet output required');
validateTarget(JSON.parse(fs.readFileSync(path.join(__dirname, 'ROOT-VERIFIED-TARGET.json'), 'utf8')));
verifyBindings();
const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...values) {
  const first = values[0];
  if ((typeof first === 'string' ? first : first?.path) !== path.join(TARGET.socketDirectory, `.s.PGSQL.${TARGET.port}`)) throw new Error('Cleanup probe refused other socket/network target');
  return original.apply(this, values);
};
for (const [name, methods] of [['node:http', ['request','get']], ['node:https', ['request','get']], ['node:dns', ['lookup','resolve','resolve4','resolve6']], ['node:child_process', ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork']]]) {
  for (const method of methods) require(name)[method] = () => { throw new Error(`Cleanup probe refused ${name}.${method}`); };
}
global.fetch = () => { throw new Error('Cleanup probe refused fetch'); };
const apiRequire = createRequire(path.resolve(__dirname, '../../../apps/api/package.json'));
const { Client } = apiRequire('pg');
async function main() {
  const c = new Client({host:TARGET.socketDirectory,port:TARGET.port,user:TARGET.user,database:TARGET.database,password:'',ssl:false,connectionTimeoutMillis:3000,query_timeout:5000,application_name:'capiro-wall-writer-cleanup-probe'});
  await c.connect();
  try {
    const [target] = (await c.query(`SELECT current_setting('data_directory') AS "dataDirectory",current_setting('listen_addresses') AS "listenAddresses",inet_server_addr() AS "inetServerAddr",current_user AS "user",current_database() AS "database",system_identifier::text AS "systemIdentifier",version() FROM pg_control_system()`)).rows;
    for (const key of ['dataDirectory','listenAddresses','inetServerAddr','user','database','systemIdentifier']) assert.equal(target[key],TARGET[key]);
    assert(target.version.startsWith('PostgreSQL 16.15 '));
    const schemas = (await c.query('SELECT nspname FROM pg_namespace WHERE nspname=$1',[SCHEMA])).rows;
    const roles = (await c.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[[APP,OWNER]])).rows;
    const sessions = (await c.query("SELECT pid,application_name FROM pg_stat_activity WHERE application_name LIKE 'capiro-wall-writer-%' AND pid<>pg_backend_pid()")).rows;
    const [publicCount] = (await c.query("SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname='public'")).rows;
    assert.deepEqual(schemas,[]);assert.deepEqual(roles,[]);assert.deepEqual(sessions,[]);assert.equal(publicCount.tables,0);
    const result={target,ownedSchemas:schemas,ownedRoles:roles,otherOwnedRunnerSessions:sessions,publicTables:publicCount.tables,cleanupVerified:true,readOnlySqlStatements:5,mutationQueries:0,nativePrisma:false};
    fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result,null,2));
  } finally {await c.end();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
