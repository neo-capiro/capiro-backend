import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { inspectV7Pins, loadRelease, readPriorCase17, DRIVER, DRIVER_SHA, DRIVER_DELTA, TESTED_CODE, RELEASE_SOURCE, inspectDriverDelta, inspectSavedPromotion } from './case17-v7-gates.mjs';

const sample = () => ({ schemaVersion: 1, kind: 'meri-case17-v7-release-pins', target: 'https://os.capiro.ai',
  testedCodeSha: TESTED_CODE, sourceSha: RELEASE_SOURCE, driverSourceSha: DRIVER_SHA,
  webSourceSha: '78ad5805679a3045b1fc10fb19beafa7f76e4e64', gatesSha256: '1'.repeat(64),
  driverSha256: '2'.repeat(64), reviewedBuildInputSha256: '3'.repeat(64), apiBuildReadbackSha256: '4'.repeat(64), apiPromotionReceiptSha256: '5'.repeat(64) });
test('pure pin shape validates exact case17 target, tested code and unchanged Web baseline', () => {
  assert.deepEqual(inspectV7Pins(sample()), sample());
  for (const change of [ p => p.target = 'https://app.capiro.ai', p => p.testedCodeSha = 'b'.repeat(40),
    p => p.driverSourceSha = 'd'.repeat(40), p => p.webSourceSha = 'c'.repeat(40), p => p.sourceSha = '', p => delete p.gatesSha256,
    p => delete p.apiBuildReadbackSha256 ]) {
    const p = sample(); change(p); assert.throws(() => inspectV7Pins(p));
  }
});
test('all earlier actual failed attempts and latest diagnostic are pinned and cleaned', () => {
  const recipe = readPriorCase17(); assert.equal(recipe.caseId, '17'); assert.equal(recipe.actors.PRIYA.physicalId, recipe.ctx.userId);
});
test('sealed local inputs bind actual healthy499 and fixed build5a08 without live calls', () => {
 const release=loadRelease('run-case17-authenticated-v7.mjs');
 assert.equal(release.sourceSha, RELEASE_SOURCE);assert.equal(release.driverSourceSha,DRIVER_SHA);
 assert.throws(()=>loadRelease('run-case17-authenticated-v6.mjs'),/V7_FIXED_DRIVER_REQUIRED/u);
 const receipt=JSON.parse(readFileSync(new URL('./api-promotion-receipt.json',import.meta.url),'utf8'));
 const api=JSON.parse(readFileSync(new URL('./api-build-readback.json',import.meta.url),'utf8'));
 assert.equal(inspectSavedPromotion(receipt,api),true);
 for(const field of ['status','candidateTaskDefinition','candidateTaskHash','deploymentId','candidateImage','configHash','manifestHash']) {
   const changed=structuredClone(receipt);changed[field]='changed';assert.throws(()=>inspectSavedPromotion(changed,api));
 }
 assert.throws(()=>inspectSavedPromotion(receipt,{...api,imageDigest:'sha256:'+'0'.repeat(64)}));
});
test('v7 runner preserves frozen v6 auth and grading byte-for-byte except exclusive paths', () => {
 const prior=readFileSync(new URL('../oct02-case17-v6/run-case17-authenticated-v6.mjs',import.meta.url),'utf8');
 const current=readFileSync(new URL('./run-case17-authenticated-v7.mjs',import.meta.url),'utf8');
 assert.equal(current.replaceAll('\r\n','\n'),prior.replaceAll('-v6','-v7').replaceAll('\r\n','\n'));
 assert.match(current,/case17-live-execution-v7\.lock/u);assert.match(current,/flag:'wx'/u);
 assert.match(current,/await revokeOwned\(\)/u);assert.match(current,/maxSynthesisSubmissions:0,maxApplicationWrites:0/u);
 assert.match(current,/originalPromptSubmission:'NOT_RUN'/u);assert.match(current,/fullOriginalRow17Acceptance:false,fullFile01Acceptance:false/u);
});

test('actual fixed clean88 driver is823 plus exactly7 reviewed eval files; runtime427 is docs only', () => {
 const git=(...args)=>execFileSync('git',args,{cwd:DRIVER,encoding:'utf8',windowsHide:true}).trim();
 assert.equal(git('rev-parse','HEAD'),DRIVER_SHA);assert.equal(git('status','--porcelain'),'');
 git('merge-base','--is-ancestor',TESTED_CODE,DRIVER_SHA);
 inspectDriverDelta(git('diff','--name-only','--no-renames','-z',TESTED_CODE,DRIVER_SHA).split('\0'));
 git('merge-base','--is-ancestor',TESTED_CODE,RELEASE_SOURCE);
 assert.ok(git('diff','--name-only','--no-renames','-z',TESTED_CODE,RELEASE_SOURCE).split('\0').filter(Boolean).every(path=>path.startsWith('docs/')));
 for(const paths of [[...DRIVER_DELTA,'apps/api/src/main.ts'],DRIVER_DELTA.slice(1),[...DRIVER_DELTA,'docs/changed.md']])assert.throws(()=>inspectDriverDelta(paths));
});

test('local readiness creates no auth, artifact root, lock, or live execution receipt', () => {
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./run-case17-authenticated-v7.mjs',import.meta.url)),'--check-readiness'],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/LOCAL_INPUTS_READY/u);
 assert.match(result.stdout,/"networkCalls":0/u);
 for(const name of ['case17-live-execution-v7.json','case17-artifacts-v7','case17-live-execution-v7.lock'])assert.equal(existsSync(new URL('./'+name,import.meta.url)),false);
});
