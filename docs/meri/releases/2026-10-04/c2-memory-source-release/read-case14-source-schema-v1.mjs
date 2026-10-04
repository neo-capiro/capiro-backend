import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {awsSingleAttempt} from './aws-single-attempt.mjs';

const parent='C:/dev/main/outputs/meri-c2-20261003',root=parent+'/case14-source-schema-read-v1';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const save=(name,value)=>writeFileSync(root+'/'+name,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const svc=aws(['ecs','describe-services','--cluster','capiro-dev','--services','capiro-dev-api']).services[0];
assert.equal(svc.taskDefinition,'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:523');
assert.equal(svc.deployments.length,1);assert.equal(svc.deployments[0].rolloutState,'COMPLETED');
assert.equal(svc.runningCount,2);assert.equal(svc.pendingCount,0);
const body=readFileSync(parent+'/case14-source-schema-inner-v1.mjs','utf8');
const definition=JSON.parse(readFileSync(parent+'/corpus-read-definition-input.json','utf8'));
assert.equal(definition.containerDefinitions.length,1);
assert.equal(hash(readFileSync(parent+'/corpus-read-definition-input.json')),'6c0a447dc99ed35642df735c38d09e02b12b33983fe461b707cd0c06a8a44478');
assert.equal(hash(body),'4d8808af4b92dd4133f0c74410082e876630ede11fea2d168ac50b6ffed48ac7');
delete definition.taskRoleArn;
const c=definition.containerDefinitions[0];
assert.deepEqual(c.secrets.map(x=>x.name).sort(),['DB_HOST','DB_PASSWORD','DB_PORT','DB_USER']);
definition.family='capiro-dev-meri-c2-memory-source-schema-20261004';
c.image='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:024fcc82a2db7701f4a3e3311598a9a1d0933b3fe4fcf73751bf0e3fb866d8ce';
for(const row of c.environment)if(['GIT_SHA','RELEASE_SHA'].includes(row.name))row.value='c0f393f863bf73bd4e65e7a94e17c073e7be021e';
const liveDefinition=aws(['ecs','describe-task-definition','--task-definition',svc.taskDefinition]).taskDefinition;
const live=liveDefinition.containerDefinitions.find(x=>x.name==='api')??liveDefinition.containerDefinitions[0];
assert.equal(live.image,c.image);
const actualEnv=new Map(live.environment.map(x=>[x.name,x.value]));
assert.equal(actualEnv.get('RELEASE_SHA'),'c0f393f863bf73bd4e65e7a94e17c073e7be021e');
const identity=aws(['sts','get-caller-identity']);
assert.equal(identity.Account,'967807252336');assert.equal(identity.Arn,'arn:aws:iam::967807252336:user/capirocli');
const flagNames=['MERI_SYNTHETIC_FIXTURE_NAMESPACE','MEMORY_CLIENT_REVIEW','MEMORY_GOVERNANCE_LIFECYCLE','MEMORY_GOVERNANCE_ENFORCE','MEMORY_GOVERNANCE_CENTER','MEMORY_GOVERNANCE_TENANTS'];
for(const name of flagNames){assert.ok(actualEnv.has(name));c.environment=c.environment.filter(x=>x.name!==name);c.environment.push({name,value:actualEnv.get(name)});}
assert.equal(actualEnv.get('MERI_SYNTHETIC_FIXTURE_NAMESPACE'),'meri-foundation-20260928');
const journalPath='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl',journalBefore=readFileSync(journalPath);
assert.equal(hash(journalBefore),'816b04a47be56432846d1ee602370c3bea985eb497a7de9e899aee4d53f8b39e');
c.entryPoint=['/usr/bin/dumb-init','--','node','--input-type=module','-e'];c.command=[body];
mkdirSync(root);
save('intent.json',{at:new Date().toISOString(),kind:'EXACT_MEMORY_SOURCE_SCHEMA_READ',serviceRevision:523,image:c.image,
  sourceSha:'c0f393f863bf73bd4e65e7a94e17c073e7be021e',scriptSha256:hash(body),providerSecrets:0,workloadTaskRole:null,
  businessWrites:0,cloudActions:'one bounded read task; stop and deregister owned definition'});
save('definition-input.private.json',definition);
let td,arn,task,request,registrationDispatched=false,runDispatched=false;
try {
  registrationDispatched=true;
  const registered=awsSingleAttempt(['ecs','register-task-definition','--cli-input-json','file://'+root+'/definition-input.private.json']).taskDefinition;
  td=registered.taskDefinitionArn;
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
  request={cluster:'capiro-dev',taskDefinition:td,launchType:'FARGATE',count:1,networkConfiguration:svc.networkConfiguration,
    platformVersion:svc.platformVersion,startedBy:'meri-c2-receipt-'+randomUUID().slice(0,18),clientToken:randomUUID()};
  save('task-input.private.json',request);
  runDispatched=true;
  const start=awsSingleAttempt(['ecs','run-task','--cli-input-json','file://'+root+'/task-input.private.json']);
  assert.equal(start.failures?.length,0);assert.equal(start.tasks?.length,1);arn=start.tasks[0].taskArn;
  save('task-start.json',{at:new Date().toISOString(),taskArn:arn,taskDefinition:td,scriptSha256:hash(body)});
  console.log(JSON.stringify({stage:'C2_MEMORY_SOURCE_SCHEMA',status:'RECEIPT_READ_STARTED',taskArn:arn,providerCalls:0,fixtureMutations:0}));
  const deadline=Date.now()+8*60*1000;
  do {await delay(5000);task=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',arn]).tasks[0];
    assert.equal(task.taskDefinitionArn,td);
  } while(task.lastStatus!=='STOPPED'&&Date.now()<deadline);
  assert.equal(task.lastStatus,'STOPPED');
  assert.equal(task.containers.length,1);assert.equal(task.containers[0].image,c.image);
  assert.equal(task.containers[0].imageDigest,c.image.split('@')[1]);
  const events=[],pages=[],seenEvents=new Set();let nextToken,receipts=[];
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
      for(const event of logs.events){const key=JSON.stringify([event.timestamp,event.ingestionTime,event.message]);if(!seenEvents.has(key)){seenEvents.add(key);events.push(event);}}assert.ok(events.length<=5000);
      const unchanged=logs.nextForwardToken===nextToken;nextToken=logs.nextForwardToken;
      if(unchanged)break;
    }
    receipts=events.flatMap(e=>e.message.split('\n')).filter(line=>line.startsWith('C2_MEMORY_SOURCE_SCHEMA ')).map(line=>JSON.parse(line.slice('C2_MEMORY_SOURCE_SCHEMA '.length)));
    if(receipts.some(e=>['END','FAILURE'].includes(e.phase)))break;
    await delay(5000);
  }
  save('log-transport-pages.json',{at:new Date().toISOString(),pages,events:events.length});
  const result={at:new Date().toISOString(),taskArn:arn,taskDefinition:td,exitCode:task.containers[0].exitCode,image:c.image,
    scriptSha256:hash(body),receipts,providerCalls:0,fixtureMutations:0};
  save('result.json',result);
  assert.equal(task.containers[0].exitCode,0);
  const begin=receipts.filter(e=>e.phase==='BEGIN'),end=receipts.filter(e=>e.phase==='END'),chunks=receipts.filter(e=>e.phase==='CHUNK');
  assert.equal(begin.length,1);assert.equal(end.length,1);assert.equal(receipts.length,chunks.length+2);
  assert.deepEqual({...begin[0],phase:'END'},end[0]);assert.equal(chunks.length,begin[0].chunks);
  assert.deepEqual(chunks.map(x=>x.index),Array.from({length:chunks.length},(_,i)=>i));
  const bytes=Buffer.from(chunks.map(x=>x.data).join(''),'base64');assert.equal(bytes.length,begin[0].bytes);assert.equal(hash(bytes),begin[0].sha256);
  writeFileSync(root+'/schema-proof.json',bytes,{flag:'wx'});
  const owner=JSON.parse(bytes);assert.equal(owner.status,'VERIFIED_READ_ONLY');assert.equal(owner.readOnlyTransaction,true);assert.equal(owner.migrationExecution,false);assert.equal(owner.sourceSha,'c0f393f863bf73bd4e65e7a94e17c073e7be021e');assert.equal(owner.ledgerRows,609);assert.equal(owner.prior608Sha256,'9a82cbc9dcecc3b049c312ad4e39ec5a96eb33c6e5af033a3339d1e292c06e90');assert.equal(owner.retirementTablesAbsent,true);assert.equal(owner.providerCalls,0);assert.equal(owner.businessWrites,0);assert.equal(owner.acceptanceAuthority,false);
  save('readback-transport.json',begin[0]);

  console.log(JSON.stringify({status:'READ_ONLY_DIAGNOSTIC_CAPTURED',sha256:begin[0].sha256,bytes:begin[0].bytes,resultPath:root+'/schema-proof.json',providerCalls:0,fixtureMutations:0}));
} catch(error) {
  save('failure.json',{at:new Date().toISOString(),taskArn:arn??null,taskDefinition:td??null,status:'READ_NOT_QUALIFIED_RECONCILE_BEFORE_RETRY',errorClass:error?.name??'Error'});
  throw error;
} finally {
  const cleanupErrors=[];let definitionStatus=null;
  if(runDispatched&&!arn&&td&&request){
    try{
      for(let attempt=1;attempt<=6&&!arn;attempt++){
        const matches=[];
        for(const status of ['RUNNING','STOPPED']){
          const listing=aws(['ecs','list-tasks','--cluster','capiro-dev','--family',definition.family,'--desired-status',status,'--max-results','100']);
          assert.ok(Array.isArray(listing.taskArns)&&!listing.nextToken);
          if(listing.taskArns.length){
            const described=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...listing.taskArns]);
            assert.equal(described.failures?.length??0,0);assert.equal(described.tasks.length,listing.taskArns.length);
            matches.push(...described.tasks.filter(x=>x.startedBy===request.startedBy&&x.taskDefinitionArn===td));
          }
        }
        const unique=[...new Map(matches.map(x=>[x.taskArn,x])).values()];assert.ok(unique.length<=1);
        save('launch-reconciliation-'+attempt+'.json',{at:new Date().toISOString(),matchingTasks:unique.map(x=>({taskArn:x.taskArn,lastStatus:x.lastStatus})),automaticRetryAllowed:false});
        if(unique.length===1){task=unique[0];arn=task.taskArn;}else if(attempt<6)await delay(5000);
      }
      if(!arn)cleanupErrors.push({action:'RECONCILE_RUN_TASK',errorClass:'LaunchOutcomeUnresolved'});
    }catch(error){cleanupErrors.push({action:'RECONCILE_RUN_TASK',errorClass:error?.name??'Error'});}
  }
  if(registrationDispatched&&!td)cleanupErrors.push({action:'RECONCILE_REGISTRATION',errorClass:'RegistrationOutcomeUnresolved'});
  if(arn&&task?.lastStatus!=='STOPPED'){
    try {
      awsSingleAttempt(['ecs','stop-task','--cluster','capiro-dev','--task',arn,'--reason','C2 memory source schema read cleanup']);
      for(let i=0;i<12;i++){await delay(5000);task=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',arn]).tasks[0];if(task.lastStatus==='STOPPED')break;}
    }catch(error){cleanupErrors.push({action:'STOP_TASK',errorClass:error?.name??'Error'});}
  }
  if(td){
    try {definitionStatus=awsSingleAttempt(['ecs','deregister-task-definition','--task-definition',td]).taskDefinition.status;}
    catch(error){cleanupErrors.push({action:'DEREGISTER_DEFINITION',errorClass:error?.name??'Error'});}
  }
  const cleanupComplete=(!runDispatched||Boolean(arn)&&task?.lastStatus==='STOPPED')&&(!registrationDispatched||Boolean(td)&&definitionStatus==='INACTIVE')&&cleanupErrors.length===0;
  save('cleanup.json',{at:new Date().toISOString(),taskArn:arn??null,taskStopped:task?.lastStatus==='STOPPED',
    taskDefinition:td??null,status:definitionStatus,cleanupErrors,cleanupComplete});
  assert.ok(cleanupComplete,'READ_ONLY_TASK_CLEANUP_NOT_CONFIRMED');
  save('journal-preserved.json',{unchanged:readFileSync(journalPath).equals(journalBefore),sha256:hash(readFileSync(journalPath))});
  assert.ok(readFileSync(journalPath).equals(journalBefore));
}
