import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {sourceFiles,checkTimeSources} from '../../../scripts/check-strategy-time-bypasses.mjs';
const data=JSON.parse(readFileSync('scripts/strategy-time-boundaries.json','utf8'));
const sources=sourceFiles(process.cwd(),data.sourceRoots);
for(const file of data.extraSourceFiles??[])sources.set(file,readFileSync(file,'utf8'));
assert.deepEqual(checkTimeSources(sources,data),[]);
const file='apps/api-strategy/src/meri/strategy-time.providers.ts';
const cases=[
 ['function-local same-name owner',`export function reviewShadowProvider(){const STRATEGY_TIME_PROVIDERS={clock:systemWallClock};return STRATEGY_TIME_PROVIDERS;} export function reviewShadowCall(){return reviewShadowProvider().clock();}`],
 ['block-local same-name owner',`{const STRATEGY_TIME_PROVIDERS={clock:systemWallClock};const reviewGet=()=>STRATEGY_TIME_PROVIDERS;exportedReviewSink(reviewGet);} declare function exportedReviewSink(x:unknown):void;`],
 ['callback same-name owner',`export const reviewFactory=()=>{const STRATEGY_TIME_PROVIDERS={clock:systemWallClock};return STRATEGY_TIME_PROVIDERS;}; export function reviewShadowCall(){return reviewFactory().clock();}`],
];
const results=cases.map(([name,addition])=>{const mutated=new Map(sources);mutated.set(file,sources.get(file)+'\n'+addition+'\n');const failures=checkTimeSources(mutated,data);return {name,addition,failures,rejected:failures.length>0};});
const result={source:'aa1ce11fd480cf664f5b3d1902a61751368d238d',tree:'8f97dc2a55aa837115d43f9d2a38a443ee914afb',sourceFiles:sources.size,results,mutantsExecuted:false,nativeAcceptance:false};
writeFileSync('docs/clock-rng-repaired-independent-review-20261012/evidence/provider-shadow-red.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
