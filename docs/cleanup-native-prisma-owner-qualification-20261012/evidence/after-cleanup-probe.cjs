'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {TARGET,validateTarget}=require('../../cleanup-native-contract-prerequisites-20261012/native-contract-harness.cjs');
const {apiRequire}=require('../canonical-native-loader.cjs');
const input=JSON.parse(fs.readFileSync(path.join(__dirname,'../../cleanup-native-contract-prerequisites-20261012/evidence/ROOT-VERIFIED-TARGET.json'),'utf8'));
validateTarget(input);
const outfile=path.join(__dirname,'AFTER-CLEANUP-TARGET.json');
if(fs.existsSync(outfile))throw new Error('Never overwrite cleanup evidence');
async function main(){
 const {Client}=apiRequire('pg');
 const client=new Client({host:TARGET.socketDirectory,port:TARGET.port,user:TARGET.user,database:TARGET.database,password:'',ssl:false,connectionTimeoutMillis:3000,query_timeout:5000,application_name:'capiro-native-prisma-cleanup-probe'});
 await client.connect();
 try{
  const [actual]=(await client.query(`SELECT current_setting('data_directory') AS "dataDirectory",current_setting('listen_addresses') AS "listenAddresses",inet_server_addr() AS "inetServerAddr",current_user AS "user",current_database() AS "database",system_identifier::text AS "systemIdentifier",version() FROM pg_control_system()`)).rows;
  for(const key of ['dataDirectory','listenAddresses','inetServerAddr','user','database','systemIdentifier'])assert.equal(actual[key],TARGET[key]);
  const schemas=(await client.query('SELECT nspname FROM pg_namespace WHERE nspname=$1',['capiro_native_prisma_owners_pr2429_20261012'])).rows;
  const roles=(await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[['capiro_app','capiro_native_prisma_owner_20261012']])).rows;
  const [publicCount]=(await client.query(`SELECT count(*)::int AS "publicTables" FROM pg_tables WHERE schemaname='public'`)).rows;
  const sessions=(await client.query(`SELECT application_name FROM pg_stat_activity WHERE application_name LIKE 'capiro-native-prisma-%' AND pid<>pg_backend_pid()`)).rows;
  assert.equal(schemas.length,0);assert.equal(roles.length,0);assert.equal(publicCount.publicTables,0);assert.equal(sessions.length,0);
  const receipt={target:actual,ownedSchemaRemaining:schemas,ownedRolesRemaining:roles,publicTables:publicCount.publicTables,otherHarnessSessions:sessions,cleanupVerified:true,mutationQueries:0,persistentContainerAccessed:false};
  fs.writeFileSync(outfile,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
 }finally{await client.end();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
