import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,candidateTask,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const out='C:/dev/main/outputs/meri-c2-20261003',root=out+'/sol-release-v1',repo='C:/dev/main/meri-c1-20261002';
const commit='d520bb0e373cc8e3a00383a72dd0b2ab2ab350f9',arc='docs/meri/releases/2026-10-04/c2-sol-release/';
const read=p=>JSON.parse(readFileSync(p)),sha=b=>createHash('sha256').update(b).digest('hex');
const service=process.argv[2],mode=process.argv[3];assert.ok(['api','meriv2-orchestrator'].includes(service));
const dir=root+'/'+service,save=(n,v)=>writeFileSync(dir+'/'+n,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const operator=releaseOperator({aws}),initial=read(root+'/served-baseline.json');
const versioned=n=>execFileSync('git',['show',commit+':'+arc+n],{cwd:repo,windowsHide:true,maxBuffer:8*1024*1024});
const qualification=JSON.parse(versioned('release-qualification.json'));
for(const pin of qualification.artifactPins){const b=versioned(pin.path);assert.equal(b.length,pin.bytes);assert.equal(sha(b),pin.sha256);}
assert.deepEqual(initial,JSON.parse(versioned('served-baseline.json')));
const candidate=qualification.candidates.find(c=>c.service===service);assert.ok(candidate);
const probe=read(out+'/sol-live-probe-v1/execution/result.json');assert.equal(probe.status,'LIVE_MODEL_AND_TOOL_CONTINUATION_PROBE_PASS');
const budget=read(out+'/sol-probe-budget-root-v1/native-ack.json');assert.equal(budget.snapshot.eventCount,32);
async function commonFence(){
 assert.equal(aws(['sts','get-caller-identity']).Account,'967807252336');
 const n=initial.retainedNightly;assert.equal(fingerprint(aws(['events','describe-rule','--name',n.rule])),n.ruleSha256);
 const targets=aws(['events','list-targets-by-rule','--rule',n.rule]);assert.equal(targets.NextToken,undefined);assert.equal(targets.Targets.length,1);assert.equal(fingerprint(targets.Targets[0]),n.targetSha256);
 const td=aws(['ecs','describe-task-definition','--task-definition',n.taskDefinition,'--include','TAGS']);assert.equal(fingerprint(taskInput({...td.taskDefinition,tags:td.tags})),n.taskInputSha256);
 assert.equal(fingerprint(aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker'])),initial.broadProjectionWorker.ruleSha256);
 assert.equal(sha(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')),budget.state.files['fresh-spend.jsonl'].sha256);
}
if(mode==='prepare'){
 assert.equal(existsSync(dir),false,'PRIOR_PREPARE_EXISTS');
 await commonFence();const services=[];let live;
 for(const s of initial.services){
  const now=await operator.snapshot(s.service),receiptPath=root+'/'+s.service+'/receipt.json';
  if(existsSync(receiptPath)){
   const prior=read(receiptPath),packet=read(root+'/'+s.service+'/packet.json');assert.equal(prior.status,'ecs-healthy-manual-acceptance-required');
   assert.equal(now.baseline.taskDefinitionArn,prior.candidateTaskDefinition);assert.equal(now.baseline.taskHash,packet.candidateTaskSha256);assert.equal(now.baseline.configHash,s.baseline.configHash);
  }else assert.deepEqual(now.baseline,s.baseline);
  if(s.service===service)live=now;
  const tasks=aws(['ecs','list-tasks','--cluster','capiro-dev','--service-name','capiro-dev-'+s.service,'--desired-status','RUNNING']);assert.equal(tasks.nextToken,undefined);
  services.push({service:s.service,baseline:now.baseline,oldTaskArns:tasks.taskArns});
 }
 const prefix='https://github.com/neo-capiro/capirov2/blob/'+commit+'/'+arc;
 const {sourceSha,image}=candidate;
 const q={schemaVersion:1,service,sourceSha,image,status:'qualified',reviewer:qualification.reviewer,reviewedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),schemaChange:false,evidence:[prefix+'release-qualification.json',prefix+'served-baseline.json'],checks:[['build',service+'/build-readback.json'],['automated-tests','release-qualification.json'],['retirement-compatibility','served-baseline.json']].map(([name,p])=>({name,status:'passed',sourceSha,image,url:prefix+p}))};
 const manifest=await operator.prepare(q);assert.deepEqual(manifest.baseline,live.baseline);
 const packet={preparedAt:new Date().toISOString(),evidenceCommit:commit,manifestSha256:fingerprint(manifest),candidate,candidateTaskSha256:fingerprint(candidateTask(live.task,service,image,sourceSha)),rollbackTaskSha256:fingerprint(candidateTask(live.task,service,live.task.containerDefinitions.find(c=>c.name===service).image)),services,journalSha256:budget.state.files['fresh-spend.jsonl'].sha256,probeResultSha256:sha(readFileSync(out+'/sol-live-probe-v1/execution/result.json')),authorizationBasis:qualification.authorizationBasis};
 mkdirSync(dir);save('qualification.json',q);save('manifest.json',manifest);save('packet.json',packet);console.log(JSON.stringify({status:'PREPARED',service,packetSha256:fingerprint(packet),manifestSha256:fingerprint(manifest),candidate}));
}else if(mode==='promote'){
 const packet=read(dir+'/packet.json'),manifest=read(dir+'/manifest.json');assert.equal(fingerprint(packet),process.argv[4]);assert.equal(fingerprint(manifest),packet.manifestSha256);
 for(const n of ['authorization.json','receipt.json'])assert.equal(existsSync(dir+'/'+n),false,'PRIOR_ATTEMPT_RECONCILE_ONLY');
 await commonFence();for(const s of packet.services)assert.deepEqual((await operator.snapshot(s.service)).baseline,s.baseline);
 save('authorization.json',{at:new Date().toISOString(),packetSha256:fingerprint(packet),manifestSha256:packet.manifestSha256,authorizationBasis:packet.authorizationBasis,awsMaxAttempts:1,noAutomaticRetry:true});
 console.log(JSON.stringify({status:'PROMOTION_STARTED',candidate}));
 let receipt;
 try{receipt=JSON.parse(execFileSync(process.execPath,[repo+'/scripts/meri-release.mjs','promote','--manifest',dir+'/manifest.json','--approve',packet.manifestSha256,'--confirm','PROMOTE_CAPIRO_PRODUCTION_'+service,'--receipt',dir+'/receipt.json','--profile','capiro-dev'],{cwd:repo,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,timeout:30*60000,env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',PYTHONIOENCODING:'utf8',PYTHONUTF8:'1',AWS_CLI_OUTPUT_ENCODING:'UTF8'}}));}catch{throw Error('RELEASE_FAILED_READ_DURABLE_RECEIPT_NO_REPLAY');}
 assert.equal(receipt.status,'ecs-healthy-manual-acceptance-required');assert.equal(receipt.candidateTaskHash,packet.candidateTaskSha256);assert.equal(receipt.rollbackTaskHash,packet.rollbackTaskSha256);console.log(JSON.stringify(receipt));
}else throw Error('EXPECTED_PREPARE_OR_BOUND_PROMOTE');
