import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,candidateTask,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003/case12-planner-release-v1',repo='C:/dev/main/meri-c1-20261002';
const read=n=>JSON.parse(readFileSync(root+'/'+n)),save=(n,v)=>writeFileSync(root+'/'+n,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const sha=b=>createHash('sha256').update(b).digest('hex');
const operator=releaseOperator({aws});
async function fence(baseline){
 for(const s of baseline.services)assert.deepEqual((await operator.snapshot(s.service)).baseline,s.baseline);
 const n=baseline.retainedNightly;assert.equal(fingerprint(aws(['events','describe-rule','--name',n.rule])),n.ruleSha256);
 const targets=aws(['events','list-targets-by-rule','--rule',n.rule]);assert.equal(targets.NextToken,undefined);assert.equal(targets.Targets.length,1);assert.equal(fingerprint(targets.Targets[0]),n.targetSha256);
 const td=aws(['ecs','describe-task-definition','--task-definition',n.taskDefinition,'--include','TAGS']);assert.equal(fingerprint(taskInput({...td.taskDefinition,tags:td.tags})),n.taskInputSha256);
 assert.equal(fingerprint(aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker'])),baseline.broadProjectionWorker.ruleSha256);
 assert.equal(sha(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')),baseline.journalSha256);
}
const mode=process.argv[2];
if(mode==='prepare'){
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
 assert.equal(execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim(),'');
 const arc='docs/meri/releases/2026-10-04/c2-case12-planner-release/';
 const versioned=n=>execFileSync('git',['show',commit+':'+arc+n],{cwd:repo,windowsHide:true,maxBuffer:8*1024*1024});
 const qualification=JSON.parse(versioned('release-qualification.json'));
 for(const pin of qualification.artifactPins){const b=versioned(pin.path);assert.equal(b.length,pin.bytes);assert.equal(sha(b),pin.sha256);}
 const baseline=read('served-baseline.json');assert.deepEqual(baseline,JSON.parse(versioned('served-baseline.json')));await fence(baseline);
 const {sourceSha,image}=qualification.candidate;assert.equal(sourceSha,baseline.candidateSourceSha);assert.equal(image,baseline.candidateImage);
 const prefix='https://github.com/neo-capiro/capirov2/blob/'+commit+'/'+arc;
 const q={schemaVersion:1,service:'api',sourceSha,image,status:'qualified',reviewer:qualification.reviewer,reviewedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),schemaChange:false,evidence:[prefix+'release-qualification.json',prefix+'served-baseline.json'],checks:[['build','build/build-readback.json'],['automated-tests','release-qualification.json'],['retirement-compatibility','served-baseline.json']].map(([name,p])=>({name,status:'passed',sourceSha,image,url:prefix+p}))};
 const manifest=await operator.prepare(q),live=await operator.snapshot('api');assert.deepEqual(manifest.baseline,live.baseline);
 const packet={preparedAt:new Date().toISOString(),evidenceCommit:commit,manifestSha256:fingerprint(manifest),candidate:qualification.candidate,candidateTaskSha256:fingerprint(candidateTask(live.task,'api',image,sourceSha)),rollbackTaskSha256:fingerprint(candidateTask(live.task,'api',live.task.containerDefinitions.find(c=>c.name==='api').image)),baseline,authorizationBasis:qualification.authorizationBasis};
 save('qualification.json',q);save('manifest.json',manifest);save('packet.json',packet);console.log(JSON.stringify({status:'PREPARED',packetSha256:fingerprint(packet),manifestSha256:fingerprint(manifest),candidate:packet.candidate}));
}else if(mode==='promote'){
 const packet=read('packet.json'),manifest=read('manifest.json');assert.equal(fingerprint(packet),process.argv[3]);assert.equal(fingerprint(manifest),packet.manifestSha256);
 for(const n of ['authorization.json','receipt.json'])assert.equal(existsSync(root+'/'+n),false,'ATTEMPT_ALREADY_EXISTS_RECONCILE_ONLY');await fence(packet.baseline);
 save('authorization.json',{at:new Date().toISOString(),packetSha256:fingerprint(packet),manifestSha256:packet.manifestSha256,authorizationBasis:packet.authorizationBasis,awsMaxAttempts:1,noAutomaticRetry:true});
 console.log(JSON.stringify({status:'PROMOTION_STARTED',candidate:packet.candidate}));
 let receipt;
 try{receipt=JSON.parse(execFileSync(process.execPath,[repo+'/scripts/meri-release.mjs','promote','--manifest',root+'/manifest.json','--approve',packet.manifestSha256,'--confirm','PROMOTE_CAPIRO_PRODUCTION_api','--receipt',root+'/receipt.json','--profile','capiro-dev'],{cwd:repo,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,timeout:30*60000,env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',PYTHONIOENCODING:'utf8',PYTHONUTF8:'1',AWS_CLI_OUTPUT_ENCODING:'UTF8'}}));}catch{throw Error('RELEASE_FAILED_READ_DURABLE_RECEIPT_NO_REPLAY');}
 assert.equal(receipt.status,'ecs-healthy-manual-acceptance-required');assert.equal(receipt.candidateTaskHash,packet.candidateTaskSha256);assert.equal(receipt.rollbackTaskHash,packet.rollbackTaskSha256);console.log(JSON.stringify(receipt));
}else throw Error('EXPECTED_PREPARE_OR_BOUND_PROMOTE');
