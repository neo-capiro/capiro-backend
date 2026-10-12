// Syntactic ambient-export checks on inert source strings; no emit/evaluation.
import fs from 'node:fs';
import { declarationDigest, inspectRegistryOwnership } from '../../../scripts/check-registry-ownership.mjs';
const owner='apps/example/src/registry.ts',consumer='apps/example/src/consumer.ts';
const source="import {canonicalRoute as route} from './registry.js'; export function dispatch(input:string){return route(input);}";
const vectors=[
 ['ambient function is not a runtime owner','function','export declare function canonicalRoute(input:string):string;'],
 ['ambient variable is not a runtime owner','variable','export declare const canonicalRoute: (input:string)=>string;'],
 ['ambient class is not a runtime owner','class','export declare class canonicalRoute {}'],
 ['ambient enum is not a runtime owner','enum','export declare enum canonicalRoute { One }'],
];
const results=vectors.map(([name,kind,ownerSource])=>{const files=new Map([[owner,ownerSource],[consumer,source]]);const config={version:1,profiles:[{id:'example',owner,roots:['apps/example/src'],symbols:[{name:'canonicalRoute',kind}],edges:[{file:consumer,module:'./registry.js',imported:'canonicalRoute',uses:1}],carriers:[{file:consumer,name:'dispatch',kind:'function',sha256:declarationDigest(source,'dispatch','function')}]}]};const output=inspectRegistryOwnership(files,config);return{name,pass:output.errors.length>0,output};});
const result={frozenHead:'721bfd4825bfccd819be50172ed712023891f978',checks:results.length,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results,sourceStringsEvaluated:false,applicationImports:0,nativeAcceptance:false};fs.writeFileSync(new URL('ambient-export-probes.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;
