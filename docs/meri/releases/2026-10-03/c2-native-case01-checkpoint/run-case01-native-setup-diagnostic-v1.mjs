// Prepared one-shot dispatcher. Requires the new release's actual approval and healthy receipts.
import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync,mkdirSync,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {awsSingleAttempt} from './aws-single-attempt.mjs';
import {withExplicitEcsDefaults,normalizeTaskEnvironment} from './case01-native-setup-v4-definition.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';

const [mode]=process.argv.slice(2);assert.equal(mode,'plan','DIAGNOSTIC_PLAN_ONLY');assert.equal(process.argv.length,3);
const parent='C:/dev/main/outputs/meri-c2-20261003',packageRoot=parent+'/case01-native-setup-diagnostic-v1';
const root=parent+'/case01-native-setup-diagnostic-result-v1';
assert.equal(existsSync(root),false,'Prior dispatcher intent requires reconciliation, not automatic retry');
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(hash(readFileSync(new URL('./case01-native-setup-v4-definition.mjs',import.meta.url))),'5e27f5e689f84fe4b4c6e96b2464f0c4f331d6ac0711fd7c432b89004174e1d8','Reviewed task normalization drift');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const save=(name,v)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,JSON.stringify(v,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const saveBytes=(name,bytes)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}};
// This new exclusive plan is permitted only after the retained pre-dispatch failure was reconciled.
const reconciliationBytes=readFileSync(parent+'/case01-native-setup-plan-v1-reconciliation.json');
const reconciliationSha256=hash(reconciliationBytes);
assert.equal(reconciliationSha256,'b59923080aace193f676921ff8a449ff62b7e527fda80135ec2080255727e232');
const reconciliation=JSON.parse(reconciliationBytes);
assert.equal(reconciliation.status,'RECONCILED_PRE_RUN_TASK_FAILURE');
assert.equal(reconciliation.definitionStatus,'INACTIVE');
assert.equal(hash(readFileSync(parent+'/case01-native-setup-plan-v1/result.json')),reconciliation.priorResultSha256);
assert.equal(hash(readFileSync(parent+'/run-case01-native-setup-v3.mjs')),reconciliation.priorDispatcherSha256);
assert.equal(existsSync(parent+'/case01-native-setup-plan-v1/task-input.private.json'),false);
const priorFailureBytes=readFileSync(parent+'/case01-native-setup-plan-v2/result.json');
assert.equal(hash(priorFailureBytes),'bc293a00ec0473c0bde4977f4b42209f4486119d3801929183d477fb6626f514');
const priorFailure=JSON.parse(priorFailureBytes);
assert.equal(priorFailure.mode,'plan');
assert.equal(priorFailure.exitCode,1);
assert.equal(priorFailure.cleanup.taskStopped,true);
assert.equal(priorFailure.cleanup.taskDefinitionInactive,true);
assert.deepEqual(priorFailure.events.map(e=>[e.stage,e.phase]),[['VALIDATING','START'],['INSPECT','FAILURE']]);
const packet=read(parent+'/clock-provider-release-packet.json');
const approval=read(parent+'/clock-provider-human-approval.json');
assert.equal(approval.status,'APPROVED');assert.equal(approval.scope,'EXACT_C2_CLOCK_PROVIDER_RELEASE');
assert.equal(approval.packetSha256,fingerprint(packet));
const source='5b086a6b47ffce5aa1b93bfe38f9c7b96e297642';
const image='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:d20110a114ef51a7db3d352321f411a2f51cc8b1877f9ccec6d1f35d7701c8cd';
const body=readFileSync(packageRoot+'/case01-native-setup-inner.mjs');
const rates=readFileSync(packageRoot+'/case01-reviewed-rates-v2.json');
assert.equal(hash(body),'2479168248b3f108e012730da1fc1c11f0ba2f87dae707b837eeb282a855f488');
assert.equal(hash(rates),'3531e09dfcce9f66b4ea2b3564db47bd72dc507cdcf1aecdda277b838007704e');
assert.ok(Date.parse(JSON.parse(rates).expiresAt)>Date.now()+30*60000);
assert.equal(aws(['sts','get-caller-identity']).Arn,'arn:aws:iam::967807252336:user/capirocli');
const operator=releaseOperator({aws}),served=[];let api;
for(const service of ['api','meriv2-orchestrator']){
  const target=packet.services.find(s=>s.service===service),receipt=read(parent+'/'+service+'-clock-provider-promotion-receipt.json');
  assert.equal(receipt.status,'ecs-healthy-manual-acceptance-required');assert.equal(receipt.candidateImage,target.candidate.image);
  const live=await operator.snapshot(service);
  assert.equal(live.baseline.taskDefinitionArn,receipt.candidateTaskDefinition);
  assert.equal(live.baseline.taskHash,receipt.candidateTaskHash);
  assert.equal(live.baseline.configHash,receipt.configHash);
  assert.equal(live.baseline.imageDigest,target.candidate.image.split('@')[1]);
  const c=live.task.containerDefinitions.find(c=>c.name===service),env=new Map(c.environment.map(e=>[e.name,e.value]));
  assert.equal(env.get('RELEASE_SHA'),target.candidate.sourceSha);
  served.push({service,baseline:live.baseline,sourceSha:target.candidate.sourceSha});
  if(service==='api'){api=live;assert.equal(target.candidate.sourceSha,source);assert.equal(target.candidate.image,image);}
}
let input=read(packageRoot+'/plan-input.json');
if(mode==='execute'){
  const prior=read(parent+'/case01-native-setup-plan-v2/result.json');
  assert.equal(prior.exitCode,0);assert.equal(prior.status,'PLAN_ONLY');
  assert.equal(prior.sourceSha,source);assert.equal(prior.image,image);assert.equal(prior.scriptSha256,hash(body));
  const final=prior.events.filter(e=>e.phase==='RESULT');assert.equal(final.length,1);assert.equal(final[0].status,'PLAN_ONLY');
  assert.equal(final[0].plan.sourceSha,source);assert.equal(final[0].plan.request.captureRunId,'bd35c0f4-1604-4371-b7e9-a1338369e53f');
  input={confirmation:'BIND_EXISTING_CASE01_AND_INSTALL_BOUNDED_BUDGET_ONCE',expectedSourceSha:source,plan:final[0].plan,planSha256:final[0].planSha256};
}
const stagedScript='/dev/shm/case01-native-setup-inner.mjs',receiptPath='/dev/shm/case01-native-setup-'+mode+'-01.jsonl';
const wrapper=`import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const emit=async value=>new Promise((resolve,reject)=>process.stdout.write('C2_CASE01_NATIVE_SETUP_RECEIPT '+JSON.stringify(value)+'\\n',error=>error?reject(error):resolve()));
try {
  writeFileSync(${JSON.stringify(stagedScript)},Buffer.from(${JSON.stringify(body.toString('base64'))},'base64'),{flag:'wx'});
  writeFileSync('/dev/shm/case01-reviewed-rates-v2.json',Buffer.from(${JSON.stringify(rates.toString('base64'))},'base64'),{flag:'wx'});
  process.env.MERI_C2_CASE01_SETUP_INPUT=Buffer.from(${JSON.stringify(Buffer.from(JSON.stringify(input)).toString('base64'))},'base64').toString('utf8');
  process.argv=[process.execPath,${JSON.stringify(stagedScript)},${JSON.stringify(mode)},'--out',${JSON.stringify(receiptPath)}];
  await import('file://'+${JSON.stringify(stagedScript)});
} catch(error) {
  process.exitCode=1;
  await emit({phase:'WRAPPER_FAILURE',errorClass:error?.name??'Error'});
} finally {
  try {
    const bytes=readFileSync(${JSON.stringify(receiptPath)});
    if(bytes.length===0||bytes.length>1024*1024)throw new Error('RECEIPT_SIZE');
    const encoded=bytes.toString('base64'),chunks=Math.ceil(encoded.length/8192);
    const meta={version:1,kind:'case01-native-setup-jsonl',mode:${JSON.stringify(mode)},sourceSha:${JSON.stringify(source)},scriptSha256:${JSON.stringify(hash(body))},rateSha256:${JSON.stringify(hash(rates))},captureRunId:'bd35c0f4-1604-4371-b7e9-a1338369e53f',receiptPath:${JSON.stringify(receiptPath)},byteLength:bytes.length,base64Length:encoded.length,chunks,sha256:createHash('sha256').update(bytes).digest('hex'),innerExitCode:process.exitCode??0};
    await emit({phase:'BEGIN',...meta});
    for(let i=0;i<chunks;i++)await emit({phase:'CHUNK',sha256:meta.sha256,index:i+1,data:encoded.slice(i*8192,(i+1)*8192)});
    await emit({phase:'END',...meta});
  } catch(error) {
    process.exitCode=1;
    await emit({phase:'EMISSION_FAILURE',errorClass:error?.name??'Error'});
  }
}
`;
const templateBytes=readFileSync(parent+'/corpus-read-definition-input.json');
assert.equal(hash(templateBytes),'6c0a447dc99ed35642df735c38d09e02b12b33983fe461b707cd0c06a8a44478','Reviewed task template drift');
const definition=normalizeTaskEnvironment(withExplicitEcsDefaults(JSON.parse(templateBytes)));
assert.equal(definition.containerDefinitions.length,1);
const c=definition.containerDefinitions[0];
assert.deepEqual(c.secrets.map(s=>s.name).sort(),['DB_HOST','DB_PASSWORD','DB_PORT','DB_USER']);
definition.family='capiro-dev-meri-c2-case01-setup-20261003';c.image=image;
for(const e of c.environment)if(['GIT_SHA','RELEASE_SHA'].includes(e.name))e.value=source;
assert.equal(c.environment.find(e=>e.name==='MERI_SYNTHETIC_FIXTURE_NAMESPACE')?.value,'meri-foundation-20260928');
c.entryPoint=['/usr/bin/dumb-init','--','node','--input-type=module','-e'];c.command=[wrapper];
mkdirSync(root);
save('intent.json',{at:new Date().toISOString(),mode,sourceSha:source,image,reconciliationSha256,scriptSha256:hash(body),wrapperSha256:hash(wrapper),rateSha256:hash(rates),input,served,releasePacketSha256:fingerprint(packet),providerSecrets:0,providerCalls:0,fixtureLifecycleMutations:0,proposedWrites:mode==='plan'?[]:['canonical capture binding CAS','bounded provider budget qualification CAS'],automaticRetry:false});
save('definition-input.private.json',definition);
let td,arn,task,request,runDispatched=false,stopAttempted=false,deregisterAttempted=false;
let cleanupInactive=false,receiptFrame=null,receiptEvents=[],receiptFailures=[],receiptValid=false;
let evidencePersistenceFailed=false,observationNumber=0,taskReadNumber=0;
const observations=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const errorShape=error=>({errorClass:error?.name??'Error',code:/^[A-Z0-9_]+$/u.test(error?.code??'')?error.code:null});
function recordFailure(phase,error,fatal=true) {
  const value={at:new Date().toISOString(),phase,fatal,...errorShape(error),automaticRetryAllowed:false};
  observations.push(value);
  try {save(`observation-${String(++observationNumber).padStart(3,'0')}.json`,value);}
  catch {evidencePersistenceFailed=true;process.stderr.write('C2_CASE01_SETUP_EVIDENCE_PERSISTENCE_FAILED\n');}
}
function assertTaskIdentity(value) {
  assert.equal(value?.taskArn,arn);
  assert.equal(value.taskDefinitionArn,td);
  assert.equal(value.clusterArn,'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev');
  assert.equal(value.startedBy,request.startedBy);
}
function readTask() {
  const raw=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',arn]);
  save(`task-read-${String(++taskReadNumber).padStart(3,'0')}.json`,raw);
  assert.equal(raw.failures?.length??0,0);assert.equal(raw.tasks?.length,1);
  assertTaskIdentity(raw.tasks[0]);
  task=raw.tasks[0];
  return task;
}
async function pollStopped(milliseconds,phase) {
  const until=Date.now()+milliseconds;
  do {
    try {if(readTask().lastStatus==='STOPPED')return true;}
    catch(error){recordFailure(phase,error,error?.name==='AssertionError');}
    if(Date.now()<until)await delay(5000);
  } while(Date.now()<until);
  return task?.lastStatus==='STOPPED';
}

// Pure assembly only. Raw pages have already been fsynced before entering here.
// A complete frame proves byte transport, not success of the canonical operation.
function assembleReceipt(rawEvents) {
  const prefix='C2_CASE01_NATIVE_SETUP_RECEIPT ';
  const lines=rawEvents.flatMap(event=>{
    assert.equal(typeof event.message,'string');return event.message.split('\n');
  }).filter(line=>line.startsWith(prefix));
  const records=lines.map(line=>JSON.parse(line.slice(prefix.length)));
  const failures=records.filter(row=>['WRAPPER_FAILURE','EMISSION_FAILURE'].includes(row.phase));
  const frames=records.filter(row=>!['WRAPPER_FAILURE','EMISSION_FAILURE'].includes(row.phase));
  if(!frames.some(row=>row.phase==='END'))return null;
  assert.equal(frames.filter(row=>row.phase==='BEGIN').length,1);
  assert.equal(frames.filter(row=>row.phase==='END').length,1);
  const {phase:firstPhase,...meta}=frames[0];
  const {phase:lastPhase,...end}=frames.at(-1);
  assert.equal(firstPhase,'BEGIN');assert.equal(lastPhase,'END');assert.deepEqual(meta,end);
  assert.deepEqual(Object.keys(meta).sort(),['base64Length','byteLength','captureRunId','chunks','innerExitCode','kind','mode','rateSha256','receiptPath','scriptSha256','sha256','sourceSha','version']);
  assert.equal(meta.version,1);assert.equal(meta.kind,'case01-native-setup-jsonl');
  assert.equal(meta.mode,mode);assert.equal(meta.sourceSha,source);
  assert.equal(meta.scriptSha256,hash(body));assert.equal(meta.rateSha256,hash(rates));
  assert.equal(meta.captureRunId,'bd35c0f4-1604-4371-b7e9-a1338369e53f');
  assert.equal(meta.receiptPath,receiptPath);assert.match(meta.sha256,/^[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(meta.byteLength)&&meta.byteLength>0&&meta.byteLength<=1024*1024);
  assert.ok(Number.isSafeInteger(meta.innerExitCode)&&meta.innerExitCode>=0&&meta.innerExitCode<=255);
  assert.equal(meta.base64Length,4*Math.ceil(meta.byteLength/3));
  assert.equal(meta.chunks,Math.ceil(meta.base64Length/8192));
  assert.equal(frames.length,meta.chunks+2);
  const chunks=frames.slice(1,-1);
  for(const [index,part] of chunks.entries()) {
    assert.deepEqual(Object.keys(part).sort(),['data','index','phase','sha256']);
    assert.equal(part.phase,'CHUNK');assert.equal(part.sha256,meta.sha256);assert.equal(part.index,index+1);
    assert.equal(typeof part.data,'string');
    assert.equal(part.data.length,Math.min(8192,meta.base64Length-index*8192));
  }
  const encoded=chunks.map(row=>row.data).join(''),bytes=Buffer.from(encoded,'base64');
  assert.equal(bytes.toString('base64'),encoded);assert.equal(bytes.length,meta.byteLength);
  assert.equal(hash(bytes),meta.sha256);
  return {meta,bytes,failures};
}
async function collectLogs() {
  const stream=c.logConfiguration.options['awslogs-stream-prefix']+'/'+c.name+'/'+arn.split('/').at(-1);
  const started=Date.now(),deadline=started+180000,rawEvents=[];
  let token,attempt=0,totalBytes=0;
  while(Date.now()<deadline&&attempt<60) {
    const number=String(++attempt).padStart(3,'0');
    try {
      const args=['logs','get-log-events','--log-group-name',c.logConfiguration.options['awslogs-group'],
        '--log-stream-name',stream,'--start-from-head','--limit','10000'];
      if(token)args.push('--next-token',token);
      const page=aws(args);
      // Preserve the full returned page, including exact event message strings,
      // before assertions, extraction, token handling or JSONL parsing.
      try {save(`logs-page-${number}.json`,{at:new Date().toISOString(),inputToken:token??null,page});}
      catch(error){evidencePersistenceFailed=true;throw error;}
      assert.ok(Array.isArray(page.events));assert.equal(typeof page.nextForwardToken,'string');
      totalBytes+=Buffer.byteLength(JSON.stringify(page));assert.ok(totalBytes<=32*1024*1024);
      rawEvents.push(...page.events);
      const unchanged=page.nextForwardToken===token;token=page.nextForwardToken;
      try {
        const assembled=assembleReceipt(rawEvents);
        if(assembled) {
          // Persist complete bytes before parsing or claiming inner success.
          saveBytes('inner-receipt.jsonl',assembled.bytes);
          save('inner-receipt-transport.json',{...assembled.meta,wrapperFailures:assembled.failures,
            pagesRead:attempt,taskStopped:task?.lastStatus==='STOPPED',collectionStartedAt:new Date(started).toISOString()});
          save('raw-log-events.json',{events:rawEvents});
          return assembled;
        }
      } catch(error) {recordFailure('LOG_RECEIPT_MALFORMED',error,true);}
      // An unchanged forward token is a temporary empty tail, not completion.
      if(unchanged||page.events.length===0)await delay(5000);
    } catch(error) {
      recordFailure('LOG_READ_OR_PAGE_PERSISTENCE',error,error?.name==='AssertionError');
      if(totalBytes>32*1024*1024||evidencePersistenceFailed)break;
      await delay(5000);
    }
  }
  save('raw-log-events.json',{events:rawEvents});
  save('log-collection-exhausted.json',{at:new Date().toISOString(),attempts:attempt,
    milliseconds:Date.now()-started,totalBytes,terminalReceipt:false,taskStopped:task?.lastStatus==='STOPPED'});
  return null;
}

try {
  save('register-dispatch-intent.json',{at:new Date().toISOString(),definitionSha256:fingerprint(normalizeTaskEnvironment(taskInput(definition))),automaticRetry:false});
  let registration;
  try {registration=awsSingleAttempt(['ecs','register-task-definition','--cli-input-json','file://'+root+'/definition-input.private.json']);}
  catch(error){recordFailure('REGISTER_DISPATCH_OBSERVED_FAILURE',error,true);throw error;}
  td=registration.taskDefinition?.taskDefinitionArn;
  save('definition-register-response.json',registration);
  assert.match(td??'',/^arn:aws:ecs:us-east-1:967807252336:task-definition\/capiro-dev-meri-c2-case01-setup-20261003:\d+$/u);
  save('definition-registered.json',{at:new Date().toISOString(),taskDefinition:td});
  const registered=aws(['ecs','describe-task-definition','--task-definition',td,'--include','TAGS']);
  save('definition-readback.private.json',registered);
  assert.equal(registered.taskDefinition.status,'ACTIVE');
  const registeredHash=fingerprint(normalizeTaskEnvironment(taskInput({...registered.taskDefinition,tags:registered.tags})));
  assert.equal(registeredHash,fingerprint(normalizeTaskEnvironment(taskInput(definition))),'Registered task input drift');
  save('definition-readback.json',{at:new Date().toISOString(),taskDefinition:td,taskInputSha256:registeredHash,templateBytesSha256:hash(templateBytes)});
  request={cluster:'capiro-dev',taskDefinition:td,launchType:'FARGATE',count:1,
    networkConfiguration:api.service.networkConfiguration,platformVersion:api.service.platformVersion,
    startedBy:'meri-c2-c01-'+mode+'-'+randomUUID().slice(0,8),clientToken:randomUUID()};
  save('task-input.private.json',request);
  runDispatched=true;
  let start;
  try {start=awsSingleAttempt(['ecs','run-task','--cli-input-json','file://'+root+'/task-input.private.json']);}
  catch(error){recordFailure('RUN_TASK_DISPATCH_OBSERVED_FAILURE',error,true);throw error;}
  // Keep any returned task identity before assertions can abort polling.
  if(start.tasks?.length===1)arn=start.tasks[0].taskArn;
  save('task-start-response.json',start);
  if(arn){assertTaskIdentity(start.tasks[0]);task=start.tasks[0];}
  assert.equal(start.failures?.length,0);assert.equal(start.tasks?.length,1);
  assert.match(arn??'',/^arn:aws:ecs:us-east-1:967807252336:task\/capiro-dev\/[a-f0-9]{32}$/u);
  save('task-start.json',{at:new Date().toISOString(),taskArn:arn,taskDefinition:td,scriptSha256:hash(body)});
  console.log(JSON.stringify({stage:'C2_CASE01_NATIVE_SETUP',mode,status:'TASK_STARTED',taskArn:arn,providerCalls:0}));
  assert.equal(await pollStopped(8*60000,'TASK_POLL_READ'),true,'Task did not stop within original deadline');
} catch(error) {recordFailure('DISPATCH_OR_POLL',error,true);}

// A failed RunTask acknowledgement is never resubmitted. Only bounded read-only
// discovery of that exact persisted startedBy can recover an owned ARN for cleanup
// and evidence; the original dispatch failure remains fatal in the final record.
if(runDispatched&&!arn&&td&&request) {
  try {
    for(let attempt=1;attempt<=6&&!arn;attempt++) {
      const matches=[];
      for(const status of ['RUNNING','STOPPED']) {
        // ECS does not combine startedBy with other list filters. Read only the
        // dedicated family, then match the exact persisted nonce and definition.
        const page=aws(['ecs','list-tasks','--cluster','capiro-dev','--family',definition.family,'--desired-status',status,'--max-results','100']);
        save(`task-reconcile-${attempt}-${status}.json`,page);
        assert.ok(Array.isArray(page.taskArns));assert.ok(!page.nextToken);
        if(page.taskArns.length) {
          const described=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...page.taskArns]);
          save(`task-reconcile-${attempt}-${status}-described.json`,described);
          assert.equal(described.failures?.length??0,0);assert.ok(Array.isArray(described.tasks));
          matches.push(...described.tasks.filter(value=>value.startedBy===request.startedBy&&value.taskDefinitionArn===td));
        }
      }
      const unique=[...new Map(matches.map(value=>[value.taskArn,value])).values()];assert.ok(unique.length<=1,'Ambiguous task discovery');
      if(unique.length===1) {
        arn=unique[0].taskArn;assertTaskIdentity(unique[0]);task=unique[0];
        save('task-reconciled.json',{at:new Date().toISOString(),taskArn:arn,taskDefinition:td,
          originalDispatchFailureRetained:true,automaticRetryAllowed:false});
      } else if(attempt<6)await delay(5000);
    }
  } catch(error){recordFailure('READ_ONLY_TASK_RECONCILIATION',error,true);}
}

// Stop handling, log collection and deregistration are separate guarded phases:
// one phase's error cannot bypass evidence collection or mask an earlier failure.
if(arn) {
  try {
    let owned=false;
    try {readTask();owned=true;}
    catch(error){recordFailure('PRE_CLEANUP_TASK_READ',error,error?.name==='AssertionError');if(task){assertTaskIdentity(task);owned=true;}}
    assert.ok(owned,'Cannot stop or collect an unproved task identity');
    if(task.lastStatus!=='STOPPED') {
      save('stop-dispatch-intent.json',{at:new Date().toISOString(),taskArn:arn,attempt:1});
      stopAttempted=true;
      try {
        const stopped=awsSingleAttempt(['ecs','stop-task','--cluster','capiro-dev','--task',arn,'--reason','C2 bounded canonical setup task cleanup']);
        save('stop-dispatch-response.json',stopped);
      } catch(error){recordFailure('STOP_TASK_DISPATCH_OBSERVED_FAILURE',error,true);}
      await pollStopped(60000,'POST_STOP_TASK_READ');
    }
  } catch(error){recordFailure('STOP_HANDLING',error,true);}
  try {
    // A stop failure does not discard logs of an already committed inner stage.
    assert.ok(task);assertTaskIdentity(task);
    receiptFrame=await collectLogs();
  } catch(error){recordFailure('POST_STOP_LOG_COLLECTION',error,true);}
  try {readTask();}
  catch(error){recordFailure('POST_COLLECTION_TASK_READ',error,error?.name==='AssertionError');}
}
if(td) {
  try {
    assert.match(td,/^arn:aws:ecs:us-east-1:967807252336:task-definition\/capiro-dev-meri-c2-case01-setup-20261003:\d+$/u);
    save('deregister-dispatch-intent.json',{at:new Date().toISOString(),taskDefinition:td,attempt:1});
    deregisterAttempted=true;
    try {
      const done=awsSingleAttempt(['ecs','deregister-task-definition','--task-definition',td]);
      save('deregister-response.json',done);assert.equal(done.taskDefinition.status,'INACTIVE');
    } catch(error){recordFailure('DEREGISTER_DISPATCH_OBSERVED_FAILURE',error,true);}
    // Readback may reconcile eventual visibility but never retries the mutation.
    for(let attempt=1;attempt<=3&&!cleanupInactive;attempt++) {
      try {
        const readback=aws(['ecs','describe-task-definition','--task-definition',td]);
        save(`deregister-readback-${attempt}.json`,readback);
        assert.equal(readback.taskDefinition.taskDefinitionArn,td);
        assert.equal(readback.taskDefinition.status,'INACTIVE');cleanupInactive=true;
      } catch(error){recordFailure('DEREGISTER_READBACK',error,false);if(attempt<3)await delay(5000);}
    }
    assert.equal(cleanupInactive,true,'Task definition must be INACTIVE');
  } catch(error){recordFailure('DEREGISTER_CLEANUP',error,true);}
}

try {
  assert.ok(receiptFrame,'Complete receipt frame missing');
  assert.equal(receiptFrame.bytes.at(-1),10);
  const text=receiptFrame.bytes.toString('utf8');assert.ok(Buffer.from(text,'utf8').equals(receiptFrame.bytes));
  receiptEvents=text.trimEnd().split('\n').map(line=>JSON.parse(line));
  receiptFailures=receiptEvents.filter(event=>event.phase==='FAILURE');
  save('inner-receipt-events.json',{events:receiptEvents,failures:receiptFailures,wrapperFailures:receiptFrame.failures});
  assert.ok(task);assertTaskIdentity(task);assert.equal(task.lastStatus,'STOPPED');
  assert.equal(task.containers?.length,1);assert.equal(task.containers[0].name,c.name);
  assert.equal(task.containers[0].image,image);assert.equal(task.containers[0].imageDigest,image.split('@')[1]);
  assert.ok(receiptEvents.every((event,index)=>event.sequence===index+1));
  assert.equal(receiptFrame.failures.length,0);assert.equal(receiptFrame.meta.innerExitCode,0);
  assert.equal(task.containers[0].exitCode,0);assert.equal(receiptFailures.length,0);
  const expected=mode==='plan'?[['VALIDATING','START'],['COMPLETE','RESULT']]:[
    ['VALIDATING','START'],['BIND_DISPATCHING','INTENT'],['BOUND','VERIFIED'],
    ['BUDGET_INSTALL_DISPATCHING','INTENT'],['BUDGET_INSTALLED','VERIFIED'],['COMPLETE','RESULT']];
  assert.deepEqual(receiptEvents.map(event=>[event.stage,event.phase]),expected);
  assert.equal(receiptEvents[0].mode,mode);assert.equal(receiptEvents[0].sourceSha,source);
  assert.equal(receiptEvents[0].captureRunId,'bd35c0f4-1604-4371-b7e9-a1338369e53f');
  assert.equal(receiptEvents[0].rateBytesSha256,hash(rates));
  assert.equal(receiptEvents.at(-1).status,mode==='plan'?'PLAN_ONLY':'BOUND_AND_BUDGET_READ_BACK');
  assert.equal(receiptEvents.at(-1).liveAcceptance,'NOT_RUN');
  assert.equal(cleanupInactive,true);receiptValid=true;
} catch(error){recordFailure('FINAL_EVIDENCE_OR_CLEANUP_ASSERTION',error,true);}
let success=receiptValid&&!evidencePersistenceFailed&&!observations.some(value=>value.fatal);
const result={at:new Date().toISOString(),mode,sourceSha:source,image,taskArn:arn??null,
  taskDefinition:td??null,exitCode:task?.containers?.[0]?.exitCode??null,scriptSha256:hash(body),
  events:receiptEvents,failures:receiptFailures,observedFailures:observations,
  status:success?receiptEvents.at(-1).status:'BLOCKED_OR_UNCERTAIN_RECONCILE_BEFORE_ANOTHER_ACTION',
  innerObservedStatus:receiptEvents.at(-1)?.status??null,
  innerReceipt:receiptFrame?{path:root+'/inner-receipt.jsonl',sha256:receiptFrame.meta.sha256,bytes:receiptFrame.meta.byteLength}:null,
  cleanup:{taskStopped:task?.lastStatus==='STOPPED',stopAttempted,deregisterAttempted,taskDefinitionInactive:cleanupInactive},
  evidencePersistenceFailed,automaticRetryAllowed:false,providerCalls:0,liveAcceptance:'NOT_RUN'};
try {save('cleanup.json',result.cleanup);save('result.json',result);}
catch(error){success=false;result.status='BLOCKED_OR_UNCERTAIN_RECONCILE_BEFORE_ANOTHER_ACTION';process.stderr.write('C2_CASE01_SETUP_FINAL_PERSISTENCE_FAILED\n');process.exitCode=1;}
if(!success)process.exitCode=1;
console.log(JSON.stringify({status:result.status,resultPath:root+'/result.json',events:receiptEvents.length,
  taskStopped:result.cleanup.taskStopped,taskDefinitionInactive:cleanupInactive,providerCalls:0,automaticRetryAllowed:false}));
