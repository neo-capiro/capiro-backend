import assert from 'node:assert/strict';
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const APPROVED_PACKET='3ff96be0af74d1c0211191b5ae8790d95da674b8f1c4abdc3939b9679a355749';
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002';
const sha=b=>createHash('sha256').update(b).digest('hex'),read=n=>JSON.parse(readFileSync(root+'/'+n));
assert.equal(process.argv.length,2);
const packet=read('case12-compat-release-packet-v1.json'),manifest=read('case12-compat-release-manifest-v1.json');
assert.equal(fingerprint(packet),APPROVED_PACKET);assert.equal(fingerprint(manifest),packet.manifestSha256);assert.ok(Date.parse(packet.expiresAt)>Date.now());
const approvalBytes=readFileSync(root+'/case12-ecs-compat-scope-approval-v1.json');assert.equal(sha(approvalBytes),packet.approvalSha256);
const approval=JSON.parse(approvalBytes);assert.equal(approval.status,'APPROVED_SCOPED_CORRECTION');assert.equal(approval.approvedSourceChange.mergedSourceSha,packet.candidate.sourceSha);
assert.equal(manifest.qualification.sourceSha,packet.candidate.sourceSha);assert.equal(manifest.qualification.image,packet.candidate.image);
for(const name of ['case12-compat-promotion-authorization-v1.json','case12-compat-promotion-receipt-v1.json'])assert.equal(existsSync(root+'/'+name),false,'ALREADY_ATTEMPTED_RECONCILE_NO_REPLAY');
const operator=releaseOperator({aws});
for(const s of packet.services)assert.deepEqual((await operator.snapshot(s.service)).baseline,s.baseline);
const nightly=packet.retainedNightly;assert.equal(fingerprint(aws(['events','describe-rule','--name',nightly.rule])),nightly.ruleSha256);
const targets=aws(['events','list-targets-by-rule','--rule',nightly.rule]);assert.equal(targets.NextToken,undefined);assert.equal(targets.Targets.length,1);assert.equal(fingerprint(targets.Targets[0]),nightly.targetSha256);
const td=aws(['ecs','describe-task-definition','--task-definition',nightly.taskDefinition,'--include','TAGS']);assert.equal(td.taskDefinition.status,'ACTIVE');assert.equal(fingerprint(taskInput({...td.taskDefinition,tags:td.tags})),nightly.taskInputSha256);
assert.equal(aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker']).State,'DISABLED');
assert.equal(sha(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')),packet.budget.journalSha256);
const fd=openSync(root+'/case12-compat-promotion-authorization-v1.json','wx');try{writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),packetSha256:APPROVED_PACKET,manifestSha256:packet.manifestSha256,approvalSha256:packet.approvalSha256,approvalBasis:'Existing scoped human approval bound only to the qualified immutable reviewed-source image',awsMaxAttempts:1,noAutomaticRetry:true},null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
console.log(JSON.stringify({status:'APPROVED_EXISTING_RELEASE_OPERATOR_STARTED',candidate:packet.candidate,manifestSha256:packet.manifestSha256}));
let receipt;
try{receipt=JSON.parse(execFileSync(process.execPath,[repo+'/scripts/meri-release.mjs','promote','--manifest',root+'/case12-compat-release-manifest-v1.json','--approve',packet.manifestSha256,'--confirm','PROMOTE_CAPIRO_PRODUCTION_api','--receipt',root+'/case12-compat-promotion-receipt-v1.json','--profile','capiro-dev'],{cwd:repo,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,timeout:30*60000,env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',PYTHONIOENCODING:'utf8',PYTHONUTF8:'1',AWS_CLI_OUTPUT_ENCODING:'UTF8'}}));}
catch{throw Error('ATTENDED_RELEASE_FAILED_READ_DURABLE_RECEIPT_NO_RETRY');}
assert.equal(receipt.status,'ecs-healthy-manual-acceptance-required');assert.equal(receipt.candidateImage,packet.candidate.image);assert.equal(receipt.candidateTaskHash,packet.candidateTaskSha256);assert.equal(receipt.rollbackTaskHash,packet.rollbackTaskSha256);assert.equal(receipt.configHash,manifest.baseline.configHash);
console.log(JSON.stringify(receipt,null,2));
