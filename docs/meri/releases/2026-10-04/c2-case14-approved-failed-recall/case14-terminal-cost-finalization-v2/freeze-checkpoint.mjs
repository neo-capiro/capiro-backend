import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {hash,semantic} from './predicate.mjs';
import {FINALIZATION} from './finalization-pins.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
if(!['FROZEN_AWAITING_ROOT_INDEPENDENT_REVIEW','REVIEWED_FIXED_COST_ONLY_EVIDENCE'].includes(FINALIZATION.status))throw Error('ACTIVATION_STATE_CHANGED');
for(const p of FINALIZATION.sourcePins){const b=fs.readFileSync(p.path);if(hash(b)!==p.sha256||b.length!==p.bytes)throw Error('FINAL_SOURCE_DRIFT');}
const files=['proof.json','finalization-pins.mjs','review-request.json','authority.mjs','predicate.mjs','fixed.mjs','bridge.mjs','operator.mjs','dry-run-driver.py','accept-root-review.mjs','native/windows-capture-spend.py','native/windows-artifact-protocol.py','native/windows-owned-artifacts.py','node-tests.log','native-tests.log','tests.mjs','native-tests.py','operator-dry-test-result.json','copy-provenance.json','README.md'];
const checkpoint={kind:'case14-authentic-terminal-cost-finalization',status:'LOCAL_QUALIFICATION_PASS_PENDING_ROOT_REVIEW_RECORD',at:new Date().toISOString(),preparedBy:'Codex independent supervisor; not Hermes',activation:FINALIZATION.status,authenticPostdeadlineReadbackSha256:'6bf04ccb58fe4410bff0f665c635cc230148ab7ae7ea6509ccc5c6493a40c7c1',proofSha256:FINALIZATION.proofSha256,evidencePinsSha256:FINALIZATION.reviewedEvidenceSha256,sourcePinsSha256:semantic(FINALIZATION.sourcePins),tests:{node:10,nativeNtfsDisposable:8,failures:0},liveJournalRead:false,liveJournalMutations:0,providerCalls:0,cloudCalls:0,repositoryEdits:0,expectedAccounting:{knownRecallCostMicros:1569851,conservativeApprovalCostMicros:1000000,approvalBilledActualMicros:null,aggregateKnownSettledCostMicros:15200909,aggregateCommittedCostMicros:16200909,aggregateRemainingReservationMicros:13799091},captureAuthority:false,captureStatus:'CAPTURE_UNCERTAIN',answerGrade:'NOT_EVALUATED',files:files.map(name=>{const b=fs.readFileSync(root+'/'+name);return{name,bytes:b.length,sha256:hash(b)};})};
checkpoint.testedActivation='FROZEN_AWAITING_ROOT_INDEPENDENT_REVIEW';
checkpoint.supervisorActivated=false;
if(FINALIZATION.status==='REVIEWED_FIXED_COST_ONLY_EVIDENCE'){
 const reviewBytes=fs.readFileSync(FINALIZATION.review.path);if(hash(reviewBytes)!=='ce8f4626cb2fea65d5163de3348575c43678d0381c7326edab86f7f9238a021d'||hash(reviewBytes)!==FINALIZATION.review.sha256)throw Error('ROOT_REVIEW_DRIFT');
 checkpoint.status='LOCAL_QUALIFICATION_PASS_ROOT_REVIEW_ACTIVATION_OBSERVED';
 checkpoint.rootReview={path:FINALIZATION.review.path,sha256:hash(reviewBytes)};
 if(fs.existsSync(root+'/root-dry-run.json')){const b=fs.readFileSync(root+'/root-dry-run.json');checkpoint.rootDryRun={path:root+'/root-dry-run.json',sha256:hash(b),bytes:b.length};}
}
fs.writeFileSync(root+'/checkpoint.json',JSON.stringify(checkpoint,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({checkpointSha256:hash(fs.readFileSync(root+'/checkpoint.json')),proofSha256:checkpoint.proofSha256,sourcePinsSha256:checkpoint.sourcePinsSha256,activation:checkpoint.activation,sourceFiles:checkpoint.files.filter(x=>['authority.mjs','operator.mjs','bridge.mjs','native/windows-capture-spend.py'].includes(x.name))}));
