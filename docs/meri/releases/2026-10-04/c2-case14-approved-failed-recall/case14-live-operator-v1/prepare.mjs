// Local source/config preparation only. Does not create an auth session or journal event.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {makeApprovalConfig} from './config.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002',dir=root+'/case14-live-operator-v1';
const sha=b=>createHash('sha256').update(b).digest('hex'),pin=path=>({path,sha256:sha(readFileSync(path))});
const recipePath=root+'/case14-native-execute-input-v1.json',deploymentPath=root+'/case17-regression-v4-prepared.json',qualificationPath=repo+'/docs/meri/releases/2026-10-03/c2-combined-release/release-qualification.json';
const checkpointPath=root+'/cost-supervised-v1/executed-once/aggregate-checkpoint.json',contractPath=repo+'/evals/meri/live-v1/contract-lock.json';
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const previous=existsSync(dir+'/prepared.json')?read(dir+'/prepared.json'):null;
const config=makeApprovalConfig(previous?.config.captureRunId??randomUUID(),read(recipePath).recipe,read(deploymentPath).config.deployment,read(qualificationPath));
const all=new Map();
function visit(path){path=resolve(path).replaceAll('\\','/');if(all.has(path))return;assert.ok(existsSync(path),path);if(!statSync(path).isFile())return;all.set(path,pin(path));if(!/\.(?:mjs|js)$/u.test(path))return;const source=readFileSync(path,'utf8');for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\bimport\s*)['"](\.[^'"]+)['"]/gu)){const child=resolve(dirname(path),match[1]);if(existsSync(child))visit(child);}for(const match of source.matchAll(/new URL\(['"](\.[^'"]+)['"],\s*import\.meta\.url\)/gu)){const child=resolve(dirname(path),match[1]);if(existsSync(child))visit(child);}}
visit(dir+'/operator.mjs');
for(const p of ['evals/meri/live-v1/lib/windows-capture-spend.py','evals/meri/live-v1/lib/windows-artifact-protocol.py','evals/meri/live-v1/case14-approval-cost-evidence.json','evals/meri/live-v1/contract-lock.json'])visit(repo+'/'+p);
const journalPath='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl';
assert.equal(sha(readFileSync(journalPath)),'8f20134f71dde90e32fc0c3c2aba2da2d5b93dd13fffea31b83105d1621bc3e5');
const prepared={kind:'case14-combined-owned-live-operator-preparation',version:1,preparedBy:'Codex',status:'PREPARED_NOT_EXECUTED',preparedAt:new Date().toISOString(),config,contract:read(contractPath),
 aggregateCheckpointPath:checkpointPath,journalPath,journalPrefixSha256:sha(readFileSync(journalPath)),sourceFiles:[...all.values()].sort((a,b)=>a.path.localeCompare(b.path)),
 inputFiles:[recipePath,deploymentPath,qualificationPath,checkpointPath,root+'/case14-postapproval-preparation-v2/reviewed-rates-retained.json'].map(pin),
 assertions:{sameProcessCapabilitiesRequired:true,maximumApprovalSubmissions:1,maximumRecallSubmissions:1,maximumConversationCreates:1,combinedHoldMicros:15000000,conservativeApprovalCeilingMicros:1000000,recallCeilingMicros:14000000,automaticRetryAllowed:false,originalPromptSubmission:'NOT_RUN',humanRubric:'NOT_RUN',fullOriginalRow14Acceptance:false,fullFile01Acceptance:false},
 entry:{localOnly:['node',dir+'/operator.mjs','--check-readiness'],leadOnlyLive:['node',dir+'/operator.mjs','--run-once'],visualReviewCommand:'GRADE_SAVED_CASE14_VISUAL_REVIEW',visualReviewFile:dir+'/visual-review.json',visualReviewCommandFile:dir+'/visual-review-command.txt'},
 limits:['This local draft does not independently authorize execution. Lead owns reviewed source pins and the one live invocation.','Any change to pinned source requires review and a new preparation before live use.','No restart/replay after result.json exists; uncertain auth/setup/provider outcomes require reconciliation.','Visual review uses saved screenshots after all sessions are cleaned; human rubric and original prompt remain NOT_RUN.']};
if(previous){assert.ok(!existsSync(dir+'/result.json'));const bytes=readFileSync(dir+'/prepared.json');writeFileSync(dir+'/prepared-before-final-source-pins.json',bytes,{flag:'wx'});prepared.preservedPriorPreparation={path:dir+'/prepared-before-final-source-pins.json',sha256:sha(bytes)};}
writeFileSync(dir+'/prepared.json',JSON.stringify(prepared,null,2)+'\n',{flag:previous?'w':'wx'});
console.log(JSON.stringify({status:prepared.status,captureRunId:config.captureRunId,sourceFiles:all.size,preparedSha256:sha(readFileSync(dir+'/prepared.json')),cloudCalls:0,journalMutations:0}));
