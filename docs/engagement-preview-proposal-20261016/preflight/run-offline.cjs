'use strict';
// OFFLINE ONLY: imports local pure tests and reads/hashes source files. No DB driver.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=__dirname, sources=['role-acl-snapshot.sql','assess-role-acl.cjs','assess-role-acl.test.cjs','sql-source.test.cjs','run-offline.cjs'];
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex');
let body;
const savedLog=console.log;
try {
  console.log=value=>{body=JSON.parse(value);};
  require('./assess-role-acl.test.cjs');
} finally {console.log=savedLog;}
const staticChecks=require('./sql-source.test.cjs').checkSqlSource(fs.readFileSync(path.join(root,'role-acl-snapshot.sql'),'utf8'));
const report={
  mode:'offline Node synthetic assessor and static SQL source checks only',
  executedAt:new Date().toISOString(),node:process.version,
  databaseQueriesExecuted:0,networkCalls:0,
  assessor:{tests:body.tests,passed:body.passed,failed:body.failed,outcomes:body.outcomes},
  sqlSource:{tests:staticChecks.length,passed:staticChecks.length,failed:0,outcomes:staticChecks},
  inputs:sources.map(name=>({name,sha256:sha(name),bytes:fs.statSync(path.join(root,name)).size})),
  limits:['No SQL parsing or PostgreSQL execution claimed.','No target connection, deployed posture, rollout or security approval.']
};
fs.writeFileSync(path.join(root,'offline-node-results.json'),JSON.stringify(report,null,2)+'\n');
savedLog(JSON.stringify({assessor:report.assessor.tests,sqlSource:report.sqlSource.tests,
  passed:report.assessor.passed+report.sqlSource.passed,failed:0,
  databaseQueriesExecuted:0,report:'offline-node-results.json',reportSha256:sha('offline-node-results.json')}));
