import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {awsSingleAttempt} from './aws-single-attempt.mjs';

const parent='C:/dev/main/outputs/meri-c2-20261003',root=parent+'/capture-contract-schema-read-v2';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const save=(name,value)=>writeFileSync(root+'/'+name,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const svc=aws(['ecs','describe-services','--cluster','capiro-dev','--services','capiro-dev-api']).services[0];
assert.equal(svc.taskDefinition,'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:519');
assert.equal(svc.deployments.length,1);assert.equal(svc.deployments[0].rolloutState,'COMPLETED');
assert.equal(svc.runningCount,2);assert.equal(svc.pendingCount,0);
const body=readFileSync(parent+'/capture-contract-schema-inner-v1.mjs','utf8');
const definition=JSON.parse(readFileSync(parent+'/corpus-read-definition-input.json','utf8'));
assert.equal(definition.containerDefinitions.length,1);
assert.equal(hash(readFileSync(parent+'/corpus-read-definition-input.json')),'6c0a447dc99ed35642df735c38d09e02b12b33983fe461b707cd0c06a8a44478');
assert.equal(hash(body),'b099d0e139a9eac2a1fad0dcdf111eb8b4f9ac5dc2c4852234f45ad44dec9b18');
delete definition.taskRoleArn;
const c=definition.containerDefinitions[0];
assert.deepEqual(c.secrets.map(x=>x.name).sort(),['DB_HOST','DB_PASSWORD','DB_PORT','DB_USER']);
definition.family='capiro-dev-meri-c2-contract-schema-read-20261003';
c.image='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:d20110a114ef51a7db3d352321f411a2f51cc8b1877f9ccec6d1f35d7701c8cd';
for(const row of c.environment)if(['GIT_SHA','RELEASE_SHA'].includes(row.name))row.value='5b086a6b47ffce5aa1b93bfe38f9c7b96e297642';
c.entryPoint=['/usr/bin/dumb-init','--','node','--input-type=module','-e'];c.command=[body];
mkdirSync(root);
save('intent.json',{at:new Date().toISOString(),kind:'C2_CAPTURE_CONTRACT_SCHEMA_READ',serviceRevision:519,image:c.image,
  sourceSha:'5b086a6b47ffce5aa1b93bfe38f9c7b96e297642',scriptSha256:hash(body),providerSecrets:0,workloadTaskRole:null,
  businessWrites:0,cloudActions:'one bounded read task; stop and deregister owned definition'});
save('definition-input.private.json',definition);
let td,arn,task;
let registerAttempted=false,registerConfirmed=false,runAttempted=false,runConfirmed=false;
try {
  registerAttempted=true;
  const registered=awsSingleAttempt(['ecs','register-task-definition','--cli-input-json','file://'+root+'/definition-input.private.json']).taskDefinition;
  td=registered?.taskDefinitionArn;
  assert.match(td??'',/^arn:aws:ecs:us-east-1:967807252336:task-definition\/capiro-dev-meri-c2-contract-schema-read-20261003:[0-9]+$/);
  registerConfirmed=true;
  assert.ok(!registered.taskRoleArn);assert.equal(registered.executionRoleArn,definition.executionRoleArn);
  assert.equal(registered.containerDefinitions.length,1);
  assert.deepEqual(registered.containerDefinitions[0].secrets,c.secrets);
  const byUniqueName=rows=>{
    assert.ok(Array.isArray(rows));assert.equal(new Set(rows.map(row=>row.name)).size,rows.length);
    return [...rows].sort((a,b)=>a.name.localeCompare(b.name));
  };
  assert.deepEqual(byUniqueName(registered.containerDefinitions[0].environment),byUniqueName(c.environment));
  assert.deepEqual(registered.containerDefinitions[0].command,c.command);
  assert.deepEqual(registered.containerDefinitions[0].entryPoint,c.entryPoint);
  assert.equal(registered.containerDefinitions[0].image,c.image);
  save('definition-registered.json',{at:new Date().toISOString(),taskDefinition:td});
  const request={cluster:'capiro-dev',taskDefinition:td,launchType:'FARGATE',count:1,networkConfiguration:svc.networkConfiguration,
    platformVersion:svc.platformVersion,startedBy:'meri-c2-schema-'+randomUUID().slice(0,18),clientToken:randomUUID()};
  save('task-input.private.json',request);
  runAttempted=true;
  const start=awsSingleAttempt(['ecs','run-task','--cli-input-json','file://'+root+'/task-input.private.json']);
  if(start.tasks?.length===1&&typeof start.tasks[0]?.taskArn==='string')arn=start.tasks[0].taskArn;
  assert.equal(start.failures?.length,0);assert.equal(start.tasks?.length,1);
  assert.match(arn??'',/^arn:aws:ecs:us-east-1:967807252336:task\/capiro-dev\/[a-f0-9]+$/);
  assert.equal(start.tasks[0].taskDefinitionArn,td);
  runConfirmed=true;
  save('task-start.json',{at:new Date().toISOString(),taskArn:arn,taskDefinition:td,scriptSha256:hash(body)});
  console.log(JSON.stringify({stage:'C2_CAPTURE_CONTRACT_SCHEMA',status:'RECEIPT_READ_STARTED',taskArn:arn,providerCalls:0,fixtureMutations:0}));
  const deadline=Date.now()+8*60*1000;
  do {await delay(5000);task=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',arn]).tasks[0];
    assert.equal(task.taskDefinitionArn,td);
  } while(task.lastStatus!=='STOPPED'&&Date.now()<deadline);
  assert.equal(task.lastStatus,'STOPPED');
  assert.equal(task.containers.length,1);assert.equal(task.containers[0].image,c.image);
  assert.equal(task.containers[0].imageDigest,c.image.split('@')[1]);
  const events=[],pages=[];let nextToken,receipts=[];
  const logDeadline=Date.now()+180000;
  for(let round=0;round<24&&Date.now()<logDeadline;round++) {
    for(let page=0;page<20&&Date.now()<logDeadline;page++) {
      const args=['logs','get-log-events','--log-group-name',c.logConfiguration.options['awslogs-group'],
        '--log-stream-name',c.logConfiguration.options['awslogs-stream-prefix']+'/'+c.name+'/'+arn.split('/').at(-1),
        '--start-from-head','--no-paginate'];
      if(nextToken)args.push('--next-token',nextToken);
      let logs;
      try {logs=aws(args);} catch(error) {
        pages.push({round,page,status:'LOG_READ_UNAVAILABLE',errorClass:error?.name??'Error'});break;
      }
      assert.ok(Array.isArray(logs.events));assert.equal(typeof logs.nextForwardToken,'string');
      pages.push({round,page,status:'READ',events:logs.events.length,
        eventsSha256:hash(JSON.stringify(logs.events)),forwardUnchanged:logs.nextForwardToken===nextToken});
      events.push(...logs.events);assert.ok(events.length<=5000);
      const unchanged=logs.nextForwardToken===nextToken;nextToken=logs.nextForwardToken;
      if(unchanged)break;
    }
    receipts=events.flatMap(e=>e.message.split('\n')).filter(line=>line.startsWith('C2_CAPTURE_CONTRACT_SCHEMA ')).map(line=>JSON.parse(line.slice('C2_CAPTURE_CONTRACT_SCHEMA '.length)));
    if(receipts.some(e=>['VERIFIED_READ_ONLY','UNVERIFIED'].includes(e.status)))break;
    await delay(5000);
  }
  save('log-transport-pages.json',{at:new Date().toISOString(),pages,events:events.length});
  const result={at:new Date().toISOString(),taskArn:arn,taskDefinition:td,exitCode:task.containers[0].exitCode,image:c.image,
    scriptSha256:hash(body),receipts,providerCalls:0,fixtureMutations:0};
  save('result.json',result);
  assert.equal(task.containers[0].exitCode,0);
  assert.equal(receipts.length,1);assert.equal(receipts[0].status,'VERIFIED_READ_ONLY');
  save('schema-proof.json',receipts[0]);
  console.log(JSON.stringify({status:'SCHEMA_VERIFIED_READ_ONLY',ledgerRows:receipts[0].ledgerRows,providerCalls:0,fixtureMutations:0}));
} catch(error) {
  save('failure.json',{at:new Date().toISOString(),taskArn:arn??null,taskDefinition:td??null,status:'READ_NOT_QUALIFIED_RECONCILE_BEFORE_RETRY',registerAttempted,registerConfirmed,runAttempted,runConfirmed,errorClass:error?.name??'Error'});
  throw error;
} finally {
  const cleanupErrors=[];let definitionStatus=null;
  if(arn&&task?.lastStatus!=='STOPPED'){
    try {
      awsSingleAttempt(['ecs','stop-task','--cluster','capiro-dev','--task',arn,'--reason','C2 bounded capture-contract schema read cleanup']);
      for(let i=0;i<12;i++){await delay(5000);task=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',arn]).tasks[0];if(task.lastStatus==='STOPPED')break;}
    }catch(error){cleanupErrors.push({action:'STOP_TASK',errorClass:error?.name??'Error'});}
  }
  if(td){
    try {definitionStatus=awsSingleAttempt(['ecs','deregister-task-definition','--task-definition',td]).taskDefinition.status;}
    catch(error){cleanupErrors.push({action:'DEREGISTER_DEFINITION',errorClass:error?.name??'Error'});}
  }
  const mutationOutcomeKnown=(!registerAttempted||registerConfirmed)&&(!runAttempted||runConfirmed);
  const cleanupComplete=mutationOutcomeKnown&&(!arn||task?.lastStatus==='STOPPED')&&(!td||definitionStatus==='INACTIVE')&&cleanupErrors.length===0;
  save('cleanup.json',{at:new Date().toISOString(),taskArn:arn??null,taskStopped:task?.lastStatus==='STOPPED',
    taskDefinition:td??null,status:definitionStatus,cleanupErrors,cleanupComplete,registerAttempted,registerConfirmed,runAttempted,runConfirmed,mutationOutcome:mutationOutcomeKnown?'KNOWN':'UNCERTAIN_RECONCILE_NO_RETRY'});
  assert.ok(cleanupComplete,'READ_ONLY_TASK_CLEANUP_NOT_CONFIRMED');
}
