import { aws, root, ctx, save, need } from './auth-preflight.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
export const clientId='41f9ec63-3963-479f-b747-59a3767ef44b';
const expectedImage='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:5e52f9b06658b0462672d070928e0c2afd6ea229b61c3b887371f3f66196c316';
const expectedSha='6be5a560d5addaa1844f0687898c34a249089f76';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export function prepareDefinition() {
  const svc=aws(['ecs','describe-services','--cluster','capiro-dev','--services','capiro-dev-api']).services[0];
  need(svc.taskDefinition.endsWith(':515')&&svc.deployments.length===1&&svc.deployments[0].rolloutState==='COMPLETED','API_DRIFT');
  const d=aws(['ecs','describe-task-definition','--task-definition',svc.taskDefinition]).taskDefinition;
  const api=d.containerDefinitions.find(c=>c.name==='api');
  const env=Object.fromEntries(api.environment.map(e=>[e.name,e.value]));
  need(api.image===expectedImage&&env.GIT_SHA===expectedSha&&env.RELEASE_SHA===expectedSha,'API_IMAGE_DRIFT');
  for(const k of ['MEMORY_CLIENT_REVIEW','MEMORY_GOVERNANCE_LIFECYCLE','MEMORY_GOVERNANCE_CENTER','MEMORY_GOVERNANCE_ENFORCE'])need(env[k]==='enforce','GOVERNANCE_FLAG_UNVERIFIED');
  need(env.MERI_SYNTHETIC_FIXTURE_NAMESPACE==='meri-foundation-20260928','NAMESPACE_MISMATCH');
  const keys=['DB_NAME','GIT_SHA','RELEASE_SHA','AWS_REGION_DEFAULT','MEMORY_CLIENT_REVIEW','MEMORY_GOVERNANCE_LIFECYCLE','MEMORY_GOVERNANCE_CENTER','MEMORY_GOVERNANCE_ENFORCE','MERI_SYNTHETIC_FIXTURE_NAMESPACE'];
  const environment=keys.filter(k=>env[k]!==undefined).map(name=>({name,value:env[name]}));
  environment.push({name:'TMPDIR',value:'/dev/shm'},{name:'MEMORY_GOVERNANCE_TENANTS',value:ctx.tenantId+',52e91176-08f0-4d89-9633-bc212f5bdbbf'});
  const secrets=api.secrets.filter(s=>['DB_HOST','DB_PORT','DB_USER','DB_PASSWORD'].includes(s.name));
  need(secrets.length===4,'DB_REFS_MISSING');
  const def=Object.fromEntries(['taskRoleArn','executionRoleArn','networkMode','requiresCompatibilities','cpu','memory','runtimePlatform'].map(k=>[k,d[k]]));
  def.family='capiro-dev-meri-fresh-benchmark-20261003';
  def.containerDefinitions=[{name:'meri-fresh-benchmark',image:api.image,essential:true,environment,secrets,logConfiguration:{...api.logConfiguration,options:{...api.logConfiguration.options,'awslogs-stream-prefix':'meri-fresh-20261003'}},dockerLabels:{'org.opencontainers.image.revision':expectedSha}}];
  save('oneoff-definition-input.json',def);
  const registered=aws(['ecs','register-task-definition','--cli-input-json','file://'+root+'/oneoff-definition-input.json']);
  const binding={taskDefinition:registered.taskDefinition.taskDefinitionArn,networkConfiguration:svc.networkConfiguration,platformVersion:svc.platformVersion,logGroup:api.logConfiguration.options['awslogs-group'],image:expectedImage};
  save('oneoff-binding.json',binding);return binding;
}
export async function runOperation(binding, command, input, label) {
  need(['read-corpus','install'].includes(command),'OPERATION_FORBIDDEN');
  need(input.target==='capiro-dev'&&input.fixtureNamespace==='meri-foundation-20260928'&&input.ctx.userId===ctx.userId&&input.ctx.tenantId===ctx.tenantId,'INPUT_SCOPE');
  const request={cluster:'capiro-dev',taskDefinition:binding.taskDefinition,launchType:'FARGATE',platformVersion:binding.platformVersion,networkConfiguration:binding.networkConfiguration,count:1,startedBy:'meri-fresh-'+randomUUID().slice(0,20),clientToken:randomUUID(),overrides:{containerOverrides:[{name:'meri-fresh-benchmark',command:['meri-synthetic-read-budget',command,'--input-env','MERI_SYNTHETIC_READ_BUDGET_INPUT','--out','/dev/shm/'+label+'.json'],environment:[{name:'MERI_SYNTHETIC_READ_BUDGET_INPUT',value:JSON.stringify(input)}]}]}};
  save(label+'-task-input.json',request);
  need(Buffer.byteLength(JSON.stringify(request.overrides))<=8192,'ECS_OVERRIDE_TOO_LARGE');
  const started=aws(['ecs','run-task','--cli-input-json','file://'+root+'/'+label+'-task-input.json']);
  need(started.tasks?.length===1&&started.failures?.length===0,'TASK_START_FAILED');
  const taskArn=started.tasks[0].taskArn; save(label+'-task-start.json',{taskArn,at:new Date().toISOString()});
  console.log(JSON.stringify({stage:label,status:'TASK_STARTED',taskArn}));
  let task;const deadline=Date.now()+8*60*1000;
  try {
    do {await delay(5000);task=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',taskArn]).tasks[0];need(task.taskDefinitionArn===binding.taskDefinition,'TASK_DEFINITION_DRIFT');}while(task.lastStatus!=='STOPPED'&&Date.now()<deadline);
    need(task.lastStatus==='STOPPED','TASK_TIMEOUT');
    const stream='meri-fresh-20261003/meri-fresh-benchmark/'+taskArn.split('/').at(-1);
    let messages=[];
    for(let i=0;i<4;i++){try{messages=aws(['logs','get-log-events','--log-group-name',binding.logGroup,'--log-stream-name',stream,'--start-from-head']).events.map(e=>e.message);break;}catch{await delay(3000);}}
    const prefix=command==='read-corpus'?'MERI_SYNTHETIC_MEMORY_CORPUS_RECEIPT ':'MERI_SYNTHETIC_READ_BUDGET_RECEIPT ';
    const receipts=messages.flatMap(m=>m.split('\n')).filter(line=>line.startsWith(prefix)).map(line=>JSON.parse(line.slice(prefix.length)));
    const result={status:task.containers[0].exitCode===0?'COMPLETE':'FAILED',exitCode:task.containers[0].exitCode,taskArn,receipts,stoppedAt:task.stoppedAt};
    if(!receipts.length) result.diagnosticCodes=messages.flatMap(m=>m.match(/(?:CASE01_[A-Z_]+|meri_synthetic_read_budget_[a-z_]+|[A-Z_]+ERROR[A-Z_]*|Error: [a-zA-Z0-9_]+)/g)||[]).slice(0,10);
    save(label+'-result.json',result);console.log(JSON.stringify({stage:label,status:result.status,exitCode:result.exitCode,receipts:receipts.length,diagnosticCodes:result.diagnosticCodes}));
    need(result.exitCode===0&&receipts.length===1,'ONEOFF_'+label+'_FAILED');return receipts[0];
  } finally {if(task?.lastStatus!=='STOPPED')aws(['ecs','stop-task','--cluster','capiro-dev','--task',taskArn,'--reason','Fresh benchmark bounded operator cleanup']);}
}
if(process.argv[1]?.endsWith('oneoff.mjs')) {
  try {const binding=prepareDefinition(); const proof=await runOperation(binding,'read-corpus',{target:'capiro-dev',fixtureNamespace:'meri-foundation-20260928',confirmation:'READ_CURRENT_OWNED_MEMORY_CORPUS',ctx,clientId},'corpus-preflight');save('corpus-preflight.json',proof);}
  catch(e){console.log(JSON.stringify({status:'BLOCKED',code:e.message}));process.exitCode=1;}
}
