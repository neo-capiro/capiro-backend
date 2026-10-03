import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws,ctx} from '../meri-fresh-20261003/auth-preflight.mjs';
import {awsSingleAttempt} from './aws-single-attempt.mjs';
import {verifyMemoryWriters} from './check-memory-writers.mjs';
import {fingerprint} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const read=name=>JSON.parse(readFileSync(root+'/'+name,'utf8'));
const save=(name,value)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const sha=value=>createHash('sha256').update(value).digest('hex');
const packet=read('memory-lifecycle-release-packet.json'),approval=read('memory-lifecycle-human-approval.json');
assert.equal(approval.status,'APPROVED');assert.equal(approval.scope,'EXACT_C2_MEMORY_RELEASE_AND_BOUNDED_MAINTENANCE');
assert.equal(approval.packetSha256,fingerprint(packet));assert.ok(Date.parse(packet.expiresAt)>Date.now());
const build=read('api-lifecycle-build/build-readback.json');assert.equal(build.status,'SUCCEEDED');
assert.deepEqual(packet.services.find(s=>s.service==='api').candidate,{sourceSha:build.sourceSha,image:build.image});
const before=await verifyMemoryWriters();save('maintenance-writers-before-registration.json',before.proof);
const snapshot=before.apiSnapshot,api=snapshot.task.containerDefinitions.find(c=>c.name==='api');
assert.equal(api.image,build.image);
const env=Object.fromEntries(api.environment.map(e=>[e.name,e.value]));
for(const name of ['MEMORY_CLIENT_REVIEW','MEMORY_GOVERNANCE_LIFECYCLE','MEMORY_GOVERNANCE_CENTER','MEMORY_GOVERNANCE_ENFORCE'])assert.equal(env[name],'enforce');
assert.equal(env.MERI_SYNTHETIC_FIXTURE_NAMESPACE,'meri-foundation-20260928');
const priorWrapper=readFileSync(root+'/projection-preview-with-schema.mjs','utf8');
const cut=priorWrapper.indexOf('if(!process.exitCode) {');assert.ok(cut>0);
const body=readFileSync(root+'/maintenance-sequence-body.mjs','utf8'),wrapper=priorWrapper.slice(0,cut)+body;
const definition=Object.fromEntries(['taskRoleArn','executionRoleArn','networkMode','requiresCompatibilities','cpu','memory','runtimePlatform'].map(k=>[k,snapshot.task[k]]));
definition.family='capiro-dev-meri-c2-maintenance-20261003';
const environment=['DB_NAME','AWS_REGION_DEFAULT','MEMORY_CLIENT_REVIEW','MEMORY_GOVERNANCE_LIFECYCLE','MEMORY_GOVERNANCE_CENTER','MEMORY_GOVERNANCE_ENFORCE','MERI_SYNTHETIC_FIXTURE_NAMESPACE'].filter(k=>env[k]!==undefined).map(name=>({name,value:env[name]}));
environment.push({name:'TMPDIR',value:'/dev/shm'},{name:'GIT_SHA',value:build.sourceSha},{name:'RELEASE_SHA',value:build.sourceSha},
  {name:'MEMORY_GOVERNANCE_TENANTS',value:ctx.tenantId+',52e91176-08f0-4d89-9633-bc212f5bdbbf'});
const secrets=api.secrets.filter(s=>['DB_HOST','DB_PORT','DB_USER','DB_PASSWORD'].includes(s.name));assert.equal(secrets.length,4);
definition.containerDefinitions=[{name:'meri-c2-maintenance',image:build.image,essential:true,environment,secrets,
  entryPoint:['/usr/bin/dumb-init','--','node','--input-type=module','-e'],command:[wrapper],
  logConfiguration:{...api.logConfiguration,options:{...api.logConfiguration.options,'awslogs-stream-prefix':'meri-c2-maintenance'}},
  dockerLabels:{'org.opencontainers.image.revision':build.sourceSha}}];
const approved={packetSha256:fingerprint(packet),sourceSha:build.sourceSha,expiresAt:packet.expiresAt,
  originalCleanupJobs:packet.maintenance.originalCleanupJobs,
  input:{target:'capiro-dev',fixtureNamespace:'meri-foundation-20260928',ctx,clientId:'41f9ec63-3963-479f-b747-59a3767ef44b'}};
save('maintenance-definition-input.private.json',definition);save('maintenance-approved-input.json',approved);
save('maintenance-register-intent.json',{at:new Date().toISOString(),packetSha256:fingerprint(packet),sourceSha:build.sourceSha,image:build.image,
  definitionSha256:fingerprint(definition),wrapperSha256:sha(wrapper),bodySha256:sha(body),awsMaxAttempts:1,noAutomaticRetry:true});
let taskDefinition,taskArn,task,dispatchAttempted=false;
try {
  taskDefinition=awsSingleAttempt(['ecs','register-task-definition','--cli-input-json','file://'+root+'/maintenance-definition-input.private.json']).taskDefinition.taskDefinitionArn;
  save('maintenance-definition-binding.json',{at:new Date().toISOString(),taskDefinition,image:build.image,sourceSha:build.sourceSha,wrapperSha256:sha(wrapper)});
  const fresh=await verifyMemoryWriters();save('maintenance-writers-before-dispatch.json',fresh.proof);
  assert.equal(fresh.apiSnapshot.baseline.taskDefinitionArn,snapshot.baseline.taskDefinitionArn);
  const startedBy='c2-maint-'+randomUUID().slice(0,20);
  const request={cluster:'capiro-dev',taskDefinition,launchType:'FARGATE',platformVersion:snapshot.service.platformVersion,networkConfiguration:snapshot.service.networkConfiguration,
    count:1,startedBy,clientToken:randomUUID(),overrides:{containerOverrides:[{name:'meri-c2-maintenance',environment:[{name:'MERI_C2_APPROVED_MAINTENANCE',value:JSON.stringify(approved)}]}]}};
  assert.ok(Buffer.byteLength(JSON.stringify(request.overrides))<=8192);assert.ok(Date.parse(packet.expiresAt)>Date.now());
  save('maintenance-task-intent.private.json',request);
  save('maintenance-durable-dispatch-intent.json',{at:new Date().toISOString(),status:'SINGLE_DISPATCH_AUTHORIZED',packetSha256:fingerprint(packet),taskDefinition,startedBy,clientToken:request.clientToken,
    inputSha256:fingerprint(approved),image:build.image,operations:['preview-corpus-projections','execute-corpus-projections','preview-corpus-metadata','execute-corpus-metadata','read-corpus'],
    awsMaxAttempts:1,noAutomaticRetry:true,providerCalls:0});
  dispatchAttempted=true;let result;
  try {result=awsSingleAttempt(['ecs','run-task','--cli-input-json','file://'+root+'/maintenance-task-intent.private.json']);}
  catch {
    const refs=[...new Set(['RUNNING','STOPPED'].flatMap(status=>aws(['ecs','list-tasks','--cluster','capiro-dev','--family',definition.family,'--desired-status',status]).taskArns))];
    const found=[];
    for(let i=0;i<refs.length;i+=100){const chunk=refs.slice(i,i+100),r=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...chunk]);assert.equal(r.failures?.length??0,0);assert.deepEqual(r.tasks.map(t=>t.taskArn).sort(),[...chunk].sort());found.push(...r.tasks.filter(t=>t.startedBy===startedBy&&t.taskDefinitionArn===taskDefinition));}
    assert.equal(found.length,1,'Dispatch outcome uncertain; retain intent and do not repeat');result={tasks:found,failures:[]};
  }
  assert.equal(result.failures?.length??0,0);assert.equal(result.tasks?.length,1);taskArn=result.tasks[0].taskArn;
  save('maintenance-task-start.json',{at:new Date().toISOString(),taskArn,taskDefinition});
  console.log(JSON.stringify({status:'APPROVED_MAINTENANCE_STARTED',taskArn,image:build.image,providerCalls:0}));
  const deadline=Date.now()+10*60000;
  do {await delay(5000);const r=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',taskArn]);assert.equal(r.failures?.length??0,0);assert.equal(r.tasks.length,1);task=r.tasks[0];assert.equal(task.taskDefinitionArn,taskDefinition);}while(task.lastStatus!=='STOPPED'&&Date.now()<deadline);
  assert.equal(task.lastStatus,'STOPPED','Maintenance task timeout; reconcile outcome');
  const stream='meri-c2-maintenance/meri-c2-maintenance/'+taskArn.split('/').at(-1);
  let receipts=[],sequences=[],schemas=[],ownerOutputs=[],safeErrors=[],eventCount=0;
  for(let attempt=0;attempt<5;attempt++) {
    const log=aws(['logs','get-log-events','--log-group-name',api.logConfiguration.options['awslogs-group'],'--log-stream-name',stream,'--start-from-head']);
    const lines=log.events.flatMap(e=>e.message.split('\n'));eventCount=log.events.length;
    const pick=prefix=>lines.filter(s=>s.startsWith(prefix)).map(s=>JSON.parse(s.slice(prefix.length)));
    receipts=pick('MERI_SYNTHETIC_MEMORY_CORPUS_RECEIPT ');sequences=pick('C2_MAINTENANCE_SEQUENCE_RECEIPT ');schemas=pick('C2_CURRENT_SCHEMA_RECEIPT ');ownerOutputs=pick('C2_MAINTENANCE_OWNER_OUTPUT ');
    safeErrors=lines.filter(s=>/^meri_synthetic_read_budget_[a-z_]+$/.test(s));
    if(sequences.length)break;await delay(2000);
  }
  const outcome={at:new Date().toISOString(),taskArn,taskDefinition,image:build.image,sourceSha:build.sourceSha,
    observedDigest:task.containers[0].imageDigest,exitCode:task.containers[0].exitCode,stoppedAt:task.stoppedAt,receipts,sequences,schemaReceipts:schemas,ownerOutputs,safeErrors,eventCount,
    providerCalls:0,captureAuthority:false,liveAcceptance:'NOT_RUN',noAutomaticRetry:true};
  save('maintenance-result.json',outcome);
  assert.ok(build.image.endsWith('@'+outcome.observedDigest));assert.equal(outcome.exitCode,0,'Inspect committed/unknown outcomes; do not repeat');
  assert.equal(schemas.length,1);assert.equal(schemas[0].status,'VERIFIED_READ_ONLY');assert.equal(receipts.length,5);assert.equal(sequences.length,1);
  assert.deepEqual(ownerOutputs.map(o=>o.command),['preview-corpus-projections','execute-corpus-projections','preview-corpus-metadata','execute-corpus-metadata','read-corpus']);
  assert.ok(ownerOutputs.every(o=>o.status==='CAPTURED'));
  assert.equal(sequences[0].status,'COMMITTED_MAINTENANCE_AND_CURRENT_CORPUS_VERIFIED');assert.equal(sequences[0].packetSha256,fingerprint(packet));
  console.log(JSON.stringify(sequences[0],null,2));
} finally {
  if(taskArn&&task?.lastStatus!=='STOPPED') {
    awsSingleAttempt(['ecs','stop-task','--cluster','capiro-dev','--task',taskArn,'--reason','C2 exact approved maintenance owner cleanup; outcome must be reconciled before retry']);
    for(let i=0;i<12;i++){await delay(5000);task=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',taskArn]).tasks[0];if(task.lastStatus==='STOPPED')break;}
  }
  if(taskDefinition) {
    const closed=awsSingleAttempt(['ecs','deregister-task-definition','--task-definition',taskDefinition]);
    save('maintenance-task-cleanup.json',{at:new Date().toISOString(),taskArn:taskArn??null,dispatchAttempted,taskStopped:task?.lastStatus==='STOPPED',taskDefinition,status:closed.taskDefinition.status});
  }
}
