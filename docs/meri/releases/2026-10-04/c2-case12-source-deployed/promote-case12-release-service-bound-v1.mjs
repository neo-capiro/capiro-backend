// Invoke the existing reviewed release CLI only after approval of the exact packet.
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const [service,...extra]=process.argv.slice(2);assert.equal(extra.length,0);assert.ok(['api','meriv2-orchestrator'].includes(service));
const REVIEWED_PACKET_SHA256='781b944fee40f504c744dda2f609f0f63446b9693dd2cdb661ecde756f749fc2';
assert.match(REVIEWED_PACKET_SHA256??'',/^[a-f0-9]{64}$/,'Concrete reviewed packet must be bound before any file or AWS access');
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002';
const read=name=>JSON.parse(readFileSync(root+'/'+name,'utf8'));
const save=(name,value)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const packet=read('case12-source-release-packet-v1.json'),approval=read('case12-release-human-approval.json');
assert.equal(approval.status,'APPROVED');assert.equal(approval.scope,'EXACT_C2_CASE12_RELEASE_AND_TEMPORARY_IAM');
assert.equal(approval.packetSha256,fingerprint(packet));assert.ok(Date.parse(packet.expiresAt)>Date.now());
assert.ok(typeof approval.reviewer==='string'&&approval.reviewer.trim());assert.ok(Date.parse(approval.approvedAt)<=Date.now());
const target=packet.services.find(s=>s.service===service);assert.equal(target.change,'IMAGE_AND_RELEASE_IDENTITY_ONLY');
assert.equal(fingerprint(packet),REVIEWED_PACKET_SHA256);
const journal=readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl');assert.equal(createHash('sha256').update(journal).digest('hex'),packet.budget.journalSha256);
const order=['api','meriv2-orchestrator'],operator=releaseOperator({aws});
for(const key of order){
 const expected=packet.services.find(s=>s.service===key),live=await operator.snapshot(key);
 if(order.indexOf(key)<order.indexOf(service)){
  const prior=read(key+'-case12-release-promotion-receipt.json');assert.equal(prior.status,'ecs-healthy-manual-acceptance-required');assert.equal(prior.candidateImage,expected.candidate.image);
  assert.equal(live.baseline.taskDefinitionArn,prior.candidateTaskDefinition);assert.equal(live.baseline.imageDigest,expected.candidate.image.split('@')[1]);assert.equal(live.baseline.taskHash,expected.candidateTaskSha256);assert.equal(live.baseline.configHash,expected.baseline.configHash);
 }else assert.deepEqual(live.baseline,expected.baseline,key+' baseline drift');
}
const arc='docs/meri/releases/2026-10-04/c2-case12-source-release/';
const qualification=JSON.parse(execFileSync('git',['show',packet.evidenceCommit+':'+arc+'release-qualification.json'],{cwd:repo,encoding:'utf8',windowsHide:true}));
assert.equal(fingerprint(qualification),packet.qualificationSha256);assert.equal(qualification.status,'AUTOMATED_QUALIFICATION_PASSED_HUMAN_RELEASE_REVIEW_PENDING');
const independent=JSON.parse(execFileSync('git',['show',packet.evidenceCommit+':'+arc+'release-independent-review.json'],{cwd:repo,encoding:'utf8',windowsHide:true}));assert.equal(independent.result,'PASS');assert.equal(independent.humanReleaseApproval,false);
assert.equal(qualification.currentSchema.status,'VERIFIED_READ_ONLY');assert.equal(packet.scope.journalMutation,false);assert.equal(packet.scope.budgetInstallation,false);
assert.deepEqual(qualification.candidates[service],target.candidate);assert.equal(qualification.schemaChange,false);
const rawSha=b=>createHash('sha256').update(b).digest('hex');
const versioned=name=>execFileSync('git',['show',packet.evidenceCommit+':'+arc+name],{cwd:repo,windowsHide:true});
assert.equal(rawSha(versioned('release-qualification.json')),packet.qualificationBytesSha256);
assert.equal(rawSha(versioned('release-independent-review.json')),packet.reviewBytesSha256);
assert.equal(independent.sourceSha,target.candidate.sourceSha);
for(const pin of independent.qualifiedArtifactPins){const raw=versioned(pin.path);assert.equal(raw.length,pin.bytes);assert.equal(rawSha(raw),pin.sha256);}
const web=await operator.snapshot('web-vnext');assert.deepEqual(web.baseline,packet.unchangedWebBaseline);
const nightly=packet.retainedNightly;
assert.equal(fingerprint(aws(['events','describe-rule','--name',nightly.rule])),nightly.ruleSha256);
const targets=aws(['events','list-targets-by-rule','--rule',nightly.rule]);assert.equal(targets.Targets.length,1);assert.equal(targets.NextToken,undefined);assert.equal(fingerprint(targets.Targets[0]),nightly.targetSha256);
const td=aws(['ecs','describe-task-definition','--task-definition',nightly.taskDefinition,'--include','TAGS']);assert.equal(td.taskDefinition.status,'ACTIVE');assert.equal(fingerprint(taskInput({...td.taskDefinition,tags:td.tags})),nightly.taskInputSha256);
assert.equal(aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker']).State,'DISABLED');
assert.deepEqual(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl'),journal);
const prefix='https://github.com/neo-capiro/capirov2/blob/'+packet.evidenceCommit+'/'+arc;
const q={schemaVersion:1,service,...target.candidate,status:'qualified',reviewer:approval.reviewer,
  reviewedAt:approval.approvedAt,expiresAt:new Date(Date.parse(approval.approvedAt)+23*3600000).toISOString(),schemaChange:false,
  evidence:[prefix+'release-qualification.json',prefix+'release-independent-review.json',prefix+target.buildEvidence],
  checks:[['build',target.buildEvidence],['automated-tests','release-qualification.json'],['retirement-compatibility','release-qualification.json']]
    .map(([name,file])=>({name,status:'passed',...target.candidate,url:prefix+file}))};
const stem=service+'-case12-release';
for(const suffix of ['human-qualification','release-manifest','promotion-authorization','promotion-receipt'])assert.equal(existsSync(root+'/'+stem+'-'+suffix+'.json'),false,'Existing execution artifact: reconcile, do not replay');
save(stem+'-human-qualification.json',q);
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
assert.deepEqual(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl'),journal);
save(stem+'-promotion-authorization.json',{at:new Date().toISOString(),packetSha256:fingerprint(packet),
  approvalSha256:fingerprint(approval),manifestSha256:fingerprint(manifest),candidateTaskSha256:target.candidateTaskSha256,
  exactPacketScopeConfirmed:true,awsMaxAttempts:1,noAutomaticRetry:true});
console.log(JSON.stringify({status:'AUTHORIZED_EXISTING_RELEASE_OPERATOR_STARTED',service,sourceSha:q.sourceSha,image:q.image,manifestSha256:fingerprint(manifest)}));
const receipt=run(['promote','--manifest',manifestPath,'--approve',fingerprint(manifest),
  '--confirm','PROMOTE_CAPIRO_PRODUCTION_'+service,'--receipt',receiptPath],30*60000);
assert.equal(receipt.status,'ecs-healthy-manual-acceptance-required');assert.equal(receipt.candidateImage,target.candidate.image);
assert.equal(receipt.candidateTaskHash,target.candidateTaskSha256);assert.equal(receipt.rollbackTaskHash,target.rollbackTaskSha256);
assert.equal(receipt.configHash,target.baseline.configHash);console.log(JSON.stringify(receipt,null,2));
