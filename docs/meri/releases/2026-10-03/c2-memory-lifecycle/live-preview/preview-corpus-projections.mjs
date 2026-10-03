import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { aws, ctx, need } from '../meri-fresh-20261003/auth-preflight.mjs';
import { releaseOperator } from '../../meri-c1-20261002/scripts/meri-release.mjs';

const root='C:/dev/main/outputs/meri-c2-20261003';
const save=(name,value)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const sha=value=>createHash('sha256').update(value).digest('hex');
const build=JSON.parse(readFileSync(root+'/api-lifecycle-build/build-readback.json','utf8'));
need(build.status==='SUCCEEDED' && build.sourceSha==='f00e5dfb4fd3e47ac6aa4aca741023cc02f6314f','QUALIFIED_CANDIDATE_REQUIRED');
need(build.passedMarkers.includes('OFFLINE_PACKAGED_C2_TERMINAL_LIFECYCLE_PASS'),'PACKAGED_RECONCILIATION_UNVERIFIED');
const baseline=JSON.parse(readFileSync(root+'/served-baseline.json','utf8')).identities.find(i=>i.service==='api');
const snapshot=await releaseOperator({aws}).snapshot('api');
assert.deepEqual(snapshot.baseline,baseline.baseline,'API baseline drift');
const api=snapshot.task.containerDefinitions.find(c=>c.name==='api');
const env=Object.fromEntries(api.environment.map(e=>[e.name,e.value]));
for(const k of ['MEMORY_CLIENT_REVIEW','MEMORY_GOVERNANCE_LIFECYCLE','MEMORY_GOVERNANCE_CENTER','MEMORY_GOVERNANCE_ENFORCE']) need(env[k]==='enforce','GOVERNANCE_FLAG_DRIFT');
need(env.MERI_SYNTHETIC_FIXTURE_NAMESPACE==='meri-foundation-20260928','NAMESPACE_DRIFT');
const details=aws(['ecr','describe-images','--repository-name','capiro/dev/api','--image-ids','imageTag='+build.sourceSha]).imageDetails;
need(details.length===1 && build.image.endsWith('@'+details[0].imageDigest),'CANDIDATE_DRIFT');
const svc=snapshot.service;
const definition=Object.fromEntries(['taskRoleArn','executionRoleArn','networkMode','requiresCompatibilities','cpu','memory','runtimePlatform'].map(k=>[k,snapshot.task[k]]));
definition.family='capiro-dev-meri-c2-projections-20261003';
const keys=['DB_NAME','AWS_REGION_DEFAULT','MEMORY_CLIENT_REVIEW','MEMORY_GOVERNANCE_LIFECYCLE','MEMORY_GOVERNANCE_CENTER','MEMORY_GOVERNANCE_ENFORCE','MERI_SYNTHETIC_FIXTURE_NAMESPACE'];
const environment=keys.filter(k=>env[k]!==undefined).map(name=>({name,value:env[name]}));
environment.push({name:'TMPDIR',value:'/dev/shm'},{name:'GIT_SHA',value:build.sourceSha},{name:'RELEASE_SHA',value:build.sourceSha},
  {name:'MEMORY_GOVERNANCE_TENANTS',value:ctx.tenantId+',52e91176-08f0-4d89-9633-bc212f5bdbbf'});
const secrets=api.secrets.filter(s=>['DB_HOST','DB_PORT','DB_USER','DB_PASSWORD'].includes(s.name));
need(secrets.length===4,'DATABASE_REFS_MISSING');
const wrapper=readFileSync(root+'/projection-preview-with-schema.mjs','utf8');
definition.containerDefinitions=[{name:'meri-c2-projections',image:build.image,essential:true,environment,secrets,
  entryPoint:['/usr/bin/dumb-init','--','node','--input-type=module','-e'],command:[wrapper],
  logConfiguration:{...api.logConfiguration,options:{...api.logConfiguration.options,'awslogs-stream-prefix':'meri-c2-projections'}},
  dockerLabels:{'org.opencontainers.image.revision':build.sourceSha}}];
save('projection-preview-definition-input.json',definition);
const input={target:'capiro-dev',fixtureNamespace:'meri-foundation-20260928',confirmation:'PREVIEW_EXACT_OWNED_MEMORY_PROJECTIONS',ctx,clientId:'41f9ec63-3963-479f-b747-59a3767ef44b'};
save('projection-preview-input.json',input);
let taskDefinition,taskArn,task,dispatchAttempted=false;
try {
  taskDefinition=aws(['ecs','register-task-definition','--cli-input-json','file://'+root+'/projection-preview-definition-input.json']).taskDefinition.taskDefinitionArn;
  save('projection-preview-definition-binding.json',{at:new Date().toISOString(),taskDefinition,image:build.image,sourceSha:build.sourceSha,operation:'preview-corpus-projections'});
  const startedBy='meri-c2-preview-'+randomUUID().slice(0,19);
  const request={cluster:'capiro-dev',taskDefinition,launchType:'FARGATE',platformVersion:svc.platformVersion,networkConfiguration:svc.networkConfiguration,count:1,startedBy,clientToken:randomUUID(),
    overrides:{containerOverrides:[{name:'meri-c2-projections',environment:[{name:'MERI_SYNTHETIC_READ_BUDGET_INPUT',value:JSON.stringify(input)}]}]}};
  need(Buffer.byteLength(JSON.stringify(request.overrides))<=8192,'OVERRIDE_LIMIT');
  save('projection-preview-task-intent.json',request);
  save('projection-preview-durable-launch-intent.json',{at:new Date().toISOString(),status:'DISPATCH_ATTEMPT_AUTHORIZED',taskDefinition,startedBy,clientToken:request.clientToken,inputSha256:sha(JSON.stringify(input)),image:build.image,operation:'preview-corpus-projections',databaseCommit:false,noAutomaticRetry:true});
  dispatchAttempted=true;
  let started;
  try { started=aws(['ecs','run-task','--cli-input-json','file://'+root+'/projection-preview-task-intent.json']); }
  catch(error) {
    const found=aws(['ecs','list-tasks','--cluster','capiro-dev','--started-by',startedBy]).taskArns;
    need(found?.length===1,'DISPATCH_UNCERTAIN_RETAIN_INTENT');
    started={tasks:[{taskArn:found[0]}],failures:[]};
  }
  need(started.tasks?.length===1 && started.failures?.length===0,'PREVIEW_TASK_DISPATCH_UNCONFIRMED');
  taskArn=started.tasks[0].taskArn;
  save('projection-preview-task-start.json',{at:new Date().toISOString(),taskArn,taskDefinition});
  console.log(JSON.stringify({status:'PREVIEW_STARTED',taskArn,image:build.image,providerCalls:0}));
  const deadline=Date.now()+8*60*1000;
  do {
    await delay(5000);
    task=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',taskArn]).tasks[0];
    need(task.taskDefinitionArn===taskDefinition,'PREVIEW_TASK_DRIFT');
  } while(task.lastStatus!=='STOPPED' && Date.now()<deadline);
  need(task.lastStatus==='STOPPED','PREVIEW_TIMEOUT');
  const stream='meri-c2-projections/meri-c2-projections/'+taskArn.split('/').at(-1);
  let receipts=[],schemaReceipts=[],safeErrors=[],eventCount=0;
  for(let attempt=0;attempt<5;attempt++) {
    const log=aws(['logs','get-log-events','--log-group-name',api.logConfiguration.options['awslogs-group'],'--log-stream-name',stream,'--start-from-head']);
    const lines=log.events.flatMap(e=>e.message.split('\n'));eventCount=log.events.length;
    receipts=lines.filter(s=>s.startsWith('MERI_SYNTHETIC_MEMORY_CORPUS_RECEIPT ')).map(s=>JSON.parse(s.slice('MERI_SYNTHETIC_MEMORY_CORPUS_RECEIPT '.length)));
    schemaReceipts=lines.filter(s=>s.startsWith('C2_CURRENT_SCHEMA_RECEIPT ')).map(s=>JSON.parse(s.slice('C2_CURRENT_SCHEMA_RECEIPT '.length)));
    safeErrors=lines.filter(s=>/^meri_synthetic_read_budget_[a-z_]+$/.test(s));
    if(receipts.length || safeErrors.length) break;
    await delay(2000);
  }
  const result={at:new Date().toISOString(),taskArn,taskDefinition,image:build.image,sourceSha:build.sourceSha,
    observedDigest:task.containers[0].imageDigest,exitCode:task.containers[0].exitCode,stoppedAt:task.stoppedAt,receipts,schemaReceipts,safeErrors,eventCount,
    providerCalls:0,committedCorpusMutations:0,captureAuthority:false};
  save('projection-preview-result.json',result);
  need(build.image.endsWith('@'+result.observedDigest),'PREVIEW_IMAGE_UNVERIFIED');
  need(schemaReceipts.length===1 && schemaReceipts[0].status==='VERIFIED_READ_ONLY','CURRENT_SCHEMA_UNVERIFIED');
  need(result.exitCode===0 && receipts.length===1,'PREVIEW_RESULT_UNVERIFIED');
  const receipt=receipts[0];
  need(receipt.status==='PROJECTION_CLEANUP_PREVIEW_ROLLED_BACK' && receipt.proofIsTentative===true && receipt.auditId===null && receipt.captureAuthority===false && receipt.providerAuthority===false && receipt.conditionalVerification.proof.fixtureReady===true,'PREVIEW_PROOF_UNVERIFIED');
  console.log(JSON.stringify({status:receipt.status,planSha256:receipt.planSha256,jobs:receipt.plan.jobs,projectionCount:receipt.plan.projectionCount,requiresMetadataReconciliation:receipt.conditionalVerification.requiresMetadataReconciliation,fixtureReady:receipt.conditionalVerification.proof.fixtureReady,captureAuthority:false,providerCalls:0}));
} finally {
  if(taskArn && task?.lastStatus!=='STOPPED') {
    aws(['ecs','stop-task','--cluster','capiro-dev','--task',taskArn,'--reason','C2 bounded rollback-only projection preview cleanup']);
    for(let i=0;i<12;i++){await delay(5000);task=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',taskArn]).tasks[0];if(task.lastStatus==='STOPPED')break;}
  }
  if(taskDefinition) {
    const stopped=aws(['ecs','deregister-task-definition','--task-definition',taskDefinition]);
    save('projection-preview-cleanup.json',{at:new Date().toISOString(),taskArn:taskArn??null,dispatchAttempted,taskStopped:task?.lastStatus==='STOPPED',taskDefinition,status:stopped.taskDefinition.status});
  }
}
