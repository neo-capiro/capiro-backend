import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const head='5db091dac54bc05f4a97a1495c8e6df238547c4d', tree='725acfb0db38db8b62e79b9f3fba7823d5b88bff';
const base='f1e83a3f194a8ebd972e370ff6e5b5f559888b29';
const require=createRequire('/workspace/capirov2/apps/api/package.json'),ts=require('typescript');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024}).trim();
const blob=(pin,file)=>execFileSync('git',['show',`${pin}:${file}`],{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024});
const hash=s=>createHash('sha256').update(s).digest('hex');
assert.equal(git('rev-parse',`${head}^{tree}`),tree);
const manifest=JSON.parse(readFileSync(resolve(root,'docs/cleanup-executable-prereqs-20261012/evidence/cli-caller-independent/selected-source-manifest.json'),'utf8'));
function canonSql(text) {
  const tokens=text.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\$[A-Za-z_]*\$[\s\S]*?\$[A-Za-z_]*\$|\s+|[^\s'"$]+|\$[^\s]+/g)??[];
  return tokens.map(t=>/^\s+$/.test(t)?' ':t).join('').trim();
}
function inventory(source,file) {
  const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),sql=[],functions=new Map();
  const printer=ts.createPrinter({removeComments:true});
  function visit(n) {
    if(ts.isStringLiteralLike(n)&&/^\s*(SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|WITH|SET|DROP|GRANT|REVOKE)\b/i.test(n.text))sql.push(canonSql(n.text));
    if(ts.isTemplateExpression(n)&&/^\s*(SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|WITH|SET|DROP|GRANT|REVOKE)\b/i.test(n.head.text))
      sql.push(canonSql(n.head.text+n.templateSpans.map(s=>`\${${printer.printNode(ts.EmitHint.Expression,s.expression,sf)}}${s.literal.text}`).join('')));
    if(ts.isFunctionDeclaration(n)&&n.name&&n.body)functions.set(n.name.text,printer.printNode(ts.EmitHint.Unspecified,n.body,sf));
    ts.forEachChild(n,visit);
  }visit(sf);return{sql,functions};
}
const rows=[],sqlIssues=[];
for(const entry of manifest.rows) {
  const file=entry.path,before=blob(base,file),after=readFileSync(resolve(root,file),'utf8');
  assert.equal(after,blob(head,file),`Source not frozen: ${file}`);
  const old=inventory(before,file),current=inventory(after,file),available=[...current.sql];
  const lost=[];for(const sql of old.sql){const index=available.indexOf(sql);if(index<0)lost.push(hash(sql));else available.splice(index,1);}
  if(lost.length)sqlIssues.push({file,lost});
  rows.push({file,beforeSha256:hash(before),afterSha256:hash(after),sqlBefore:old.sql.length,sqlAfter:current.sql.length,lostSqlHashes:lost});
}
const scope='scripts/verify-engagement-phase3-scope.mjs';
assert.equal(inventory(blob(base,scope),scope).functions.get('scopeIssues'),inventory(blob(head,scope),scope).functions.get('scopeIssues'));
const meri='scripts/meri-release.mjs';
for(const [name,body]of inventory(blob(base,meri),meri).functions){
  if(name!=='cli')assert.equal(inventory(blob(head,meri),meri).functions.get(name),body,`Meri owner function changed: ${name}`);
}
const dispatcher=readFileSync(resolve(root,'apps/api/scripts/entrypoint-dispatcher.inc'),'utf8');
const required=[['bootstrap-roles.ts','--run'],['prepopulate-all.ts','--run'],['import-stanford-dow-directory.ts','--import'],['import-dow-directory-v6.ts','--import'],['verify-defense-budget-packages.ts','--verify']];
for(const[file,flag]of required)assert.ok(dispatcher.includes(`scripts/${file} ${flag}`),`${file} caller missing ${flag}`);
assert.ok(dispatcher.includes('scripts/diag-ingestion-health.ts\n'),'configured diagnostic bare caller changed');
const local=[];
for(const phase of [4,5]){const file=`scripts/run-outreach-v3-phase${phase}-local.mjs`,text=readFileSync(resolve(root,file),'utf8');
  assert.ok(text.includes(`['scripts/verify-outreach-v3-phase${phase}-code.mjs', '--run']`));local.push(file);}
const originalPhase6=blob(base,'apps/api/scripts/verify-pe-budget-phase6-closeout.sh');
assert.equal(readFileSync(resolve(root,'apps/api/scripts/verify-pe-budget-phase6-closeout.sh'),'utf8'),originalPhase6);
const aliases=[];
for(const file of ['package.json','apps/api/package.json','apps/api-strategy/package.json','apps/web/package.json']) {
 const old=JSON.parse(blob(base,file)),current=JSON.parse(readFileSync(resolve(root,file),'utf8'));
 for(const[name,value]of Object.entries(current.scripts??{})){
  const previous=old.scripts?.[name];if(!previous||previous===value)continue;
  const added=value.match(/--(?:run|verify|measure|import|parse|offline)\b/g)??[];
  if(!added.length)continue;
  const stripped=value.replace(/\s--(?:run|verify|measure|import|parse|offline)\b/g,'');
  aliases.push({file,name,previous,value,added,originalCommandTokensPreserved:stripped===previous});
 }
}
console.log(JSON.stringify({head,tree,base,selectedPaths:rows.length,sourceHashesPinned:true,sqlIssues,
  strictPhase3ScopeIssuesFunctionUnchanged:true,canonicalMeriNonCliFunctionsUnchanged:true,
  callerChecks:{dispatcherRequired:required,localChildFlags:local,originalPhase6CloseoutRetained:true,configuredDiagnosticBareModePreserved:true},
  aliasFlagChanges:aliases,rows,sourceOnly:true,actualDbProviderBootstrapCloudOrBrowserExecution:false},null,2));
assert.deepEqual(sqlIssues,[],'SQL literal/body preservation needs review');
