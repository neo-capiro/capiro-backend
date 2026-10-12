import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {analyzeTimeSource} from '../../../scripts/check-strategy-time-bypasses.mjs';
const data=JSON.parse(readFileSync('scripts/strategy-time-boundaries.json','utf8'));
const file='apps/api-strategy/src/meri/strategy-time.providers.ts';const original=readFileSync(file,'utf8');
const cases=[
 ['mutable provider declaration',original.replace('export const STRATEGY_TIME_PROVIDERS','export let STRATEGY_TIME_PROVIDERS')],
 ['function-scoped registration',original.replace('export const STRATEGY_TIME_PROVIDERS','function reviewRegister(){const STRATEGY_TIME_PROVIDERS')+'\n}'],
 ['block-scoped registration',original.replace('export const STRATEGY_TIME_PROVIDERS','{const STRATEGY_TIME_PROVIDERS')+'\n}'],
 ['shadow parameter owner',original+'\nfunction reviewShadow(STRATEGY_TIME_PROVIDERS: unknown){return STRATEGY_TIME_PROVIDERS;}'],
 ['wrong lazy field',original.replace('useValue: systemWallClock','fallback: systemWallClock')],
 ['nested wall clock box',original.replace('useValue: systemWallClock','useValue: { fallback: systemWallClock }')],
 ['wrong token role',original.replace('provide: STRATEGY_WALL_CLOCK','provide: STRATEGY_CONTEXT_RETRY')],
 ['wrong random hook',original.replace('random: systemRandom','random: systemDelay')],
 ['unfrozen retry value',original.replace('Object.freeze({ random: systemRandom, delay: systemDelay })','({ random: systemRandom, delay: systemDelay })')],
 ['extra fallback member',original.replace('delay: systemDelay','delay: systemDelay, fallback: systemWallClock')],
 ['mutable provide token',original.replace('export const STRATEGY_WALL_CLOCK','export let STRATEGY_WALL_CLOCK')],
 ['lexically shadowed freeze',original+'\nconst Object={freeze:(value:unknown)=>value};'],
 ['hook invocation in approved role',original.replace('useValue: systemWallClock','useValue: systemWallClock()')],
 ['callback wrapped hook',original.replace('useValue: systemWallClock','useValue: () => systemWallClock()')],
 ['duplicate provide property',original.replace('provide: STRATEGY_WALL_CLOCK,','provide: STRATEGY_WALL_CLOCK, provide: STRATEGY_WALL_CLOCK,')],
 ['wrong retry member name',original.replace('random: systemRandom','rng: systemRandom')],
];
cases.push(
 ['noncanonical import module',original.replace("from '@capiro/shared';", "from './review-noncanonical-time';")],
 ['undeclared shared subpath',original.replace("from '@capiro/shared';", "from '@capiro/shared/time';")],
 ['renamed noncanonical source binding',original.replace('  systemWallClock,','  reviewOtherClock as systemWallClock,')],
 ['type-only import clause',original.replace('import {\n  systemDelay,','import type {\n  systemDelay,')],
 ['type-only hook specifier',original.replace('  systemWallClock,','  type systemWallClock,')],
);
const results=cases.map(([name,source])=>{const result=analyzeTimeSource(file,source,data);return{name,source,events:result.events,problems:result.problems,rejected:result.events.length>0||result.problems.length>0};});
assert(results.every(x=>x.rejected));
const positives=[['actual registration',original],['harmless parentheses and quoted keys',original.replace('useValue: systemWallClock',"'useValue': (systemWallClock)").replace('random: systemRandom',"'random': (systemRandom)").replace('delay: systemDelay',"'delay': (systemDelay)")]];
const positiveResults=positives.map(([name,source])=>{const result=analyzeTimeSource(file,source,data);assert.deepEqual(result.events,[]);assert.deepEqual(result.problems,[]);return{name,events:result.events,problems:result.problems};});
const result={source:'c00c86917af2da637c2183fd078f4390fe0ac361',tree:'c7ccd8cb80528c3cedaeead92e5c3babcfbdf158',file,roleMutationResults:results,legitimateRegistrationResults:positiveResults,validation:'Exact actual provider-file AST with unchanged169-map baseline separately validated; negative cases require real protected reference/call events, rather than unrelated missing-file errors.',mutantsExecuted:false,nativeAcceptance:false};
writeFileSync('docs/clock-rng-final-independent-review-20261012/evidence/provider-role-review-c00.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({source:result.source,negativeCases:results.length,rejected:results.filter(x=>x.rejected).length,positiveCases:positiveResults.length,mutantsExecuted:false},null,2));
