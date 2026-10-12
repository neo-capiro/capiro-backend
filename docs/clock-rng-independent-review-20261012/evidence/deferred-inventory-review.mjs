import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {analyzeTimeSource} from '../../../scripts/check-strategy-time-bypasses.mjs';
const pin='f86bf11b9b6da367d464da453ee1f260fa60e06e',base='1bf52945b9fa01496ce41a349f8eaace490ad4ac';
const files=execFileSync('git',['ls-tree','-r','--name-only',pin,'--','apps/api-strategy/src'],{encoding:'utf8'}).split('\n').filter(f=>f.endsWith('.ts')&&!/\.(?:spec|test|d)\.ts$/.test(f));
const oldFiles=new Set(execFileSync('git',['ls-tree','-r','--name-only',base,'--','apps/api-strategy/src'],{encoding:'utf8'}).split('\n').filter(f=>f.endsWith('.ts')&&!/\.(?:spec|test|d)\.ts$/.test(f)));
const before=new Map(),after=new Map();function append(target,events){for(const key of events)target.set(key,(target.get(key)??0)+1);}
for(const file of files){append(after,analyzeTimeSource(file,readFileSync(file,'utf8')).events);if(oldFiles.has(file))append(before,analyzeTimeSource(file,execFileSync('git',['show',base+':'+file],{encoding:'utf8'})).events);}
const removed=[...before].filter(([key,n])=>(after.get(key)??0)!==n).map(([key,n])=>({key,before:n,after:after.get(key)??0}));
assert.equal(removed.length,6);assert.ok(removed.every(x=>x.before===1&&x.after===0));
for(const [key,n]of after)assert.equal(before.get(key),n,'unchanged deferred sample: '+key);
const data=JSON.parse(readFileSync('scripts/strategy-time-boundaries.json','utf8'));const allowed=new Map(data.existingAmbient.map(x=>[x.key,x]));
for(const [key,n]of after){assert.equal(allowed.get(key)?.maximum,n);assert.equal(allowed.get(key)?.status,'existing-unconverted');assert.ok(allowed.get(key)?.reason);}
const deferredSamples=[...after.values()].reduce((a,b)=>a+b,0);assert.equal(deferredSamples,123);
const providerFile='packages/shared/src/time.ts';const providerEvents=analyzeTimeSource(providerFile,readFileSync(providerFile,'utf8')).events;assert.equal(providerEvents.length,3);
for(const key of providerEvents)assert.equal(allowed.get(key)?.maximum,1);
assert.equal(data.existingAmbient.reduce((n,x)=>n+x.maximum,0),126);
const receipt={source:pin,base,passed:true,originalProductionFiles:oldFiles.size,currentStrategyProductionFiles:files.length,currentWithSharedProviderFiles:files.length+1,originalAmbientSamples:[...before.values()].reduce((a,b)=>a+b,0),removedConvertedSamples:removed,deferredStaticSamples:deferredSamples,deferredIdentities:after.size,canonicalProviderStaticSamples:providerEvents,manifestRows:data.existingAmbient.length,allCurrentDeferredCountsAndOwnersExactToOriginal:true,allDeferredRowsHaveExactPositiveCountsStatusReason:true,deferredDateClocksAcceptedAsFullyConverted:false,nativeAcceptance:false};
writeFileSync('docs/clock-rng-independent-review-20261012/evidence/deferred-inventory-review.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({passed:true,originalSamples:receipt.originalAmbientSamples,removed:6,deferredSamples,providerSamples:3,productionFiles:files.length+1},null,2));
