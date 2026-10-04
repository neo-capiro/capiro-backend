import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {awsSingleAttempt} from './aws-single-attempt.mjs';
import {taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';

const parent='C:/dev/main/outputs/meri-c2-20261003',root=parent+'/case14-native-execute-v3';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const save=(name,value)=>writeFileSync(root+'/'+name,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const svc=aws(['ecs','describe-services','--cluster','capiro-dev','--services','capiro-dev-api']).services[0];
assert.equal(svc.taskDefinition,'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:523');
assert.equal(svc.deployments.length,1);assert.equal(svc.deployments[0].rolloutState,'COMPLETED');
assert.equal(svc.runningCount,2);assert.equal(svc.pendingCount,0);
const body=readFileSync(parent+'/case14-native-execute-inner-v1.mjs','utf8');
const definition=JSON.parse(readFileSync(parent+'/corpus-read-definition-input.json','utf8'));
assert.equal(definition.containerDefinitions.length,1);
assert.equal(hash(readFileSync(parent+'/corpus-read-definition-input.json')),'6c0a447dc99ed35642df735c38d09e02b12b33983fe461b707cd0c06a8a44478');
assert.equal(hash(body),'42f0490e00639dd0d0a67289202c0f0e63535f5d68120c10aced5b22290ef0f9');
delete definition.taskRoleArn;
const c=definition.containerDefinitions[0];
assert.deepEqual(c.secrets.map(x=>x.name).sort(),['DB_HOST','DB_PASSWORD','DB_PORT','DB_USER']);
definition.family='capiro-dev-meri-c2-case14-execute-20261003';
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
const planBytes=readFileSync(parent+'/case14-native-execute-input-v1.json');assert.equal(hash(planBytes),'9d6bb553def112676b48125a71810c4307dd0950a7fa9f6fa63773b7fe50f167');c.environment.push({name:'C2_CASE14_EXECUTE_INPUT_B64',value:planBytes.toString('base64')});
c.environment.push({name:'C2_CASE14_EXECUTE_INPUT_SHA256',value:'9d6bb553def112676b48125a71810c4307dd0950a7fa9f6fa63773b7fe50f167'});
const journalPath='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl',journalBefore=readFileSync(journalPath);
assert.equal(hash(journalBefore),'8f20134f71dde90e32fc0c3c2aba2da2d5b93dd13fffea31b83105d1621bc3e5');
c.entryPoint=['/usr/bin/dumb-init','--','node','--input-type=module','-e'];c.command=[body];
const registrationMarker=randomUUID();
definition.tags=[...(definition.tags??[]).filter(t=>t.key!=='MeriC2RegistrationOwner'),{key:'MeriC2RegistrationOwner',value:registrationMarker}];
const normalizeDefinition=value=>{
  const input=taskInput(value);
  input.enableFaultInjection??=false;
  input.placementConstraints??=[];
  input.volumes??=[];
  input.tags=(input.tags??[]).sort((a,b)=>a.key.localeCompare(b.key));
  for(const container of input.containerDefinitions){
    container.cpu??=0;
    for(const key of ['mountPoints','portMappings','systemControls','volumesFrom'])container[key]??=[];
    for(const key of ['environment','secrets'])if(container[key])container[key].sort((a,b)=>a.name.localeCompare(b.name));
  }
  return input;
};
const exactFamilyInventory=()=>{
  const arns=[];
  for(const status of ['ACTIVE','INACTIVE']){
    const listing=aws(['ecs','list-task-definitions','--family-prefix',definition.family,'--status',status]);
    assert.equal(listing.nextToken,undefined);assert.ok(Array.isArray(listing.taskDefinitionArns));
    arns.push(...listing.taskDefinitionArns.filter(arn=>arn.split('/').at(-1).split(':')[0]===definition.family));
  }
  assert.equal(new Set(arns).size,arns.length);return arns;
};
const previousDefinitions=new Set(exactFamilyInventory());
mkdirSync(root);
save('registration-owner.json',{at:new Date().toISOString(),family:definition.family,registrationMarker,previousDefinitions:[...previousDefinitions],definitionSha256:hash(JSON.stringify(normalizeDefinition(definition)))});
save('intent.json',{at:new Date().toISOString(),kind:'EXACT_CASE14_NATIVE_PENDING_SETUP',serviceRevision:523,image:c.image,
  sourceSha:'c0f393f863bf73bd4e65e7a94e17c073e7be021e',scriptSha256:hash(body),providerSecrets:0,workloadTaskRole:null,
  allowedMutation:'ONE_CANONICAL_PENDING_CANDIDATE_AND_NATIVE_OWNER_CLAIM',cloudActions:'one bounded native setup task; stop and deregister owned definition'});
save('definition-input.private.json',definition);
let td,arn,task,request,registrationDispatched=false,runDispatched=false;
try {
  registrationDispatched=true;
  const registered=awsSingleAttempt(['ecs','register-task-definition','--cli-input-json','file://'+root+'/definition-input.private.json']).taskDefinition;
  td=registered.taskDefinitionArn;
  const registeredRead=aws(['ecs','describe-task-definition','--task-definition',td,'--include','TAGS']);
  assert.deepEqual(normalizeDefinition({...registeredRead.taskDefinition,tags:registeredRead.tags}),normalizeDefinition(definition));
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
  console.log(JSON.stringify({stage:'C2_CASE14_NATIVE_EXECUTE',status:'NATIVE_EXECUTE_STARTED',taskArn:arn,providerCalls:0,fixtureScope:'EXACT_CASE14_NATIVE_PENDING_SETUP'}));
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
    receipts=events.flatMap(e=>e.message.split('\n')).filter(line=>line.startsWith('C2_CASE14_NATIVE_EXECUTE ')).map(line=>JSON.parse(line.slice('C2_CASE14_NATIVE_EXECUTE '.length)));
    if(receipts.some(e=>['END','FAILURE'].includes(e.phase)))break;
    await delay(5000);
  }
  save('log-transport-pages.json',{at:new Date().toISOString(),pages,events:events.length});
  const result={at:new Date().toISOString(),taskArn:arn,taskDefinition:td,exitCode:task.containers[0].exitCode,image:c.image,
    scriptSha256:hash(body),receipts,providerCalls:0,fixtureScope:'EXACT_CASE14_NATIVE_PENDING_SETUP'};
  save('result.json',result);
  assert.equal(task.containers[0].exitCode,0);
  const begin=receipts.filter(e=>e.phase==='BEGIN'),end=receipts.filter(e=>e.phase==='END'),chunks=receipts.filter(e=>e.phase==='CHUNK');
  assert.equal(begin.length,1);assert.equal(end.length,1);assert.equal(receipts.length,chunks.length+2);
  assert.deepEqual({...begin[0],phase:'END'},end[0]);assert.equal(chunks.length,begin[0].chunks);
  assert.deepEqual(chunks.map(x=>x.index),Array.from({length:chunks.length},(_,i)=>i));
  const bytes=Buffer.from(chunks.map(x=>x.data).join(''),'base64');assert.equal(bytes.length,begin[0].bytes);assert.equal(hash(bytes),begin[0].sha256);
  writeFileSync(root+'/native-execute-readback.json',bytes,{flag:'wx'});
  const owner=JSON.parse(bytes);assert.equal(owner.status,'ONE_PENDING_CANDIDATE_CREATED_AND_READ_BACK');assert.equal(owner.providerCalls,0);assert.equal(owner.candidateCreations,1);assert.equal(owner.reviewDecisions,0);assert.equal(owner.recallSubmissions,0);assert.equal(owner.acceptanceAuthority,false);
  save('readback-transport.json',begin[0]);

  console.log(JSON.stringify({status:'NATIVE_PENDING_SETUP_CAPTURED',sha256:begin[0].sha256,bytes:begin[0].bytes,resultPath:root+'/native-execute-readback.json',providerCalls:0,fixtureScope:'EXACT_CASE14_NATIVE_PENDING_SETUP'}));
} catch(error) {
  save('failure.json',{at:new Date().toISOString(),taskArn:arn??null,taskDefinition:td??null,status:'EXECUTION_NOT_QUALIFIED_RECONCILE_BEFORE_RETRY',errorClass:error?.name??'Error'});
  throw error;
} finally {
  const cleanupErrors=[];let definitionStatus=null;
  if(registrationDispatched&&!td){
    try{
      for(let attempt=1;attempt<=4&&!td;attempt++){
        const candidates=exactFamilyInventory().filter(arn=>!previousDefinitions.has(arn));
        const matches=[];
        for(const candidate of candidates){
          const value=aws(['ecs','describe-task-definition','--task-definition',candidate,'--include','TAGS']);
          if((value.tags??[]).some(tag=>tag.key==='MeriC2RegistrationOwner'&&tag.value===registrationMarker)){
            assert.deepEqual(normalizeDefinition({...value.taskDefinition,tags:value.tags}),normalizeDefinition(definition));
            matches.push(candidate);
          }
        }
        assert.ok(matches.length<=1,'Ambiguous owned registration');
        save('registration-reconciliation-'+attempt+'.json',{at:new Date().toISOString(),newDefinitionCount:candidates.length,matchingTaskDefinitions:matches,registrationRetry:false,taskLaunchAllowed:false});
        if(matches.length===1)td=matches[0];else if(attempt<4)await delay(5000);
      }
    }catch(error){cleanupErrors.push({action:'RECONCILE_REGISTRATION',errorClass:error?.name??'Error'});}
  }
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
      awsSingleAttempt(['ecs','stop-task','--cluster','capiro-dev','--task',arn,'--reason','C2 bounded exact Case14 native pending setup cleanup']);
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
  assert.ok(cleanupComplete,'NATIVE_SETUP_TASK_CLEANUP_NOT_CONFIRMED');
  save('journal-preserved.json',{unchanged:readFileSync(journalPath).equals(journalBefore),sha256:hash(readFileSync(journalPath))});
  assert.ok(readFileSync(journalPath).equals(journalBefore));
}
