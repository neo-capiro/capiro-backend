// Prepared one-shot dispatcher. Requires the new release's actual approval and healthy receipts.
import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync,mkdirSync,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {awsSingleAttempt} from './aws-single-attempt.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';

const [mode]=process.argv.slice(2);assert.ok(['plan','execute'].includes(mode));assert.equal(process.argv.length,3);
const parent='C:/dev/main/outputs/meri-c2-20261003',packageRoot=parent+'/case01-native-setup-v1';
const root=parent+'/case01-native-setup-'+mode+'-v1';
assert.equal(existsSync(root),false,'Prior dispatcher intent requires reconciliation, not automatic retry');
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const save=(name,v)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,JSON.stringify(v,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const packet=read(parent+'/clock-provider-release-packet.json');
const approval=read(parent+'/clock-provider-human-approval.json');
assert.equal(approval.status,'APPROVED');assert.equal(approval.scope,'EXACT_C2_CLOCK_PROVIDER_RELEASE');
assert.equal(approval.packetSha256,fingerprint(packet));
const source='5b086a6b47ffce5aa1b93bfe38f9c7b96e297642';
const image='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:d20110a114ef51a7db3d352321f411a2f51cc8b1877f9ccec6d1f35d7701c8cd';
const body=readFileSync(packageRoot+'/case01-native-setup-inner.mjs');
const rates=readFileSync(packageRoot+'/case01-reviewed-rates-v2.json');
assert.equal(hash(body),'632d00e47ec63fb8c0b49cfa0d166760bd16abbf5ded9b572c0a9cf235f9899d');
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
  const prior=read(parent+'/case01-native-setup-plan-v1/result.json');
  assert.equal(prior.exitCode,0);assert.equal(prior.status,'PLAN_ONLY');
  assert.equal(prior.sourceSha,source);assert.equal(prior.image,image);assert.equal(prior.scriptSha256,hash(body));
  const final=prior.events.filter(e=>e.phase==='RESULT');assert.equal(final.length,1);assert.equal(final[0].status,'PLAN_ONLY');
  assert.equal(final[0].plan.sourceSha,source);assert.equal(final[0].plan.request.captureRunId,'bd35c0f4-1604-4371-b7e9-a1338369e53f');
  input={confirmation:'BIND_EXISTING_CASE01_AND_INSTALL_BOUNDED_BUDGET_ONCE',expectedSourceSha:source,plan:final[0].plan,planSha256:final[0].planSha256};
}
const stagedScript='/dev/shm/case01-native-setup-inner.mjs',receiptPath='/dev/shm/case01-native-setup-'+mode+'-01.jsonl';
const wrapper=`import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(stagedScript)},Buffer.from(${JSON.stringify(body.toString('base64'))},'base64'),{flag:'wx'});\nwriteFileSync('/dev/shm/case01-reviewed-rates-v2.json',Buffer.from(${JSON.stringify(rates.toString('base64'))},'base64'),{flag:'wx'});\nprocess.env.MERI_C2_CASE01_SETUP_INPUT=Buffer.from(${JSON.stringify(Buffer.from(JSON.stringify(input)).toString('base64'))},'base64').toString('utf8');\nprocess.argv=[process.execPath,${JSON.stringify(stagedScript)},${JSON.stringify(mode)},'--out',${JSON.stringify(receiptPath)}];\nawait import('file://'+${JSON.stringify(stagedScript)});\n`;
const templateBytes=readFileSync(parent+'/corpus-read-definition-input.json');
assert.equal(hash(templateBytes),'6c0a447dc99ed35642df735c38d09e02b12b33983fe461b707cd0c06a8a44478','Reviewed task template drift');
const definition=JSON.parse(templateBytes);
assert.equal(definition.containerDefinitions.length,1);
const c=definition.containerDefinitions[0];
assert.deepEqual(c.secrets.map(s=>s.name).sort(),['DB_HOST','DB_PASSWORD','DB_PORT','DB_USER']);
definition.family='capiro-dev-meri-c2-case01-setup-20261003';c.image=image;
for(const e of c.environment)if(['GIT_SHA','RELEASE_SHA'].includes(e.name))e.value=source;
assert.equal(c.environment.find(e=>e.name==='MERI_SYNTHETIC_FIXTURE_NAMESPACE')?.value,'meri-foundation-20260928');
c.entryPoint=['/usr/bin/dumb-init','--','node','--input-type=module','-e'];c.command=[wrapper];
mkdirSync(root);
save('intent.json',{at:new Date().toISOString(),mode,sourceSha:source,image,scriptSha256:hash(body),wrapperSha256:hash(wrapper),rateSha256:hash(rates),input,served,releasePacketSha256:fingerprint(packet),providerSecrets:0,providerCalls:0,fixtureLifecycleMutations:0,proposedWrites:mode==='plan'?[]:['canonical capture binding CAS','bounded provider budget qualification CAS'],automaticRetry:false});
save('definition-input.private.json',definition);
let td,arn,task;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  td=awsSingleAttempt(['ecs','register-task-definition','--cli-input-json','file://'+root+'/definition-input.private.json']).taskDefinition.taskDefinitionArn;
  save('definition-registered.json',{at:new Date().toISOString(),taskDefinition:td});
  const registered=aws(['ecs','describe-task-definition','--task-definition',td,'--include','TAGS']);
  assert.equal(registered.taskDefinition.status,'ACTIVE');
  const registeredHash=fingerprint(taskInput({...registered.taskDefinition,tags:registered.tags}));
  assert.equal(registeredHash,fingerprint(taskInput(definition)),'Registered task input drift');
  save('definition-readback.json',{at:new Date().toISOString(),taskDefinition:td,taskInputSha256:registeredHash,templateBytesSha256:hash(templateBytes)});
  const request={cluster:'capiro-dev',taskDefinition:td,launchType:'FARGATE',count:1,networkConfiguration:api.service.networkConfiguration,platformVersion:api.service.platformVersion,startedBy:'meri-c2-c01-'+mode+'-'+randomUUID().slice(0,8),clientToken:randomUUID()};
  save('task-input.private.json',request);
  const start=awsSingleAttempt(['ecs','run-task','--cli-input-json','file://'+root+'/task-input.private.json']);
  assert.equal(start.failures?.length,0);assert.equal(start.tasks?.length,1);arn=start.tasks[0].taskArn;
  save('task-start.json',{at:new Date().toISOString(),taskArn:arn,taskDefinition:td,scriptSha256:hash(body)});
  console.log(JSON.stringify({stage:'C2_CASE01_NATIVE_SETUP',mode,status:'TASK_STARTED',taskArn:arn,providerCalls:0}));
  const deadline=Date.now()+8*60000;
  do {await delay(5000);task=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',arn]).tasks[0];assert.equal(task.taskDefinitionArn,td);}while(task.lastStatus!=='STOPPED'&&Date.now()<deadline);
  assert.equal(task.lastStatus,'STOPPED');assert.equal(task.containers.length,1);assert.equal(task.containers[0].image,image);assert.equal(task.containers[0].imageDigest,image.split('@')[1]);
  let token,pages=0,raw=[];
  while(pages++<10){
    const args=['logs','get-log-events','--log-group-name',c.logConfiguration.options['awslogs-group'],'--log-stream-name',c.logConfiguration.options['awslogs-stream-prefix']+'/'+c.name+'/'+arn.split('/').at(-1),'--start-from-head','--limit','10000'];
    if(token)args.push('--next-token',token);
    const page=aws(args);raw.push(...page.events);if(page.nextForwardToken===token)break;token=page.nextForwardToken;
  }
  assert.ok(pages<10);
  const lines=raw.flatMap(e=>e.message.split('\n'));
  const events=lines.filter(s=>s.startsWith('C2_CASE01_NATIVE_SETUP ')).map(s=>JSON.parse(s.slice('C2_CASE01_NATIVE_SETUP '.length)));
  const failures=lines.filter(s=>s.startsWith('C2_CASE01_NATIVE_SETUP_FAILURE ')).map(s=>JSON.parse(s.slice('C2_CASE01_NATIVE_SETUP_FAILURE '.length)));
  const finals=events.filter(e=>e.phase==='RESULT');
  const result={at:new Date().toISOString(),mode,sourceSha:source,image,taskArn:arn,taskDefinition:td,exitCode:task.containers[0].exitCode,scriptSha256:hash(body),events,failures,status:finals.length===1?finals[0].status:'BLOCKED_OR_UNCERTAIN',rawLogSha256:hash(raw.map(e=>e.message).join('')),providerCalls:0};
  save('result.json',result);
  assert.equal(task.containers[0].exitCode,0);assert.equal(failures.length,0);assert.equal(finals.length,1);
  assert.ok(events.every((e,i)=>e.sequence===i+1));
  assert.equal(finals[0].status,mode==='plan'?'PLAN_ONLY':'BOUND_AND_BUDGET_READ_BACK');
  console.log(JSON.stringify({status:result.status,resultPath:root+'/result.json',events:events.length,providerCalls:0}));
}catch(error){
  save('failure.json',{at:new Date().toISOString(),taskArn:arn??null,taskDefinition:td??null,status:'BLOCKED_OR_UNCERTAIN_RECONCILE_BEFORE_ANOTHER_ACTION',errorClass:error?.name??'Error',automaticRetryAllowed:false});
  throw error;
}finally{
  if(arn&&task?.lastStatus!=='STOPPED'){
    awsSingleAttempt(['ecs','stop-task','--cluster','capiro-dev','--task',arn,'--reason','C2 bounded canonical setup task cleanup']);
    for(let i=0;i<12;i++){await delay(5000);task=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',arn]).tasks[0];if(task.lastStatus==='STOPPED')break;}
  }
  if(td){const done=awsSingleAttempt(['ecs','deregister-task-definition','--task-definition',td]);save('cleanup.json',{at:new Date().toISOString(),taskArn:arn??null,taskStopped:task?.lastStatus==='STOPPED',taskDefinition:td,status:done.taskDefinition.status});}
}
