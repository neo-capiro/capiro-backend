// Invoke the existing reviewed release CLI only after approval of the exact packet.
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const [service]=process.argv.slice(2);assert.ok(['api','meriv2-orchestrator','web-vnext'].includes(service));
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002';
const read=name=>JSON.parse(readFileSync(root+'/'+name,'utf8'));
const save=(name,value)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const packet=read('combined-c2-release-packet-v1.json'),approval=read('combined-c2-human-approval.json');
assert.equal(approval.status,'APPROVED');assert.equal(approval.scope,'EXACT_C2_COMBINED_RELEASE');
assert.equal(approval.packetSha256,fingerprint(packet));assert.ok(Date.parse(packet.expiresAt)>Date.now());
assert.ok(typeof approval.reviewer==='string'&&approval.reviewer.trim());assert.ok(Date.parse(approval.approvedAt)<=Date.now());
const target=packet.services.find(s=>s.service===service);assert.equal(target.change,'IMAGE_AND_RELEASE_IDENTITY_ONLY');
assert.equal(fingerprint(packet),'8f246b44000e35548444642a31079c8b65f04aa3abf6fd0fcf6768864c3f9c7b');
const journal=readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl');assert.equal(createHash('sha256').update(journal).digest('hex'),packet.budget.journalSha256);
const order=['api','meriv2-orchestrator','web-vnext'],operator=releaseOperator({aws});
for(const key of order){
 const expected=packet.services.find(s=>s.service===key),live=await operator.snapshot(key);
 if(order.indexOf(key)<order.indexOf(service)){
  const prior=read(key+'-combined-c2-promotion-receipt.json');assert.equal(prior.status,'ecs-healthy-manual-acceptance-required');assert.equal(prior.candidateImage,expected.candidate.image);
  assert.equal(live.baseline.taskDefinitionArn,prior.candidateTaskDefinition);assert.equal(live.baseline.imageDigest,expected.candidate.image.split('@')[1]);assert.equal(live.baseline.taskHash,expected.candidateTaskSha256);assert.equal(live.baseline.configHash,expected.baseline.configHash);
 }else assert.deepEqual(live.baseline,expected.baseline,key+' baseline drift');
}
const arc='docs/meri/releases/2026-10-03/c2-combined-release/';
const qualification=JSON.parse(execFileSync('git',['show',packet.evidenceCommit+':'+arc+'release-qualification.json'],{cwd:repo,encoding:'utf8',windowsHide:true}));
assert.equal(fingerprint(qualification),packet.qualificationSha256);assert.equal(qualification.status,'AUTOMATED_QUALIFICATION_PASSED_HUMAN_RELEASE_REVIEW_PENDING');
const independent=JSON.parse(execFileSync('git',['show',packet.evidenceCommit+':'+arc+'release-independent-review.json'],{cwd:repo,encoding:'utf8',windowsHide:true}));assert.equal(independent.result,'PASS');assert.equal(independent.humanReleaseApproval,false);
assert.equal(qualification.currentSchema.status,'VERIFIED_READ_ONLY');assert.equal(qualification.scope.journalMutation,false);assert.equal(qualification.scope.budgetInstallation,false);
assert.deepEqual(qualification.candidates[service],target.candidate);assert.equal(qualification.schemaChange,false);
const prefix='https://github.com/neo-capiro/capirov2/blob/'+packet.evidenceCommit+'/'+arc;
const q={schemaVersion:1,service,...target.candidate,status:'qualified',reviewer:approval.reviewer,
  reviewedAt:approval.approvedAt,expiresAt:new Date(Date.parse(approval.approvedAt)+23*3600000).toISOString(),schemaChange:false,
  evidence:[prefix+'release-qualification.json',prefix+'release-independent-review.json',prefix+target.buildEvidence],
  checks:[['build',target.buildEvidence],['automated-tests','release-qualification.json'],['retirement-compatibility','release-qualification.json']]
    .map(([name,file])=>({name,status:'passed',...target.candidate,url:prefix+file}))};
const stem=service+'-combined-c2';save(stem+'-human-qualification.json',q);
const run=(args,timeout)=>{
  try{return JSON.parse(execFileSync(process.execPath,[repo+'/scripts/meri-release.mjs',...args,'--profile','capiro-dev'],{
    cwd:repo,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,timeout,
    env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',PYTHONIOENCODING:'utf8',PYTHONUTF8:'1',AWS_CLI_OUTPUT_ENCODING:'UTF8'},
  }));}catch{throw new Error('ATTENDED_RELEASE_COMMAND_FAILED_INSPECT_DURABLE_RECEIPT_NO_RETRY');}
};
const manifestPath=root+'/'+stem+'-release-manifest.json',receiptPath=root+'/'+stem+'-promotion-receipt.json';
run(['prepare','--qualification',root+'/'+stem+'-human-qualification.json','--out',manifestPath],240000);
const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
assert.deepEqual(manifest.baseline,target.baseline);assert.deepEqual(manifest.qualification,q);
assert.ok(Date.parse(packet.expiresAt)>Date.now());
save(stem+'-promotion-authorization.json',{at:new Date().toISOString(),packetSha256:fingerprint(packet),
  approvalSha256:fingerprint(approval),manifestSha256:fingerprint(manifest),candidateTaskSha256:target.candidateTaskSha256,
  exactPacketScopeConfirmed:true,awsMaxAttempts:1,noAutomaticRetry:true});
console.log(JSON.stringify({status:'AUTHORIZED_EXISTING_RELEASE_OPERATOR_STARTED',service,sourceSha:q.sourceSha,image:q.image,manifestSha256:fingerprint(manifest)}));
const receipt=run(['promote','--manifest',manifestPath,'--approve',fingerprint(manifest),
  '--confirm','PROMOTE_CAPIRO_PRODUCTION_'+service,'--receipt',receiptPath],30*60000);
assert.equal(receipt.status,'ecs-healthy-manual-acceptance-required');assert.equal(receipt.candidateImage,target.candidate.image);
assert.equal(receipt.candidateTaskHash,target.candidateTaskSha256);assert.equal(receipt.rollbackTaskHash,target.rollbackTaskSha256);
assert.equal(receipt.configHash,target.baseline.configHash);console.log(JSON.stringify(receipt,null,2));
