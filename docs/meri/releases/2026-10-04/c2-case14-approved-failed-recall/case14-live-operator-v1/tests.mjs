// Offline operator/config checks. Never invokes runOnce, withAuth or an AWS reader.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {makeApprovalConfig,makeRecallConfig} from './config.mjs';
import {sourceCheck} from './operator.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003',dir=root+'/case14-live-operator-v1',repo='C:/dev/main/meri-c1-20261002';
const prepared=sourceCheck(),a=prepared.config,passed=[];
function check(name,fn){fn();passed.push(name);console.log('PASS '+name);}
check('local-only source and input pins pass with no result or artifact creation',()=>{assert.equal(existsSync(dir+'/result.json'),false);assert.equal(existsSync(dir+'/artifacts-ui'),false);assert.equal(existsSync(dir+'/artifacts-recall'),false);assert.equal(a.reviewer.role,'user_admin');});
check('all three exact deployed source/build identities retained',()=>{for(const service of ['api','web-vnext','meriv2-orchestrator']){const build=a.deployment.builds[service];assert.equal(build.service,service);assert.equal(build.sourceSha,a.deployment.apiSha);assert.match(build.imageDigest,/^sha256:[a-f0-9]{64}$/u);assert.match(build.buildspecSha256,/^[a-f0-9]{64}$/u);}assert.equal(a.deployment.orchestratorSha,a.deployment.apiSha);});
const prior=JSON.parse(readFileSync(root+'/case17-regression-v4-prepared.json','utf8')).config.deployment,q=JSON.parse(readFileSync(repo+'/docs/meri/releases/2026-10-03/c2-combined-release/release-qualification.json','utf8'));
check('recipe drift rejected before operator authority',()=>{const r=structuredClone(a.recipe);r.ctx.userId=a.reviewer.userId;assert.throws(()=>makeApprovalConfig(a.captureRunId,r,prior,q));});
check('wrong run identity rejected',()=>assert.throws(()=>makeApprovalConfig('copied-json',a.recipe,prior,q)));
const sourceMap={'MEM-PROPOSAL-14':{frozenFixtureId:'MEM-PROPOSAL-14',kind:'memory',physicalId:'22222222-2222-4222-8222-222222222222',tenantPhysicalId:a.reviewer.tenantId,clientPhysicalId:a.recipe.clients.ASTER.physicalId,version:'candidate:6f4545a1-dcd5-5eba-8606-db2043b238ac'}};
const setup={value:{captureRunId:a.captureRunId,results:{'recall-bind':{status:'CASE14_RECALL_BOUND',sourceMap,binding:{fixtureVersion:'meri-live-v1-2026-09-26.1',seedReceiptId:'meri-synthetic-fixture-seed-receipt:sha256:'+'a'.repeat(64),resetReceiptId:'meri-synthetic-fixture-reset-receipt:sha256:'+'b'.repeat(64)}}}}};
const conversation={captureRunId:a.captureRunId,conversationId:'33333333-3333-4333-8333-333333333333',actorUserId:a.reviewer.userId,tenantId:a.reviewer.tenantId,clientId:a.recipe.clients.ASTER.physicalId};
check('native-setup-derived recall config passes exact existing scope inspector',()=>{const c=makeRecallConfig(a,setup,conversation,prepared.contract);assert.equal(c.limits.maxSpendUsd,14);assert.equal(c.scope.actors.PRIYA.role,'user_admin');assert.deepEqual(c.scope.sources,sourceMap);});
for(const[name,mutate]of[['foreign native capture',x=>{x.value.captureRunId='44444444-4444-4444-8444-444444444444';}],['foreign item tenant',x=>{x.value.results['recall-bind'].sourceMap['MEM-PROPOSAL-14'].tenantPhysicalId='44444444-4444-4444-8444-444444444444';}],['extra logical source',x=>{x.value.results['recall-bind'].sourceMap.other={};}]])check('reject '+name,()=>{const x=structuredClone(setup);mutate(x);assert.throws(()=>makeRecallConfig(a,x,conversation,prepared.contract));});
check('foreign conversation actor rejected',()=>{const c={...conversation,actorUserId:a.recipe.ctx.userId};assert.throws(()=>makeRecallConfig(a,setup,c,prepared.contract));});
check('default CLI performs readiness only',()=>{const p=spawnSync(process.execPath,[dir+'/operator.mjs'],{encoding:'utf8'});assert.equal(p.status,0);const row=JSON.parse(p.stdout);assert.equal(row.status,'LOCAL_ONLY_READY_NOT_EXECUTED');assert.equal(row.cloudCalls,0);assert.equal(existsSync(dir+'/result.json'),false);});
check('unknown CLI mode rejects before live entry',()=>{const p=spawnSync(process.execPath,[dir+'/operator.mjs','--restore-json'],{encoding:'utf8'});assert.notEqual(p.status,0);assert.equal(existsSync(dir+'/result.json'),false);});
check('source syntax checks',()=>{for(const file of ['operator.mjs','auth-owner.mjs','config.mjs','prepare.mjs'])assert.equal(spawnSync(process.execPath,['--check',dir+'/'+file]).status,0);});
const before=readFileSync(prepared.journalPath),hash=x=>createHash('sha256').update(x).digest('hex');assert.equal(hash(before),prepared.journalPrefixSha256);
const report={kind:'case14-live-operator-local-qualification',preparedBy:'Codex',status:'PASS_LOCAL_DRAFT_NOT_EXECUTED',observedAt:new Date().toISOString(),tests:passed.length,checks:passed,captureRunId:a.captureRunId,preparedSha256:hash(readFileSync(dir+'/prepared.json')),operatorSha256:hash(readFileSync(dir+'/operator.mjs')),sourcePins:prepared.sourceFiles.length,cloudCalls:0,providerCalls:0,journalMutations:0,originalPromptSubmission:'NOT_RUN',humanRubric:'NOT_RUN',fullFile01Acceptance:false};
writeFileSync(dir+'/qualification.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report,null,2));
