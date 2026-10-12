// Only guard functions inspect inert source text Maps; no transpile/evaluation/import of application source.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {inspectRegistryOwnership,declarationDigest} from '../../../scripts/check-registry-ownership.mjs';
import {inspectHelperInventory} from '../../../scripts/check-duplicate-helpers.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const all=JSON.parse(readFileSync(path.join(root,'scripts/registry-ownership.json'),'utf8'));
const profiles=all.profiles.filter(p=>p.id.startsWith('workspace-'));
const config={version:1,profiles}; assert.equal(profiles.length,2);
const sources=new Map();
function walk(relative){for(const e of readdirSync(path.join(root,relative),{withFileTypes:true})){const p=relative+'/'+e.name;assert(!lstatSync(path.join(root,p)).isSymbolicLink(),'unexpected source symlink');if(e.isDirectory())walk(p);else if(/\.[cm]?tsx?$/.test(p)&&!/(?:\.(?:spec|test)\.[cm]?tsx?$|\.d\.[cm]?ts$)/.test(p))sources.set(p,readFileSync(path.join(root,p),'utf8'));}}
walk('apps/workspace/src');
const owner='apps/workspace/src/cascade/workspace-product.registry.ts',facade='apps/workspace/src/cascade/cascade.config.ts',consumer='apps/workspace/src/cascade/cascade.service.ts';
const extra='apps/workspace/src/cascade/independent-inert-copy.ts';
const results=[];
function inspect(change){const files=new Map(sources),data=structuredClone(config);change?.(files,data);return inspectRegistryOwnership(files,data);}
function control(label,expected,change){const result=inspect(change);assert.equal(result.errors.length===0,expected,label+': '+JSON.stringify(result.errors));results.push({label,expected:expected?'PASS':'REFUSE',result:'PASS',errors:result.errors});}
control('actual complete Workspace sourceMap baseline',true);
for(const profile of profiles)for(const carrier of profile.carriers){assert.equal(declarationDigest(sources.get(carrier.file),carrier.name,carrier.kind,carrier.file),carrier.sha256);results.push({label:'exact full carrier '+carrier.name,expected:'PASS',result:'PASS'});}
for(const name of ['WORKSPACE_PRODUCT_REGISTRY','WORKSPACE_PRODUCT_METADATA','WORKSPACE_PRODUCT_SECTIONS','WORKSPACE_PRODUCT_PAGES','WORKSPACE_PRODUCT_CANONICAL','WORKSPACE_PRODUCT_UNIVERSAL','WORKSPACE_PRODUCT_FUNDING']){
 control('descriptor export visibility '+name,false,f=>f.set(owner,f.get(owner).replace('export const '+name,'const '+name)));
 control('descriptor const/let envelope '+name,false,f=>f.set(owner,f.get(owner).replace('export const '+name,'export let '+name)));
}
for(const name of ['UNIVERSAL_PRODUCTS','CANONICAL_PRODUCTS','FUNDING_PRODUCTS','PRODUCT_META','SUGGESTED_SECTIONS','SUGGESTED_PAGES']){
 control('facade export visibility '+name,false,f=>f.set(facade,f.get(facade).replace('export const '+name,'const '+name)));
 control('facade const/let envelope '+name,false,f=>f.set(facade,f.get(facade).replace('export const '+name,'export let '+name)));
 control('facade frozen/copy alias '+name,false,f=>f.set(facade,f.get(facade).replace(new RegExp('(export const '+name+'[^=]*= )([^;]+);'),'$1Object.freeze($2);')));
}
for(const [label,file,from,to]of[
 ['descriptor label',owner,"name: 'White paper'","name: 'Wrong paper'"],
 ['descriptor pages',owner,'pages: 2,','pages: 99,'],
 ['descriptor independent rank',owner,'sections: 10,','sections: 0,'],
 ['descriptor metadata',owner,"icon: 'FileText'","icon: 'Wrong'"],
 ['descriptor sections',owner,"'Problem statement'","'Wrong section'"],
 ['private ordering helper',owner,'.sort((left, right) => (left.orders[projection] ?? 0) - (right.orders[projection] ?? 0))','.sort((left, right) => (right.orders[projection] ?? 0) - (left.orders[projection] ?? 0))'],
 ['projection type',owner,"'metadata' | 'sections'","'wrong' | 'sections'"],
 ['product key type',owner,"| 'whitePaper'","| 'wrongPaper'"],
 ['descriptor interface',owner,'pages: number;','pages: string;'],
 ['CASCADE exact nineteen arguments',facade,'WORKSPACE_PRODUCT_REGISTRY.ndaaAuthorizationRequest.name','WORKSPACE_PRODUCT_REGISTRY.whitePaper.name'],
 ['CASCADE pathway',facade,"['NDAA Authorization']","['Wrong pathway']"],
 ['Industry data',facade,"value: '0603563N'","value: 'wrong'"],
 ['section library',facade,"'BLUF'","'Wrong section'"],
 ['WSC fallback',facade,'SUGGESTED_PAGES[product] || 2','SUGGESTED_PAGES[product] || 99'],
 ['WSC fresh sections behavior',facade,"['Summary', 'Background', 'The ask']).slice()","['Summary', 'Background', 'The ask'])"],
 ['ordered section spec rule',facade,'targetWords: [10, 40]','targetWords: [10, 99]'],
 ['ProductMeta type',facade,'icon: string;','icon: number;'],
])control(label,false,f=>{assert(f.get(file).includes(from),label);f.set(file,f.get(file).replace(from,to));});
control('all full-statement carrier comments/whitespace harmless',true,f=>{f.set(owner,'// inert comment\n'+f.get(owner));f.set(facade,'// inert comment\n'+f.get(facade));});
control('legacy before entire config duplicate copy refused',false,f=>f.set(extra,readFileSync(path.join(root,'docs/cleanup-workspace-product-independent-review-20261012/evidence/actual802-cascade.config.ts'),'utf8')));
control('legacy metadata old-name duplicate refused',false,f=>f.set(extra,'export const PRODUCT_META = {};'));
control('legacy suggested pages old-name duplicate refused',false,f=>f.set(extra,'export const SUGGESTED_PAGES = {};'));
control('legacy section rule old-name duplicate refused',false,f=>f.set(extra,'export function sectionSpecFor(name:string){return name;}'));
control('descriptor owner namespace copy refused',false,f=>f.set(extra,'namespace Copy { export const WORKSPACE_PRODUCT_REGISTRY = {}; }'));
control('consumer parameter shadow refused',false,f=>f.set(extra,'function copied(WSC:unknown){return WSC;}'));
control('consumer destructured binding shadow refused',false,f=>f.set(extra,'const {value: PRODUCT_META} = {value:{}};'));
control('consumer property/method reserved binding refused',false,f=>f.set(extra,'class Copy { ["WSC"](){return true;} }'));
control('descriptor owner ambient declaration refused',false,f=>f.set(owner,f.get(owner).replace('export const WORKSPACE_PRODUCT_REGISTRY:', 'export declare const WORKSPACE_PRODUCT_REGISTRY:')));
control('extra canonical facade runtime import refused',false,f=>f.set(extra,"import {WSC as owned} from './cascade.config.js'; owned.industries();"));
control('extra unknown barrel runtime import refused',false,f=>f.set(extra,"import {WSC as owned} from './other-barrel.js'; owned.industries();"));
control('namespace owner import refused',false,f=>f.set(extra,"import * as owned from './workspace-product.registry.js';"));
control('default owner import refused',false,f=>f.set(extra,"import owned from './workspace-product.registry.js';"));
control('static dynamic owner import refused',false,f=>f.set(extra,"const owned=import('./workspace-product.registry.js');"));
control('static require owner import refused',false,f=>f.set(extra,"const owned=require('./workspace-product.registry.js');"));
control('owner star reexport refused',false,f=>f.set(extra,"export * from './workspace-product.registry.js';"));
control('owner named reexport refused',false,f=>f.set(extra,"export {WORKSPACE_PRODUCT_REGISTRY} from './workspace-product.registry.js';"));
control('type-only imports and lexical typeof are harmless',true,f=>f.set(extra,"import type {ProductMeta} from './cascade.config.js'; import type {WSC} from './cascade.config.js'; type InertMeta = ProductMeta; type InertWsc=typeof WSC;"));
control('type-only alias cannot replace actual runtime edge',false,f=>f.set(consumer,f.get(consumer).replace('import { WSC, SECTION_LIBRARY, type IndustryDatum }','import { type WSC, SECTION_LIBRARY, type IndustryDatum }')));
control('runtime use cannot be replaced by type query count',false,f=>f.set(consumer,f.get(consumer).replace('return WSC.industries();','return [];')+'\ntype Unused = typeof WSC;'));
control('missing descriptor owner refused',false,f=>f.delete(owner));
control('missing facade owner refused',false,f=>f.delete(facade));
control('missing consumer refused',false,f=>f.delete(consumer));
const inventory=readFileSync(path.join(root,'scripts/duplicate-helper-names.txt'),'utf8');
assert.deepEqual(inspectHelperInventory(all,inventory),{errors:[],helpers:6});results.push({label:'real six-helper inventory with preserved sectionSpecFor owner',expected:'PASS',result:'PASS'});
for(const [label,text]of [['missing existing helper row',inventory.replace('workspace-existing-product-facade\tsectionSpecFor\n','')],['duplicate existing helper row',inventory+'workspace-existing-product-facade\tsectionSpecFor\n'],['existing helper mislabeled as descriptor helper',inventory.replace('workspace-existing-product-facade\tsectionSpecFor','workspace-product-descriptors\tsectionSpecFor')],['private ordering incorrectly inventoried',inventory+'workspace-product-descriptors\tworkspaceProductsInOrder\n']]){const r=inspectHelperInventory(all,text);assert(r.errors.length>0,label);results.push({label,expected:'REFUSE',result:'PASS',errors:r.errors});}
console.log(JSON.stringify({source:'74d04937d4453813d15ec957a76337c73b712899',tree:'6ecdbf3af3c2c35df83a8a2bf28958fafe8c94f6',scope:'actual Workspace sourceMap strings; pure guard only; no application source evaluation',sourceFiles:sources.size,profiles:profiles.map(p=>({id:p.id,symbols:p.symbols.length,edges:p.edges.length,carriers:p.carriers.length})),checks:results.length,results,sourceMapSha256:createHash('sha256').update(JSON.stringify([...sources])).digest('hex')},null,2));
