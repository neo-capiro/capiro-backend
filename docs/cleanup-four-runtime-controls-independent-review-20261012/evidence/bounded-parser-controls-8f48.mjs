import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { declarationDigest,inspectRegistryOwnership } from '../../../scripts/check-registry-ownership.mjs';
const owner='apps/example/src/registry.ts',consumer='apps/example/src/consumer.ts';
const before='export function canonicalRoute(input:string){return input;}';
const use="import {canonicalRoute as route} from './registry.js';export function dispatch(value:string){return route(value);}";
function fixture(source){return {files:new Map([[owner,before],[consumer,use],['apps/example/src/extra.ts',source]]),config:{version:1,profiles:[{id:'review',owner,roots:['apps/example/src'],symbols:[{name:'canonicalRoute',kind:'function'}],edges:[{file:consumer,module:'./registry.js',imported:'canonicalRoute',uses:1}],carriers:[{file:consumer,name:'dispatch',kind:'function',sha256:declarationDigest(use,'dispatch','function')}]}]}};}
const cases=[
 ['shadowed harmless const key',"const key='canonicalRoute';function harmless(){const key='other';return {[key](){}}}",false],
 ['shadowed owned const key',"const key='other';function copy(){const key='canonicalRoute';return {[key](){}}}",true],
 ['parameter shadows outer const',"const key='canonicalRoute';function harmless(key:string){return {[key](){}}}",false],
 ['block const chain owned key',"{const suffix='Route';const key='canonical'+suffix;const copy={[key](){}}}",true],
 ['constant key cycle terminates',"const first=second;const second=first;const copy={[first](){}}",false],
 ['require alias cycle terminates',"const first=second;const second=first;first('./registry.js');",false],
 ['string-only template owned key',"const prefix='canonical';const suffix='Route';const copy={[`${prefix}${suffix}`](){}}",true],
 ['numeric template not coerced',"const suffix=1;const copy={[`other${suffix}`](){}}",false],
 ['property getter expression not evaluated',"const value={get key(){throw new Error('MUST NOT EXECUTE')}};const copy={[value.key](){}}",false],
 ['call expression not evaluated',"const key=(()=>{throw new Error('MUST NOT EXECUTE')})();const copy={[key](){}}",false],
 ['assertion string owned key',"const key=('canonical'+'Route') as string;const copy={[key](){}}",true],
 ['type assertion string owned key',"const key=<string>('canonical'+'Route');const copy={[key](){}}",true],
 ['non-null string owned key',"const key=('canonical'+'Route')!;const copy={[key](){}}",true],
 ['string assertion module',"import(('./registry.js') as string);",true],
 ['string type assertion module',"require(<string>'./registry.js');",true],
 ['require alias parenthesis',"const load=((require));load('./registry.js');",true],
 ['require alias as expression',"const load=require as typeof require;load('./registry.js');",true],
 ['require alias type assertion',"const load=<typeof require>require;load('./registry.js');",true],
 ['require alias non-null expression',"const load=require!;load('./registry.js');",true],
 ['deep static key parenthesis',`const copy={[${'('.repeat(140)}'canonicalRoute'${')'.repeat(140)}](){}};`,true],
 ['deep static module parenthesis',`import(${'('.repeat(140)}'./registry.js'${')'.repeat(140)});`,true],
 ['shadowed local require is conservatively rejected',"function harmless(require:(value:string)=>unknown){require('./registry.js');}",true],
];
const results=cases.map(([label,source,expectedReject])=>{const f=fixture(source);let result;try{result=inspectRegistryOwnership(f.files,f.config);}catch(error){throw new Error(label+': inspector threw '+error.message);}
 return {label,source,expectedReject,rejected:result.errors.length>0,errors:result.errors};});
const receipt={source:'8f48604aa1cefdb3e420026633ce8e1f2ca95953',results,unexpectedAccepts:results.filter(r=>r.expectedReject&&!r.rejected),unexpectedRejects:results.filter(r=>!r.expectedReject&&r.rejected),sourceMutantsExecuted:false};
assert.equal(receipt.unexpectedRejects.length,0);
writeFileSync(new URL('bounded-parser-controls-8f48.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({cases:results.length,unexpectedAccepts:receipt.unexpectedAccepts.map(r=>r.label),unexpectedRejects:receipt.unexpectedRejects.length,sourceMutantsExecuted:false},null,2));
