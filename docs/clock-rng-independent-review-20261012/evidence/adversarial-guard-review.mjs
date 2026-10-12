import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { analyzeTimeSource, checkTimeSources } from '../../../scripts/check-strategy-time-bypasses.mjs';
const data=JSON.parse(readFileSync('scripts/strategy-time-boundaries.json','utf8'));
const sources=new Map();
function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=dir+'/'+entry.name;if(entry.isDirectory())walk(file);else if(file.endsWith('.ts')&&!/\.(?:spec|test|d)\.ts$/.test(file))sources.set(file,readFileSync(file,'utf8'));}}
for(const dir of data.sourceRoots)walk(dir);
for(const file of data.extraSourceFiles??[])sources.set(file,readFileSync(file,'utf8'));
const original=checkTimeSources(sources,data);assert.deepEqual(original,[]);
const file='apps/api-strategy/src/meri/context-load.ts';
const cases=[
 ['direct clock','function reviewProbe(){return Date.now();}'],
 ['global alias clock','function reviewProbe(){const ambient=globalThis;return ambient.Date.now();}'],
 ['computed global clock',"function reviewProbe(){return globalThis['Da'+'te']['now']();}"],
 ['global alias random','function reviewProbe(){const ambient=globalThis;return ambient.Math.random();}'],
 ['computed global random',"function reviewProbe(){return globalThis['Ma'+'th']['random']();}"],
 ['global alias constructor','function reviewProbe(){const ambient=globalThis;return new ambient.Date();}'],
 ['computed global constructor',"function reviewProbe(){return new (globalThis['Da'+'te'])();}"],
 ['global alias timer','function reviewProbe(){const ambient=globalThis;return ambient.setTimeout(()=>{},1);}'],
 ['computed global timer',"function reviewProbe(){return globalThis['set'+'Timeout'](()=>{},1);}"],
 ['system local alias',"import { systemWallClock } from '@capiro/shared';function reviewProbe(){const clock=systemWallClock;return clock();}"],
 ['system namespace destructure',"import * as sharedTime from '@capiro/shared';function reviewProbe(){const {systemWallClock:clock}=sharedTime;return clock();}"],
 ['retry local alias','function reviewProbe(){const retry:any=withContextRetry;return retry("x",()=>1);}'],
 ['quoted canonical method','class ReviewProbe { "withContextRetry"() {return 1;} }'],
 ['computed canonical method','class ReviewProbe { ["withContextRetry"]() {return 1;} }'],
 ['timer module namespace',"import * as timers from 'node:timers';function reviewProbe(){return timers.setTimeout(()=>{},1);}"],
 ['direct system fallback','function reviewProbe(){return systemWallClock();}'],
];
const results=cases.map(([name,addition])=>{const mutated=new Map(sources);mutated.set(file,sources.get(file)+'\n'+addition+'\n');const failures=checkTimeSources(mutated,data);const analysis=analyzeTimeSource(file,addition);return{name,addition,expected:'reject new clock/random/retry/canonical/timer bypass',rejected:failures.length>0,failures,analysis};});
const result={source:'f86bf11b9b6da367d464da453ee1f260fa60e06e',sourceFiles:sources.size,baselineFailures:original,results,unexpectedlyAccepted:results.filter(x=>!x.rejected).map(x=>x.name),nativeAcceptance:false,mutantsExecuted:false};
writeFileSync('docs/clock-rng-independent-review-20261012/evidence/adversarial-guard-review.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({sourceFiles:sources.size,cases:results.length,rejected:results.filter(x=>x.rejected).length,unexpectedlyAccepted:result.unexpectedlyAccepted},null,2));
