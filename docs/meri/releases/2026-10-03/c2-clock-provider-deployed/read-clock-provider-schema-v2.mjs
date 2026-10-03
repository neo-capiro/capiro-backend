import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {awsSingleAttempt} from './aws-single-attempt.mjs';

const parent='C:/dev/main/outputs/meri-c2-20261003',root=parent+'/clock-provider-current-schema-v2';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const save=(name,value)=>writeFileSync(root+'/'+name,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const svc=aws(['ecs','describe-services','--cluster','capiro-dev','--services','capiro-dev-api']).services[0];
assert.equal(svc.taskDefinition,'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:517');
assert.equal(svc.deployments.length,1);assert.equal(svc.deployments[0].rolloutState,'COMPLETED');
assert.equal(svc.runningCount,2);assert.equal(svc.pendingCount,0);
const body=readFileSync(parent+'/clock-provider-schema-inner.mjs','utf8');
const definition=JSON.parse(readFileSync(parent+'/corpus-read-definition-input.json','utf8'));
assert.equal(definition.containerDefinitions.length,1);
assert.equal(hash(readFileSync(parent+'/corpus-read-definition-input.json')),'6c0a447dc99ed35642df735c38d09e02b12b33983fe461b707cd0c06a8a44478');
assert.equal(hash(body),'466f94130c5b7396ed5c9e9c3474bca95c99881adeb1aad4f6fb2f6b9f0ce386');
const c=definition.containerDefinitions[0];
assert.deepEqual(c.secrets.map(x=>x.name).sort(),['DB_HOST','DB_PASSWORD','DB_PORT','DB_USER']);
definition.family='capiro-dev-meri-c2-schema-read-20261003';
c.image='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:1a4aef121151bb5da7f70417539ece2faff392842809e6b557370c2d6cf8a49d';
for(const row of c.environment)if(['GIT_SHA','RELEASE_SHA'].includes(row.name))row.value='f00e5dfb4fd3e47ac6aa4aca741023cc02f6314f';
c.entryPoint=['/usr/bin/dumb-init','--','node','--input-type=module','-e'];c.command=[body];
mkdirSync(root);
save('intent.json',{at:new Date().toISOString(),kind:'CURRENT_SCHEMA_READ_ONLY_NO_MIGRATION',serviceRevision:517,image:c.image,
  sourceSha:'f00e5dfb4fd3e47ac6aa4aca741023cc02f6314f',scriptSha256:hash(body),providerSecrets:0,
  businessWrites:0,cloudActions:'one bounded read task; stop and deregister owned definition'});
save('definition-input.private.json',definition);
let td,arn,task;
try {
  td=awsSingleAttempt(['ecs','register-task-definition','--cli-input-json','file://'+root+'/definition-input.private.json']).taskDefinition.taskDefinitionArn;
  save('definition-registered.json',{at:new Date().toISOString(),taskDefinition:td});
  const request={cluster:'capiro-dev',taskDefinition:td,launchType:'FARGATE',count:1,networkConfiguration:svc.networkConfiguration,
    platformVersion:svc.platformVersion,startedBy:'meri-c2-schema-'+randomUUID().slice(0,18),clientToken:randomUUID()};
  save('task-input.private.json',request);
  const start=awsSingleAttempt(['ecs','run-task','--cli-input-json','file://'+root+'/task-input.private.json']);
  assert.equal(start.failures?.length,0);assert.equal(start.tasks?.length,1);arn=start.tasks[0].taskArn;
  save('task-start.json',{at:new Date().toISOString(),taskArn:arn,taskDefinition:td,scriptSha256:hash(body)});
  console.log(JSON.stringify({stage:'C2_CLOCK_PROVIDER_SCHEMA',status:'SCHEMA_READ_STARTED',taskArn:arn,providerCalls:0,fixtureMutations:0}));
  const deadline=Date.now()+8*60*1000;
  do {await delay(5000);task=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',arn]).tasks[0];
    assert.equal(task.taskDefinitionArn,td);
  } while(task.lastStatus!=='STOPPED'&&Date.now()<deadline);
  assert.equal(task.lastStatus,'STOPPED');
  assert.equal(task.containers.length,1);assert.equal(task.containers[0].image,c.image);
  assert.equal(task.containers[0].imageDigest,c.image.split('@')[1]);
  const logs=aws(['logs','get-log-events','--log-group-name',c.logConfiguration.options['awslogs-group'],
    '--log-stream-name',c.logConfiguration.options['awslogs-stream-prefix']+'/'+c.name+'/'+arn.split('/').at(-1),'--start-from-head']);
  const receipts=logs.events.flatMap(e=>e.message.split('\n')).filter(line=>line.startsWith('C2_CLOCK_PROVIDER_SCHEMA ')).map(line=>JSON.parse(line.slice('C2_CLOCK_PROVIDER_SCHEMA '.length)));
  const result={at:new Date().toISOString(),taskArn:arn,taskDefinition:td,exitCode:task.containers[0].exitCode,image:c.image,
    scriptSha256:hash(body),receipts,providerCalls:0,fixtureMutations:0};
  save('result.json',result);
  assert.equal(receipts.length,1);assert.equal(task.containers[0].exitCode,0);
  console.log(JSON.stringify({status:receipts[0].status,schema:receipts[0],resultPath:root+'/result.json',providerCalls:0,fixtureMutations:0},null,2));
} catch(error) {
  save('failure.json',{at:new Date().toISOString(),taskArn:arn??null,taskDefinition:td??null,status:'READ_NOT_QUALIFIED_RECONCILE_BEFORE_RETRY',errorClass:error?.name??'Error'});
  throw error;
} finally {
  if(arn&&task?.lastStatus!=='STOPPED'){
    awsSingleAttempt(['ecs','stop-task','--cluster','capiro-dev','--task',arn,'--reason','C2 bounded current schema read cleanup']);
    for(let i=0;i<12;i++){await delay(5000);task=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',arn]).tasks[0];if(task.lastStatus==='STOPPED')break;}
  }
  if(td){const result=awsSingleAttempt(['ecs','deregister-task-definition','--task-definition',td]);
    save('cleanup.json',{at:new Date().toISOString(),taskArn:arn??null,taskStopped:task?.lastStatus==='STOPPED',taskDefinition:td,status:result.taskDefinition.status});}
}
