// Broader independent inert vectors; only guard code is evaluated.
import fs from 'node:fs';
import { declarationDigest, inspectRegistryOwnership } from '../../../scripts/check-registry-ownership.mjs';
const owner = 'apps/example/src/registry.ts', consumer = 'apps/example/src/consumer.ts';
const ownerSource = 'export function canonicalRoute(input:string){return input;}';
const consumerSource = "import {canonicalRoute as route} from './registry.js'; export function dispatch(input:string){return route(input);}";
const results = [];
function check(name, mutate, expectRefuse=true) {
  const files = new Map([[owner,ownerSource],[consumer,consumerSource]]);
  const profile = { id:'example',owner,roots:['apps/example/src'],symbols:[{name:'canonicalRoute',kind:'function'}],edges:[{file:consumer,module:'./registry.js',imported:'canonicalRoute',uses:1}],carriers:[{file:consumer,name:'dispatch',kind:'function',sha256:declarationDigest(consumerSource,'dispatch','function')}] };
  mutate?.(files,profile);
  let output;try{output=inspectRegistryOwnership(files,{version:1,profiles:[profile]});}catch(e){output={errors:[e.message],threw:true};}
  const refused=output.errors.length>0;results.push({name,expectRefuse,refused,pass:refused===expectRefuse&&!output.threw,output});
}
for(const [name,text] of [
  ['nested object-array-rest binding','const { box: [{ ...canonicalRoute }] } = value;'],
  ['array rest binding','const [...canonicalRoute] = value;'],
  ['object rest binding','const {...canonicalRoute} = value;'],
  ['nested renamed binding','const { box: { alternate: canonicalRoute } } = value;'],
  ['rest parameter binding','function x(...canonicalRoute: unknown[]) {}'],
  ['named class expression','const Copy=class canonicalRoute {};'],
  ['quoted class method','class Copy { "canonicalRoute"(){} }'],
  ['static-computed class method','class Copy { ["canonicalRoute"](){} }'],
  ['class property field','class Copy { canonicalRoute=()=>1; }'],
  ['quoted class property field','class Copy { "canonicalRoute"=()=>1; }'],
  ['static-computed property field','class Copy { ["canonicalRoute"]=()=>1; }'],
  ['getter property','class Copy { get canonicalRoute(){return 1;} }'],
  ['setter property','class Copy { set canonicalRoute(x:unknown){} }'],
  ['extra owner namespace import',"import * as other from './registry.js';"],
  ['extra owner side-effect import',"import './registry.js';"],
  ['extra owner literal dynamic import',"const other=import('./registry.js');"],
  ['extra owner literal require',"const other=require('./registry.js');"],
  ['extra imported owned name from unknown relative path',"import {canonicalRoute as other} from './barrel.js'; other('x');"],
  ['extra extensionless owner import',"import {canonicalRoute as other} from './registry'; other('x');"],
  ['extra TypeScript import-equals require owner',"import other = require('./registry.js'); other.canonicalRoute('x');"],
])check(name,(files)=>files.set('apps/example/src/extra.cts',text));
check('renamed property key is not a binding duplicate',(files)=>files.set('apps/example/src/extra.ts','const {canonicalRoute: unrelated}=value;'),false);
check('listed alias runtime use plus extra type reference remains one use',(files,p)=>{const source=consumerSource+' type Alias=typeof route;';files.set(consumer,source);p.carriers[0].sha256=declarationDigest(source,'dispatch','function');},false);
check('type-only owned symbol cannot count as runtime edge',(files,p)=>{files.set(owner,'export interface canonicalRoute {}');p.symbols[0].kind='interface';});
check('syntax errors cannot create carrier fingerprints',(files,p)=>{p.carriers[0].sha256=declarationDigest('function dispatch(','dispatch','function');});
for (const [label,before,after] of [
 ['var/const declaration-list mutability','export const value=1;','export var value=1;'],
 ['export declare envelope','export const value=1;','export declare const value: number;'],
 ['multi-declaration envelope','export const value=1, extra=2;','export const value=1, extra=3;'],
]) { const equal=declarationDigest(before,'value','variable')===declarationDigest(after,'value','variable'); results.push({name:label,pass:!equal,equal}); }
const result={frozenHead:'721bfd4825bfccd819be50172ed712023891f978',checks:results.length,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results,applicationImports:0,sourceStringsEvaluated:false,nativeAcceptance:false};
fs.writeFileSync(new URL('additional-repaired-probes.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({checks:result.checks,passed:result.passed,failed:result.failed,reds:results.filter(x=>!x.pass).map(x=>x.name)}));if(result.failed)process.exitCode=1;
