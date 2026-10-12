import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { declarationDigest,inspectRegistryOwnership } from '../../../scripts/check-registry-ownership.mjs';
const results=[];
for(const file of ['scripts/check-registry-ownership.mjs','scripts/check-duplicate-helpers.mjs'])
 for(const argv of [['--help'],['-h'],['--unknown'],['--help','--unknown']]) {
  const run=spawnSync(process.execPath,[file,...argv],{encoding:'utf8'});
  assert.equal(run.error,undefined);
  assert.equal(run.status,argv.length===1&&argv[0]!=='--unknown'?0:1);
  results.push({file,argv,status:run.status,stdout:run.stdout,stderr:run.stderr});
 }
const deep=`export const Owner={ [${'('.repeat(140)}'other'${')'.repeat(140)}](){}};`;
assert.equal(declarationDigest(deep,'Owner','variable'),null);
assert.equal(declarationDigest('export function invalid(','invalid','function'),null);
const owner='apps/example/src/registry.ts',consumer='apps/example/src/consumer.ts';
const before='export function canonicalRoute(input:string){return input;}',use="import {canonicalRoute as route} from './registry.js';export function dispatch(x:string){return route(x);}";
const config={version:1,profiles:[{id:'review',owner,roots:['apps/example/src'],symbols:[{name:'canonicalRoute',kind:'function'}],edges:[{file:consumer,module:'./registry.js',imported:'canonicalRoute',uses:1}],carriers:[{file:consumer,name:'dispatch',kind:'function',sha256:declarationDigest(use,'dispatch','function')}]}]};
for(const [label,source] of [
 ['erased wrappers along every callee chain',"const first=(require as typeof require)!;const second=<typeof require>first;const last=((second))!;last('./registry.js');"],
 ['deep callee budget',`(${'('.repeat(140)}require${')'.repeat(140)})('./registry.js');`],
 ['malformed source is refusal','const invalid = {'],
]){
 const files=new Map([[owner,before],[consumer,use],['apps/example/src/extra.ts',source]]);
 const result=inspectRegistryOwnership(files,config);
 assert(result.errors.length>0,label);results.push({label,rejected:true,errors:result.errors});
}
const receipt={source:'8f48604aa1cefdb3e420026633ce8e1f2ca95953',cliCases:8,additionalRefusalCases:3,digestBudgetAndSyntaxReturnsNull:true,results,
  subprocessScope:'Only cached Node executing the two source guards with help/invalid flags; no app source, PM, provider, database or module graph executes.',mutantsExecuted:false};
writeFileSync(new URL('cli-and-digest-8f48.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({cliCases:8,additionalRefusalCases:3,digestBudgetAndSyntaxReturnsNull:true,mutantsExecuted:false}));
