import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {aws} from '../../meri-fresh-20261003/auth-preflight.mjs';
import {awsSingleAttempt} from '../aws-single-attempt.mjs';
import {fingerprint,taskInput} from '../../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
import {releaseOperator} from '../../../meri-c1-20261002/scripts/meri-release.mjs';

// Preparation is inert. Only direct execution by the lead launches this one read task.
const BASE='C:/dev/main/outputs/meri-c2-20261003';
const ROOT=BASE+'/case12-iam-read-probe-v1';
const OUT=ROOT+'/executed-once';
const JOURNAL='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl';
export const SOURCE='e60f37189f8c9b68ab7d5ef66e515ed3be4ec3c1';
export const IMAGE='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:202832655633f906dec412ca088a7263e8e8065cd9a602402d98e5d2b092fe22';
const INNER_SHA='5f92354dbb845d035cbb1160e7a0a27d964ed3a19ffc398c82f3ba733085c23f';
const PACKET_SHA='781b944fee40f504c744dda2f609f0f63446b9693dd2cdb661ecde756f749fc2';
const ROLE='arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ';
const TAG='meri-case12-setup-owner';
const JOURNAL_HASH='816b04a47be56432846d1ee602370c3bea985eb497a7de9e899aee4d53f8b39e';
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const save=(name,value)=>{
  const fd=openSync(OUT+'/'+name,'wx');
  try{writeFileSync(fd,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
};
export function immutableCliInput(value){
  const text=JSON.stringify(value);assert.ok(2*text.length+4096<32767,'WINDOWS_COMMAND_BOUND');return text;
}
function verifyPins(){const raw=readFileSync(ROOT+'/input-pins.json');assert.equal(hash(raw),'a33aa43c9eb41bb01a62018e5fb864cf0cbe179d98a5e0d33f75199712c4d6df');const pins=JSON.parse(raw);for(const p of pins){const b=readFileSync(p.path);assert.equal(b.length,p.bytes);assert.equal(hash(b),p.sha256);}}
function approved(){const packet=JSON.parse(readFileSync(BASE+'/case12-source-release-packet-v1.json')),approval=JSON.parse(readFileSync(BASE+'/case12-release-human-approval.json'));assert.equal(fingerprint(packet),PACKET_SHA);assert.equal(approval.status,'APPROVED');assert.equal(approval.scope,'EXACT_C2_CASE12_RELEASE_AND_TEMPORARY_IAM');assert.equal(approval.packetSha256,PACKET_SHA);assert.equal(approval.temporaryIam.roleArn,ROLE);assert.equal(approval.temporaryIam.policySha256,'173d4b8f134c2d1fac50b9df7d3db6e4e136f1e965c293a258cee6407da50d3a');assert.ok(Date.now()<Date.parse(approval.temporaryIam.expiresAt));return packet;}
export function checkSnapshot(live,expected){assert.equal(live.baseline.imageDigest,expected.candidate.image.split('@')[1]);assert.equal(live.baseline.configHash,expected.baseline.configHash);assert.equal(live.baseline.desiredCount,expected.baseline.desiredCount);assert.equal(fingerprint(taskInput(live.task)),expected.candidateTaskSha256);const c=live.task.containerDefinitions.find(c=>c.name===expected.service);assert.equal(c.image,expected.candidate.image);assert.equal(c.environment.find(e=>e.name==='RELEASE_SHA')?.value,SOURCE);if(expected.service==='api')assert.equal(live.task.taskRoleArn,ROLE);return live.service;}
function unique(rows,key){assert.ok(Array.isArray(rows));assert.equal(new Set(rows.map(r=>r[key])).size,rows.length);return [...rows].sort((a,b)=>a[key].localeCompare(b[key]));}
export function normalizeDefinition(value){
  const input=taskInput(value);input.enableFaultInjection??=false;input.placementConstraints??=[];input.volumes??=[];
  input.tags=unique(input.tags??[],'key');
  for(const c of input.containerDefinitions){c.cpu??=0;for(const k of ['mountPoints','portMappings','systemControls','volumesFrom'])c[k]??=[];for(const k of ['environment','secrets'])c[k]=unique(c[k]??[],'name');}
  return input;
}
export function buildDefinition(template,marker,inner){
 const d=structuredClone(template);assert.equal(d.containerDefinitions.length,1);d.taskRoleArn=ROLE;d.family='capiro-dev-meri-c2-case12-iam-probe-20261004';d.tags=[{key:TAG,value:marker}];const c=d.containerDefinitions[0];c.name='meri-c12-iam-read-probe';c.image=IMAGE;c.dockerLabels={'org.opencontainers.image.revision':SOURCE};c.secrets=[];c.logConfiguration.secretOptions=[];c.entryPoint=['node','--input-type=module','--eval'];c.command=[inner];c.environment=Object.entries({GIT_SHA:SOURCE,RELEASE_SHA:SOURCE,AWS_REGION:'us-east-1',AWS_DEFAULT_REGION:'us-east-1',AWS_MAX_ATTEMPTS:'1',MERI_C12_IAM_MARKER:marker}).map(([name,value])=>({name,value}));return d;
}
export function inspectProbeReceipt(r,marker,taskArn,td){assert.equal(r.kind,'meri-case12-iam-read-probe');assert.equal(r.version,1);assert.equal(r.status,'ACTUAL_SELF_ECS_READS_SUCCEEDED');assert.equal(r.sourceSha,SOURCE);assert.equal(r.image,IMAGE);assert.equal(r.taskArn,taskArn);assert.equal(r.taskDefinitionArn,td);assert.equal(r.taskRoleArn,ROLE);assert.equal(r.registrationMarker,marker);assert.equal(r.metadataV4,true);assert.deepEqual(r.sdkCommands,['DescribeTasks','DescribeTaskDefinition']);assert.equal(r.maxAttempts,1);assert.equal(r.dbSecrets,0);assert.equal(r.providerSecrets,0);assert.equal(r.setupExecuted,false);assert.equal(r.nativeAdmissionQualified,false);assert.equal(r.captureAuthority,false);assert.equal(r.liveAcceptance,'NOT_RUN');return r;}
export function parseReceipt(events){
  const lines=events.flatMap(e=>e.message.split('\n')).filter(line=>line.startsWith('MERI_CASE12_IAM_READ_PROBE '));
  assert.equal(lines.length,1);const raw=lines[0].slice('MERI_CASE12_IAM_READ_PROBE '.length);
  assert.ok(Buffer.byteLength(raw)<65536);return {raw:raw+'\n',receipt:JSON.parse(raw)};
}
export function assertOwnedTask(task,arn,td,request,definition){
  assert.equal(task.taskArn,arn);assert.equal(task.taskDefinitionArn,td);assert.equal(task.startedBy,request.startedBy);
  assert.deepEqual(unique(task.tags??[],'key'),unique(definition.tags,'key'));
  assert.equal(task.containers.length,1);assert.equal(task.containers[0].name,definition.containerDefinitions[0].name);
  assert.equal(task.containers[0].image,IMAGE);
  if(task.containers[0].imageDigest!==undefined)assert.equal(task.containers[0].imageDigest,IMAGE.split('@')[1]);
  return task;
}
export async function runIamProbe(){
  assert.equal(arguments.length,0);verifyPins();
  const packet=approved();const inner=readFileSync(ROOT+'/iam-read-probe-inner-v1.mjs','utf8');assert.equal(hash(inner),INNER_SHA);
  const journalBefore=readFileSync(JOURNAL);assert.equal(hash(journalBefore),JOURNAL_HASH);assert.equal(journalBefore.toString().trim().split('\n').length,26);
  mkdirSync(OUT); // Exclusive run boundary: a partial prior attempt cannot be replayed.
  let serial=0;
  const read=args=>{const value=aws(args);save('raw-'+String(++serial).padStart(3,'0')+'-'+args.slice(0,2).join('-')+'.private.json',{at:new Date().toISOString(),args,value});return value;};
  const mutate=args=>{const id=String(++serial).padStart(3,'0');save('mutation-'+id+'-intent.private.json',{at:new Date().toISOString(),args,automaticRetryAllowed:false});const value=awsSingleAttempt(args);save('raw-'+id+'-'+args.slice(0,2).join('-')+'.private.json',{at:new Date().toISOString(),args,value});return value;};
  const identity=read(['sts','get-caller-identity']);assert.equal(identity.Account,'967807252336');assert.equal(identity.Arn,'arn:aws:iam::967807252336:user/capirocli');
  const iam=JSON.parse(readFileSync(BASE+'/case12-temporary-iam-supervised-v1/executed-once/apply-readback.json'));assert.equal(iam.status,'EXACT_POLICY_PRESENT_ORIGINALS_UNCHANGED');assert.equal(iam.packetSha256,PACKET_SHA);assert.equal(iam.temporaryPresent,true);assert.equal(iam.originalsUnchanged,true);
  const policy=read(['iam','get-role-policy','--role-name',ROLE.split('/').at(-1),'--policy-name','MeriCase12NativeSetupReads20261004']);assert.equal(policy.RoleName,ROLE.split('/').at(-1));assert.equal(policy.PolicyName,'MeriCase12NativeSetupReads20261004');assert.equal(fingerprint(policy.PolicyDocument),fingerprint(packet.temporaryIam.policyDocument));
  const release=releaseOperator({aws:read});let service;for(const expected of packet.services){const live=await release.snapshot(expected.service);checkSnapshot(live,expected);save('healthy-'+expected.service+'-before.private.json',live);if(expected.service==='api')service=live.service;}assert.ok(service);
  const marker=randomUUID(),definition=buildDefinition(JSON.parse(readFileSync(BASE+'/corpus-read-definition-input.json')),marker,inner),c=definition.containerDefinitions[0];
  const inventory=()=>{const arns=[];for(const status of ['ACTIVE','INACTIVE']){const r=read(['ecs','list-task-definitions','--family-prefix',definition.family,'--status',status,'--no-paginate']);assert.ok(Array.isArray(r.taskDefinitionArns));assert.ok(!r.nextToken);arns.push(...r.taskDefinitionArns.filter(a=>a.split('/').at(-1).split(':')[0]===definition.family));}assert.equal(new Set(arns).size,arns.length);return arns;};
  const previous=new Set(inventory());
  save('intent.json',{kind:'CASE12_ACTUAL_IAM_SELF_READ_PROBE',at:new Date().toISOString(),sourceSha:SOURCE,image:IMAGE,innerSha256:INNER_SHA,packetSha256:PACKET_SHA,registrationMarker:marker,previousDefinitions:[...previous],providerCalls:0,databaseCalls:0,secrets:0,automaticRetryAllowed:false});
  const definitionJson=immutableCliInput(definition);
  save('definition-input.private.json',definitionJson+'\n');
  let td,arn,task,request,registered=false,launched=false,plan,primaryError;
  const describe=taskArn=>{const r=read(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',taskArn,'--include','TAGS']);assert.equal(r.failures?.length??0,0);assert.equal(r.tasks.length,1);return assertOwnedTask(r.tasks[0],taskArn,td,request,definition);};
  const exactDefinition=(value,expectedArn)=>{assert.equal(value.taskDefinition.taskDefinitionArn,expectedArn);assert.deepEqual(normalizeDefinition({...value.taskDefinition,tags:value.tags}),normalizeDefinition(definition));};
  try{
    registered=true;const registration=mutate(['ecs','register-task-definition','--cli-input-json',definitionJson]);const acknowledgedDefinition=registration.taskDefinition.taskDefinitionArn;
    exactDefinition(read(['ecs','describe-task-definition','--task-definition',acknowledgedDefinition,'--include','TAGS']),acknowledgedDefinition);td=acknowledgedDefinition;
    request={cluster:'capiro-dev',taskDefinition:td,launchType:'FARGATE',count:1,networkConfiguration:service.networkConfiguration,platformVersion:service.platformVersion,startedBy:'c12-'+marker.replaceAll('-',''),clientToken:randomUUID(),tags:definition.tags};
    const requestJson=immutableCliInput(request);save('task-input.private.json',requestJson+'\n');save('launch-intent.json',{at:new Date().toISOString(),taskDefinition:td,startedBy:request.startedBy,clientToken:request.clientToken,requestSha256:hash(JSON.stringify(request)),singleAttempt:true});
    launched=true;const start=mutate(['ecs','run-task','--cli-input-json',requestJson]);assert.equal(start.failures?.length??0,0);assert.equal(start.tasks?.length,1);const acknowledgedTask=start.tasks[0].taskArn;
    task=describe(acknowledgedTask);arn=acknowledgedTask;
    save('task-start.json',{at:new Date().toISOString(),taskArn:arn,taskDefinition:td,startedBy:request.startedBy});
    const deadline=Date.now()+8*60*1000;
    do{await delay(5000);task=describe(arn);assert.equal(task.startedBy,request.startedBy);}while(task.lastStatus!=='STOPPED'&&Date.now()<deadline);
    assert.equal(task.lastStatus,'STOPPED');assert.equal(task.containers.length,1);assert.equal(task.containers[0].image,IMAGE);assert.equal(task.containers[0].imageDigest,IMAGE.split('@')[1]);
    save('stopped-task.private.json',task);
    const events=[],seen=new Set();let token;const logDeadline=Date.now()+180000;
    for(let round=0;round<24&&Date.now()<logDeadline;round++){
      for(let page=0;page<20&&Date.now()<logDeadline;page++){
        const args=['logs','get-log-events','--log-group-name',c.logConfiguration.options['awslogs-group'],'--log-stream-name',c.logConfiguration.options['awslogs-stream-prefix']+'/'+c.name+'/'+arn.split('/').at(-1),'--start-from-head','--no-paginate'];if(token)args.push('--next-token',token);
        let logs;try{logs=read(args);}catch(error){save('log-unavailable-'+round+'-'+page+'.json',{at:new Date().toISOString(),errorClass:error?.name??'Error'});break;}
        assert.ok(Array.isArray(logs.events));assert.equal(typeof logs.nextForwardToken,'string');
        for(const e of logs.events){const key=JSON.stringify([e.timestamp,e.ingestionTime,e.message]);if(!seen.has(key)){seen.add(key);events.push(e);}}assert.ok(events.length<=5000);
        const unchanged=token===logs.nextForwardToken;token=logs.nextForwardToken;if(unchanged)break;
      }
      if(events.some(e=>e.message.includes('MERI_CASE12_IAM_READ_PROBE ')||e.message.includes('CASE12_IAM_READ_PROBE_FAILED')))break;
      await delay(5000);
    }
    save('log-events.private.json',events);assert.equal(task.containers[0].exitCode,0);
    const parsed=parseReceipt(events);plan=inspectProbeReceipt(parsed.receipt,marker,arn,td);
    save('iam-probe-receipt.json',parsed.raw);
  }catch(error){primaryError=error;save('failure.json',{at:new Date().toISOString(),taskArn:arn??null,taskDefinition:td??null,status:'IAM_PROBE_NOT_QUALIFIED_RECONCILE_BEFORE_RETRY',errorClass:error?.name??'Error',stackFrames:String(error?.stack??'').split('\n').slice(1,7),automaticRetryAllowed:false});}
  finally{
    const errors=[];let inactive;
    if(registered&&!td){try{for(let n=1;n<=4&&!td;n++){
      const matches=[];for(const candidate of inventory().filter(a=>!previous.has(a))){const r=read(['ecs','describe-task-definition','--task-definition',candidate,'--include','TAGS']);if((r.tags??[]).some(t=>t.key===TAG&&t.value===marker)){exactDefinition(r,candidate);matches.push(candidate);}}
      assert.ok(matches.length<=1);save('registration-reconciliation-'+n+'.json',{matches,taskLaunchAllowed:false,registrationRetry:false});if(matches.length===1)td=matches[0];else if(n<4)await delay(5000);
    }}catch(e){errors.push({action:'RECONCILE_REGISTRATION',errorClass:e?.name??'Error'});}}
    if(registered&&!td)errors.push({action:'RECONCILE_REGISTRATION',errorClass:'RegistrationOutcomeUnresolved'});
    if(launched&&!arn&&td&&request){try{for(let n=1;n<=6&&!arn;n++){
      const matches=[];for(const status of ['RUNNING','STOPPED']){const r=read(['ecs','list-tasks','--cluster','capiro-dev','--family',definition.family,'--desired-status',status,'--max-results','100','--no-paginate']);assert.ok(Array.isArray(r.taskArns));assert.ok(!r.nextToken);if(r.taskArns.length){const d=read(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...r.taskArns,'--include','TAGS']);assert.equal(d.failures?.length??0,0);assert.equal(d.tasks.length,r.taskArns.length);assert.deepEqual(d.tasks.map(t=>t.taskArn).sort(),[...r.taskArns].sort());for(const t of d.tasks.filter(t=>t.startedBy===request.startedBy&&t.taskDefinitionArn===td))matches.push(assertOwnedTask(t,t.taskArn,td,request,definition));}}
      const uniqueTasks=[...new Map(matches.map(t=>[t.taskArn,t])).values()];assert.ok(uniqueTasks.length<=1);save('launch-reconciliation-'+n+'.json',{matchingTasks:uniqueTasks.map(t=>t.taskArn),automaticRetryAllowed:false});if(uniqueTasks.length===1){task=uniqueTasks[0];arn=task.taskArn;}else if(n<6)await delay(5000);
    }}catch(e){errors.push({action:'RECONCILE_RUN_TASK',errorClass:e?.name??'Error'});}}
    if(launched&&!arn)errors.push({action:'RECONCILE_RUN_TASK',errorClass:'LaunchOutcomeUnresolved'});
    if(arn){try{task=describe(arn);if(task.lastStatus!=='STOPPED'){mutate(['ecs','stop-task','--cluster','capiro-dev','--task',arn,'--reason','C2 Case12 IAM read probe cleanup']);for(let n=0;n<12;n++){await delay(5000);task=describe(arn);if(task.lastStatus==='STOPPED')break;}}}catch(e){errors.push({action:'STOP_TASK',errorClass:e?.name??'Error'});}}
    if(arn&&task?.lastStatus==='STOPPED')save('cleanup-stopped-task.private.json',task);
    if(td){try{exactDefinition(read(['ecs','describe-task-definition','--task-definition',td,'--include','TAGS']),td);mutate(['ecs','deregister-task-definition','--task-definition',td]);inactive=read(['ecs','describe-task-definition','--task-definition',td,'--include','TAGS']);exactDefinition(inactive,td);assert.equal(inactive.taskDefinition.status,'INACTIVE');save('cleanup-inactive-definition.private.json',inactive);}catch(e){errors.push({action:'DEREGISTER_DEFINITION',errorClass:e?.name??'Error'});}}
    const complete=(!launched||Boolean(arn)&&task?.lastStatus==='STOPPED')&&(!registered||Boolean(td)&&inactive?.taskDefinition?.status==='INACTIVE')&&errors.length===0;
    save('cleanup.json',{at:new Date().toISOString(),taskArn:arn??null,taskDefinition:td??null,taskStopped:task?.lastStatus==='STOPPED',definitionStatus:inactive?.taskDefinition?.status??null,cleanupComplete:complete,errors});
    const journalAfter=readFileSync(JOURNAL);save('journal-preserved.json',{at:new Date().toISOString(),unchanged:journalAfter.equals(journalBefore),beforeSha256:hash(journalBefore),afterSha256:hash(journalAfter),events:journalAfter.toString().trim().split('\n').length});
    assert.ok(journalAfter.equals(journalBefore));assert.ok(complete,'READ_ONLY_TASK_CLEANUP_NOT_CONFIRMED');
  }
  if(primaryError)throw primaryError;
  for(const expected of packet.services){const live=await release.snapshot(expected.service);checkSnapshot(live,expected);save('healthy-'+expected.service+'-after.private.json',live);}
  save('result.json',{status:'ACTUAL_IAM_SELF_READS_AND_OWNED_CLEANUP_CAPTURED',at:new Date().toISOString(),sourceSha:SOURCE,image:IMAGE,taskArn:arn,taskDefinitionArn:td,startedAt:task.startedAt,stoppedAt:task.stoppedAt,exitCode:task.containers[0].exitCode,innerSha256:INNER_SHA,registrationMarker:marker,providerCalls:0,databaseCalls:0,secrets:0,journalUnchanged:true,bothPromotedServicesHealthy:true,setupExecuted:false,nativeAdmissionQualified:false,captureAuthority:false,liveAcceptance:'NOT_RUN'});
  console.log(JSON.stringify({status:'ACTUAL_IAM_SELF_READS_AND_OWNED_CLEANUP_CAPTURED',output:OUT}));
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){assert.equal(process.argv.length,2);await runIamProbe();}
