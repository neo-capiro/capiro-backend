import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,readdirSync } from 'node:fs';
import { declarationDigest,inspectRegistryOwnership } from '../../../scripts/check-registry-ownership.mjs';
import { inspectHelperInventory } from '../../../scripts/check-duplicate-helpers.mjs';

const owner='apps/example/src/registry.ts',consumer='apps/example/src/consumer.ts';
const ownerText='export function canonicalRoute(input:string){return input;}';
const consumerText="import {canonicalRoute as route} from './registry.js'; export function dispatch(value:string){return route(value);}";
function fixture(){return {files:new Map([[owner,ownerText],[consumer,consumerText]]),config:{version:1,profiles:[{id:'review',owner,roots:['apps/example/src'],symbols:[{name:'canonicalRoute',kind:'function'}],edges:[{file:consumer,module:'./registry.js',imported:'canonicalRoute',uses:1}],carriers:[{file:consumer,name:'dispatch',kind:'function',sha256:declarationDigest(consumerText,'dispatch','function')}]}]}};}
function aliasFixture(source){const f=fixture();const alias='apps/example/src/compatibility.ts';
 f.files.set(owner,'export const canonicalRoute=["one","two"];');f.files.set(alias,source);
 const next=consumerText.replace('./registry.js','./compatibility.js');f.files.set(consumer,next);
 const p=f.config.profiles[0];p.symbols[0].kind='variable';p.aliases=[{file:alias,name:'canonicalRoute',sha256:declarationDigest(source,'canonicalRoute','variable')}];
 p.edges[0].module='./compatibility.js';p.edges.push({file:alias,module:'./registry.js',imported:'canonicalRoute',uses:1});p.carriers[0].sha256=declarationDigest(next,'dispatch','function');return f;}
const results=[];
function record(label,f,expectedReject=true){const result=inspectRegistryOwnership(f.files,f.config);results.push({label,expectedReject,rejected:result.errors.length>0,errors:result.errors});}
record('baseline legitimate owner',fixture(),false);
for(const [label,source] of [
 ['literal computed method',"const extra={['canonicalRoute'](){return 1;}};"],
 ['constant binary computed method',"const extra={['canonical'+'Route'](){return 1;}};"],
 ['template computed method',"const extra={[`canonicalRoute`](){return 1;}};"],
 ['constant lexical computed method',"const KEY='canonicalRoute'; const extra={[KEY](){return 1;}};"],
 ['binary computed property implementation',"const extra={['canonical'+'Route']:()=>1};"],
 ['binary computed class property',"class Extra{['canonical'+'Route']=()=>1;}"],
 ['literal named getter',"const extra={get canonicalRoute(){return ()=>1}};"],
 ['ambient same-name declaration',"declare function canonicalRoute(input:string):string;"],
 ['prototype static assignment lead',"function Extra(){};Extra.prototype.canonicalRoute=function(input){return input;};"],
 ['constant dynamic owner import',"import('./reg'+'istry.js');"],
 ['template dynamic owner import',"import(`./registry.js`);"],
 ['literal dynamic owner import',"import('./registry.js');"],
 ['aliased require owner lead',"const load=require;load('./registry.js');"],
 ['owner require computed string',"require('./reg'+'istry.js');"],
 ['named transitive owner barrel',"export {canonicalRoute} from './registry.js';"],
 ['benign comment/type/string',"// canonicalRoute\nexport const harmless='canonicalRoute'; type Note={message:string};"],
]){const f=fixture();f.files.set('apps/example/src/extra.ts',source);record(label,f,label!=='benign comment/type/string');}
const direct="import {canonicalRoute as actual} from './registry.js'; export const canonicalRoute=actual;";
for(const [label,source,expected] of [
 ['direct const runtime alias',direct,false],
 ['export let alias with exact supplied digest',direct.replace('export const','export let'),true],
 ['export var alias with exact supplied digest',direct.replace('export const','export var'),true],
 ['runtime import plus shadowed alias',"import {canonicalRoute as actual} from './registry.js'; function scope(actual:unknown){return actual;} export const canonicalRoute=scope([]);",true],
 ['alias wrong imported member',direct.replace('{canonicalRoute as actual}','{other as actual}'),true],
 ['alias type-only member',direct.replace('{canonicalRoute as actual}','{type canonicalRoute as actual}'),true],
 ['alias namespace input',"import * as actual from './registry.js'; export const canonicalRoute=actual.canonicalRoute;",true],
 ['ambient alias',"export declare const canonicalRoute:unknown;",true],
])record(label,aliasFixture(source),expected);
const config=JSON.parse(readFileSync('scripts/registry-ownership.json','utf8'));
const real=new Map();
function walk(dir){for(const ent of readdirSync(dir,{withFileTypes:true})){const file=dir+'/'+ent.name;if(ent.isDirectory())walk(file);else if(ent.isFile()&&/\.(?:ts|tsx|mts|cts)$/.test(file)&&!/(?:\.(?:spec|test)\.[cm]?tsx?$|\.d\.[cm]?ts$)/.test(file))real.set(file,readFileSync(file,'utf8'));}}
for(const root of new Set(config.profiles.flatMap(p=>p.roots)))walk(root);
const realBase=inspectRegistryOwnership(real,config);assert.equal(realBase.errors.length,0);
const wholeMap=[];
for(const [label,source] of [
 ['literal canonical copied method',"const extra={asCount(value:unknown){return 1;}};"],
 ['binary computed canonical method',"const extra={['as'+'Count'](value:unknown){return 1;}};"],
 ['lexical constant canonical method',"const KEY='asCount';const extra={[KEY](value:unknown){return 1;}};"],
 ['constant dynamic canonical owner import',"import('./external/tango/tango-rest-'+'page.js');"],
]){const map=new Map(real);map.set('apps/api/src/review-static-extra.ts',source);const r=inspectRegistryOwnership(map,config);wholeMap.push({label,source,rejected:r.errors.length>0,errors:r.errors});}
const inventory=readFileSync('scripts/duplicate-helper-names.txt','utf8');
assert.equal(inspectHelperInventory(config,inventory).errors.length,0);
const omissions=inventory.split('\n').filter(line=>!line.endsWith('\tasCount')).join('\n');
assert(inspectHelperInventory(config,omissions).errors.length>0);
const receipt={source:'e3abe0ab9257d6734fc88e81b49e05717fa5c33b',tree:'9ea935dd0a2e72346564c4ba5143da64db93c95d',baselineSourceFiles:real.size,
 results,wholeMap,unexpectedAccepts:results.filter(r=>r.expectedReject&&!r.rejected),sourceMutantsExecuted:false,productionFilesChanged:false};
writeFileSync(new URL('adversarial-root-controls.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({baselineFiles:real.size,fixtureCases:results.length,unexpectedAccepted:receipt.unexpectedAccepts.map(r=>r.label),wholeMap},null,2));
