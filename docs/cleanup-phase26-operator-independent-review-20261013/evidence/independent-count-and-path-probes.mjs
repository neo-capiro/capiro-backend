import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  parseContextPlaneInvocation,projectContextPlaneDiff,partitionContextPlaneDiff,assertContextPlaneReadPath,
  contextPlaneIncludesPath,contextPlaneSourceFilesUnder,
} from '../../../scripts/lib/context-plane-scope.mjs';
const require=createRequire(import.meta.url);
const ts=require('/workspace/capirov2/node_modules/typescript');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const baseline='c8c109f7d796d5a50ae57ff6cb214d576c757847';
const before=file=>execFileSync('git',['show',`${baseline}:${file}`],{cwd:root,encoding:'utf8'});
const current=fs.readFileSync(path.join(root,'scripts/check-context-plane-new-bypasses.mjs'),'utf8');
const old=before('scripts/check-context-plane-new-bypasses.mjs');
const sourcePaths=[...new Set([...old.matchAll(/['"]((?:apps|packages)\/[^'"]+\.(?:ts|tsx))['"]/g)].map(m=>m[1]))];
assert(!sourcePaths.some(p=>p.endsWith('/engagement.service.ts')));
const seed=Object.fromEntries(sourcePaths.map(p=>[p,before(p)]));
seed['apps/web/src/safe.ts']='export const safe=1;';seed['apps/onboard-web/src/safe.tsx']='export const safe=2;';
// Reuse only immutable fake-I/O collaborators; execute the actual caller text.
const spec=fs.readFileSync(path.join(root,'scripts/ci/context-plane-scope.contract.spec.mjs'),'utf8');
const ast=ts.createSourceFile('host.mjs',spec,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const declarations=[];for(const n of ast.statements)if(ts.isFunctionDeclaration(n)&&['filesystem','run'].includes(n.name?.text))declarations.push(n.getText(ast));
assert.equal(declarations.length,2);
const names=['vm','join','before','seed','parseContextPlaneInvocation','projectContextPlaneDiff','partitionContextPlaneDiff','assertContextPlaneReadPath','contextPlaneIncludesPath','contextPlaneSourceFilesUnder'];
const {run}=new Function(...names,declarations.join('\n')+'\nreturn {run};')(
  vm,path.join,before,seed,parseContextPlaneInvocation,projectContextPlaneDiff,partitionContextPlaneDiff,assertContextPlaneReadPath,contextPlaneIncludesPath,contextPlaneSourceFilesUnder);
const diff=(file,oldCount,newCount,lines)=>`diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -0,${oldCount} +1,${newCount} @@\n${lines.join('\n')}\n`;
const results=[];
for(const scope of ['backend','frontend']){
 const file=scope==='backend'?'apps/api/src/future/safe.ts':'apps/web/src/future/safe.ts';
 for(const [name,o,n,lines]of[
  ['increment addition',0,1,['+++ count;']],['decrement removal',1,0,['--- count;']],
  ['header-looking addition content',0,1,['+++ b/apps/api/src/context/decoy.ts']],
  ['header-looking removal content',1,0,['--- a/apps/api/src/context/decoy.ts']],
 ]){
  const input=diff(file,o,n,lines);assert.equal(projectContextPlaneDiff(input,scope),input);
  assert.equal(projectContextPlaneDiff(input,scope==='backend'?'frontend':'backend'),'');
  const parts=partitionContextPlaneDiff(input);assert.equal(parts[0].path,file);
  assert.deepEqual(parts[0].additions,lines.filter(l=>l.startsWith('+')).map(l=>l.slice(1)));
  results.push({name:`${scope}: ${name}`,status:'PASS',path:file});
 }
 for(const [name,input]of[
  ['truncated hunk',diff(file,0,2,['+++ count;'])],
  ['overfull hunk',diff(file,0,1,['+++ count;','+extra'])],
  ['extra fake header after satisfied hunk',diff(file,0,1,['+safe','+++ b/apps/api/src/context/decoy.ts'])],
 ]){assert.throws(()=>projectContextPlaneDiff(input,scope));results.push({name:`${scope}: refuses ${name}`,status:'PASS'});}
 const next=diff(file,0,1,['+safe'])+'@@ -1,0 +2,1 @@\n+++ count;\n\\ No newline at end of file\n';
 assert.deepEqual(partitionContextPlaneDiff(next)[0].additions,['safe','++ count;']);results.push({name:`${scope}: next hunk and canonical no-newline marker`,status:'PASS'});
 // Valid multiline literal followed by a prohibited shared resolver reference.
 const content=['const decoy = `','++ b/apps/api/src/context/decoy.ts','`;','resolveContextPacketMode;'];
 const spoof=diff(file,0,4,content.map(l=>'+'+l));
 const fixture={...seed,[file]:content.join('\n')};
 const guarded=run(current,[baseline,`--${scope}-only`],fixture,{diff:spoof});
 assert.equal(guarded.exit,1);assert(guarded.messages.error.some(s=>s.includes(file)&&s.includes('resolveContextPacketMode')));
 assert(guarded.messages.error.includes(`CONTEXT_PLANE_${scope.toUpperCase()}_FAILED`));
 assert(!guarded.messages.log.some(s=>s.endsWith('_COMPLETE')));
 results.push({name:`${scope}: real caller binds banned addition to product section`,status:'PASS',path:file,exitCode:guarded.exit});
 const full=run(old,[baseline],fixture,{diff:spoof});assert.equal(full.exit,0);
 results.push({name:`${scope}: unchanged FULL raw-header attribution weakness characterized`,status:'PASS',legacyExitCode:full.exit,legacyLimit:true});
}
const receipt={source:'31cc12a6626be8586666dfa9ccf53b68fff10311',sourceTree:'025aaef8f30fc4a9d3db39320f900325c40efe52',results,passed:results.length,failed:0,fakeIoCollaboratorsFromCurrentSpec:true,actualCallerEvaluatedInVm:true,applicationOwnersImported:false,sourceSeedPaths:sourcePaths.length,protectedReportingSeed:false,nativeDefaultCliExecuted:false,sqlExecuted:false};
fs.writeFileSync(new URL('./independent-count-and-path-probes.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({passed:results.length,failed:0,actualScopedPathRefusals:2,legacyFullWeaknessCarried:2}));
