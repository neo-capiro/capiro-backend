// Local-only qualification. The dispatcher is never imported or executed.
// Its declarations are evaluated with explicit local dependencies; only named
// pure functions and an injected fake-AWS lifecycle are called on new scratch roots.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import * as fs from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

const base=path.dirname(fileURLToPath(import.meta.url));
const candidate=process.argv[3] ? path.resolve(process.argv[3]) : path.join(base,'supervised-candidate');
const out=path.join(base,process.argv[2]??'local-qualification-v1');
fs.mkdirSync(out);
const file=path.join(candidate,'run-case20-native-setup.mjs');
const original=fs.readFileSync(file,'utf8');
const sourceHash=createHash('sha256').update(original).digest('hex');
const innerBytes=fs.readFileSync(path.join(candidate,'case20-native-setup-inner.mjs'));
const innerHash=createHash('sha256').update(innerBytes).digest('hex');
const program=original.slice(0,original.indexOf('\nmain().catch('))
  .replace(/^#![^\n]*\n/u,'').replace(/^import[^\n]*;\n/gmu,'')
  .replace('path.dirname(fileURLToPath(import.meta.url))',JSON.stringify(candidate));
assert.ok(!program.includes('import.meta'));
let tick=Date.now();
class FastDate extends Date {static now(){tick+=60000;return tick;}}
const exports=['validateCheckpoint','validatePacket','verifyReceiptBytes','buildTaskDefinition','normalizeTaskEnvironment',
  'withExplicitEcsDefaults','exactTaskArn','makeWrapper','runNativeTask','canonicalFingerprint','SOURCE','RUN','INPUT_SHA256'];
const names=['assert','createHash','randomUUID','existsSync','mkdirSync','openSync','writeFileSync','fsyncSync','closeSync',
  'readFileSync','path','fileURLToPath','pathToFileURL','readFile','execFileSync','setTimeout','Date'];
const accountingRoot='C:/dev/main/outputs/meri-fresh-20261003';
const accountingOriginal={'run-authorization.json':Buffer.from('UNIT_AUTH_ONLY'), 'fresh-spend.jsonl':Buffer.from('UNIT_JOURNAL_ONLY')};
let accountingFiles={...accountingOriginal};
const accountingCheckpoint={state:{root:accountingRoot,files:Object.fromEntries(Object.entries(accountingOriginal).map(([name,b])=>[name,{bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}]))}};
const isolatedRead=async file=>path.resolve(file).startsWith(path.resolve(accountingRoot)+path.sep) ? Buffer.from(accountingFiles[path.basename(file)]) : readFile(file);
const values=[assert,createHash,randomUUID,fs.existsSync,fs.mkdirSync,fs.openSync,fs.writeFileSync,fs.fsyncSync,fs.closeSync,
  fs.readFileSync,path,fileURLToPath,pathToFileURL,isolatedRead,()=>{throw Error('SUBPROCESS_FORBIDDEN_IN_FUNCTION_TESTS');},
  callback=>{queueMicrotask(callback);return 0;},FastDate];
const api=new Function(...names,program+`\nreturn {${exports.join(',')},recheckAccountingFiles:typeof recheckAccountingFiles==='function'?recheckAccountingFiles:null};`)(...values);
const results=[];
async function test(name,work){try{await work();results.push({name,status:'PASS'});console.log('PASS '+name);}
  catch(error){results.push({name,status:'FAIL',errorClass:error.name,message:error.message});console.log('FAIL '+name+' '+error.message);}}
const hash=b=>createHash('sha256').update(b).digest('hex');
const packet=JSON.parse(fs.readFileSync('C:/dev/main/outputs/meri-c2-20261003/capture-contract-release-packet.json','utf8'));
// Unit objects only. No approval file or real promotion receipt is written.
const approval={status:'APPROVED',scope:'EXACT_C2_CAPTURE_CONTRACT_RELEASE',packetSha256:api.canonicalFingerprint(packet),
  approvedAt:new Date().toISOString(),paidCaptureAuthority:false,
  scopeDetails:packet.services.filter(s=>s.candidate).map(s=>({service:s.service,...s.candidate}))};
const receipts={},receiptBytes={};
for(const row of packet.services.filter(s=>s.candidate)){
  receipts[row.service]={status:'ecs-healthy-manual-acceptance-required',service:row.service,candidateImage:row.candidate.image,
    candidateTaskHash:row.candidateTaskSha256,configHash:row.baseline.configHash,manifestHash:'f'.repeat(64),
    candidateTaskDefinition:`arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-${row.service}:9999`};
  receiptBytes[row.service]=Buffer.from(JSON.stringify(receipts[row.service]));
}
const release=api.validatePacket(packet,approval,receipts,receiptBytes);
await test('exact new packet shape accepts a separate promotion manifest hash in memory',()=>assert.ok(release.services.api));
for(const [name,mutate] of [
  ['old approval scope rejected',a=>a.scope='EXACT_C2_CLOCK_PROVIDER_RELEASE'],
  ['approval hash mismatch rejected',a=>a.packetSha256='e'.repeat(64)],
  ['different source in approved pair rejected',a=>a.scopeDetails[0].sourceSha='1'.repeat(40)],
  ['paid capture authority cannot be inferred',a=>a.paidCaptureAuthority=true],
]) await test(name,()=>{const a=structuredClone(approval);mutate(a);assert.throws(()=>api.validatePacket(packet,a,receipts,receiptBytes));});
await test('missing healthy promotion receipt rejected',()=>assert.throws(()=>api.validatePacket(packet,approval,{...receipts,api:null},receiptBytes)));
await test('saved actual 22-event checkpoint is read without opening its journal',()=>{
  const b=fs.readFileSync('C:/dev/main/outputs/meri-c2-20261003/case01-terminal-cost-executed-v1/aggregate-checkpoint.json');
  assert.ok(api.validateCheckpoint(JSON.parse(b),b));
  const wrong=JSON.parse(b);wrong.snapshot.activeRun={caseId:'20'};assert.throws(()=>api.validateCheckpoint(wrong,b));
  assert.throws(()=>api.validateCheckpoint(JSON.parse(b),Buffer.concat([b,Buffer.from(' ')])));
});
await test('read-only current accounting accepts exact bytes without opening live files',async()=>{
  assert.equal(typeof api.recheckAccountingFiles,'function');
  const result=await api.recheckAccountingFiles(accountingCheckpoint);assert.equal(result.readOnly,true);
});
for(const name of ['run-authorization.json','fresh-spend.jsonl']) {
  await test('read-only current accounting rejects changed '+name,async()=>{
    assert.equal(typeof api.recheckAccountingFiles,'function');
    accountingFiles={...accountingOriginal,[name]:Buffer.from('changed')};
    try {await assert.rejects(api.recheckAccountingFiles(accountingCheckpoint));}finally{accountingFiles={...accountingOriginal};}
  });
}
const fakeApi={task:{taskRoleArn:'arn:aws:iam::967807252336:role/EXISTING_WORKLOAD_ROLE_MUST_BE_REMOVED',
  executionRoleArn:'arn:aws:iam::967807252336:role/UNIT_TEST_EXECUTION_ROLE',runtimePlatform:{cpuArchitecture:'ARM64',operatingSystemFamily:'LINUX'},
  containerDefinitions:[{name:'api',environment:[{name:'DB_NAME',value:'capiro'}],secrets:[...['DB_HOST','DB_PASSWORD','DB_PORT','DB_USER'].map(name=>({name,valueFrom:'arn:aws:secretsmanager:us-east-1:967807252336:secret:UNIT_TEST_'+name})),{name:'OPENAI_API_KEY',valueFrom:'UNIT_TEST_PROVIDER_SECRET_EXCLUDED'}],
    logConfiguration:{logDriver:'awslogs',options:{'awslogs-region':'us-east-1','awslogs-group':'UNIT_TEST_ONLY','awslogs-stream-prefix':'unit'}}}]},
  service:{networkConfiguration:{awsvpcConfiguration:{subnets:['UNIT_TEST_SUBNET'],securityGroups:['UNIT_TEST_GROUP'],assignPublicIp:'DISABLED'}},platformVersion:'LATEST'}};
await test('minimal utility removes workload role and all provider secrets',()=>{
  const d=api.buildTaskDefinition(fakeApi,{},release);assert.equal(Object.hasOwn(d,'taskRoleArn'),false);
  assert.deepEqual(d.containerDefinitions[0].secrets.map(s=>s.name).sort(),['DB_HOST','DB_PASSWORD','DB_PORT','DB_USER']);
  assert.equal(d.executionRoleArn,fakeApi.task.executionRoleArn);
});
await test('duplicate DB secret names and environment files refuse',()=>{
  const a=structuredClone(fakeApi);a.task.containerDefinitions[0].secrets.push(a.task.containerDefinitions[0].secrets[0]);assert.throws(()=>api.buildTaskDefinition(a,{},release));
  const b=structuredClone(fakeApi);b.task.containerDefinitions[0].environmentFiles=[{value:'unit'}];assert.throws(()=>api.buildTaskDefinition(b,{},release));
});
await test('task normalization changes only environment order and refuses duplicates',()=>{
  const d=api.buildTaskDefinition(fakeApi,{},release), flipped=structuredClone(d);flipped.containerDefinitions[0].environment.reverse();
  assert.deepEqual(api.normalizeTaskEnvironment(d),api.normalizeTaskEnvironment(flipped));
  flipped.containerDefinitions[0].secrets.reverse();assert.notDeepEqual(api.normalizeTaskEnvironment(d),api.normalizeTaskEnvironment(flipped));
  flipped.containerDefinitions[0].environment.push(flipped.containerDefinitions[0].environment[0]);assert.throws(()=>api.normalizeTaskEnvironment(flipped));
});
function frame({owner={kind:'meri-controlled-read-setup-plan',version:1,liveAcceptance:'NOT_RUN',planSha256:'a'.repeat(64)},mode='plan',bytes=null}={}){
  const b=bytes??Buffer.from(JSON.stringify(owner)+'\n'),encoded=b.toString('base64');
  const meta={version:1,kind:'case20-native-setup-json',mode,sourceSha:api.SOURCE,inputSha256:api.INPUT_SHA256,scriptSha256:innerHash,
    captureRunId:api.RUN,outputPath:`/dev/shm/case20-native-setup-${mode}-owner.json`,byteLength:b.length,base64Length:encoded.length,chunks:Math.ceil(encoded.length/8192),sha256:hash(b),childExitCode:0,childSignal:null,ownerOutput:'OWNER_SUCCESS'};
  return [{phase:'BEGIN',...meta},...Array.from({length:meta.chunks},(_,i)=>({phase:'CHUNK',index:i+1,sha256:meta.sha256,data:encoded.slice(i*8192,(i+1)*8192)})),{phase:'END',...meta}];
}
const binding={mode:'plan',innerScriptSha256:innerHash,outputPath:'/dev/shm/case20-native-setup-plan-owner.json'};
await test('complete exact owner byte transport and incomplete log-lag handling',()=>{
  const f=frame();assert.equal(api.verifyReceiptBytes(f,binding).successful,true);assert.equal(api.verifyReceiptBytes([],binding).complete,false);
  assert.equal(api.verifyReceiptBytes(f.slice(0,1),binding).complete,false);
});
await test('failure alongside complete transport retains bytes but never success',()=>{
  const f=frame();f.push({phase:'FAILURE'});const r=api.verifyReceiptBytes(f,binding);assert.equal(r.complete,true);assert.equal(r.successful,false);assert.ok(r.bytes.length);
});
await test('invalid native owner JSON remains exact raw evidence, never success',()=>{
  const r=api.verifyReceiptBytes(frame({bytes:Buffer.from('not JSON\n')}),binding);assert.equal(r.complete,true);assert.equal(r.successful,false);assert.equal(r.bytes.toString(),'not JSON\n');
});
for(const [name,mutate] of [
  ['unknown receipt phase',f=>f.push({phase:'BOGUS'})],['duplicate start',f=>f.unshift(f[0])],
  ['wrong source',f=>{f[0].sourceSha='0'.repeat(40);f.at(-1).sourceSha='0'.repeat(40);}],
  ['wrong run',f=>{f[0].captureRunId='wrong';f.at(-1).captureRunId='wrong';}],
  ['wrong inner hash',f=>{f[0].scriptSha256='0'.repeat(64);f.at(-1).scriptSha256='0'.repeat(64);}],
  ['altered chunk',f=>f[1].data='A'+f[1].data.slice(1)],['wrong chunk index',f=>f[1].index=2],
]) await test(name+' refuses',()=>{const f=frame();mutate(f);assert.throws(()=>api.verifyReceiptBytes(f,binding));});
await test('exact task ARN/cluster/nonce binding refuses alien task',()=>{
  const value={taskArn:'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/'+'a'.repeat(32),taskDefinitionArn:'owned',clusterArn:'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev',startedBy:'nonce'};
  api.exactTaskArn(value,'owned',{startedBy:'nonce'},value.taskArn);
  assert.throws(()=>api.exactTaskArn({...value,clusterArn:'alien'},'owned',{startedBy:'nonce'},value.taskArn));
});

async function lifecycle(name,scenario,mode='plan'){
  accountingFiles={...accountingOriginal};
  if(scenario==='journal-before-register')accountingFiles['fresh-spend.jsonl']=Buffer.from('changed');
  const root=path.join(out,name);fs.mkdirSync(root);const calls=[];let definition,request,stopped=false,deregistered=false,logN=0,stopN=0;
  const td='arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-c2-case20-setup-20261003:9999';
  const arn='arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/'+'b'.repeat(32);
  const task=()=>({taskArn:arn,taskDefinitionArn:td,clusterArn:'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev',startedBy:request.startedBy,
    lastStatus:scenario==='stop-unknown'&&!stopN?'RUNNING':'STOPPED',containers:[{name:'case20-native-setup',image:release.services.api.image,imageDigest:release.services.api.image.split('@')[1],exitCode:0}]});
  const aws=args=>{calls.push(args.slice(0,2).join(':'));const key=args.slice(0,2).join(':');
    if(key==='ecs:describe-task-definition')return {taskDefinition:{...definition,taskDefinitionArn:td,status:deregistered?'INACTIVE':'ACTIVE'},tags:[]};
    if(key==='ecs:describe-tasks')return {tasks:[task()],failures:[]};
    if(key==='ecs:list-tasks')return {taskArns:args.includes('RUNNING')?[arn]:[]};
    if(key==='logs:get-log-events'){
      const f=frame(mode==='execute'?{mode,owner:{status:'CONTROLLED_READ_BOUND',liveAcceptance:'NOT_RUN'}}:{});let selected=f;logN++;
      if(scenario==='run-unknown-no-receipt')selected=[];
      if(scenario==='log-lag')selected=logN===1?f.slice(0,1):f.slice(1);
      return {events:selected.map(row=>({message:'C2_CASE20_NATIVE_SETUP_RECEIPT '+JSON.stringify(row)})),nextForwardToken:'token'+logN};
    }
    throw Error('UNEXPECTED_FAKE_READ_'+key);
  };
  const mutation=args=>{calls.push(args.slice(0,2).join(':'));const key=args.slice(0,2).join(':');
    if(key==='ecs:register-task-definition'){
      definition=JSON.parse(fs.readFileSync(path.join(root,'task-definition-request.private.json'),'utf8'));
      assert.deepEqual(definition.containerDefinitions[0].entryPoint,['/usr/bin/dumb-init','--','node','--input-type=module','-e']);
      assert.ok(definition.containerDefinitions[0].command[0].includes('case20-native-setup-inner.mjs'));
      if(scenario==='journal-before-run')accountingFiles['fresh-spend.jsonl']=Buffer.from('changed');
      if(scenario==='register-unknown')throw Error('UNIT_UNKNOWN_REGISTRATION');return {taskDefinition:{...definition,taskDefinitionArn:td}};
    }
    if(key==='ecs:run-task'){
      request=JSON.parse(fs.readFileSync(path.join(root,'run-task-input.private.json'),'utf8'));
      if(['run-unknown','run-unknown-no-receipt'].includes(scenario))throw Error('UNIT_UNKNOWN_RUN');return {tasks:[task()],failures:[]};
    }
    if(key==='ecs:stop-task'){stopN++;if(scenario==='stop-unknown')throw Error('UNIT_UNKNOWN_STOP');return {task:task()};}
    if(key==='ecs:deregister-task-definition'){deregistered=true;if(scenario==='deregister-unknown')throw Error('UNIT_UNKNOWN_DEREGISTER');return {taskDefinition:{taskDefinitionArn:td,status:'INACTIVE'}};}
    throw Error('UNEXPECTED_FAKE_MUTATION_'+key);
  };
  const snapshots={};for(const service of ['api','meriv2-orchestrator']){const r=release.services[service];snapshots[service]={
    service:{serviceName:'capiro-dev-'+service,taskDefinition:r.receipt.candidateTaskDefinition},
    baseline:{taskDefinitionArn:r.receipt.candidateTaskDefinition,taskHash:r.receipt.candidateTaskHash,configHash:r.receipt.configHash,imageDigest:r.image.split('@')[1]},
    task:{containerDefinitions:[{name:service,image:r.image,environment:[{name:'RELEASE_SHA',value:api.SOURCE}]}]}};}
  const local={inputSha256:api.INPUT_SHA256,innerScriptSha256:innerHash,outerScriptSha256:sourceHash,runtimeSources:{},checkpointBytesSha256:'0'.repeat(64),checkpoint:structuredClone(accountingCheckpoint)};
  const inputBytes=Buffer.from('{}');
  const result=await api.runNativeTask({aws,awsSingleAttempt:mutation,operator:{snapshot:async service=>{
    if(scenario==='post-drift')throw Error('UNIT_SERVICE_DRIFT');return snapshots[service];}},mode,root,local,release,
    packetGate:{approvalSha256:'a'.repeat(64)},liveApi:fakeApi,definitionInput:api.buildTaskDefinition(fakeApi,local,release),
    innerBytes,inputBytes,ownerInput:{},priorPlan:null,validateOwnerReceipt:owner=>mode==='plan'?assert.equal(owner.kind,'meri-controlled-read-setup-plan'):assert.equal(owner.status,'CONTROLLED_READ_BOUND'),
    policyTaskInput:input=>{const {taskDefinitionArn,status,tags,...value}=input;return value;}});
  assert.equal(calls.filter(c=>c==='ecs:register-task-definition').length,scenario==='journal-before-register'?0:1);
  assert.equal(calls.filter(c=>c==='ecs:run-task').length,['register-unknown','journal-before-register','journal-before-run'].includes(scenario)?0:1);
  assert.equal(result.status,['happy','log-lag'].includes(scenario)?(mode==='plan'?'PLAN_ONLY':'SETUP_ONLY_COMPLETE'):'BLOCKED_OR_UNCERTAIN_RECONCILE_BEFORE_ANOTHER_ACTION');
  assert.equal(result.automaticRetryAllowed,false);
  if(!['register-unknown','journal-before-register'].includes(scenario)){
    assert.equal(calls.filter(c=>c==='ecs:deregister-task-definition').length,1);
    assert.equal(result.cleanup.taskStopped,scenario!=='journal-before-run');assert.equal(result.cleanup.taskDefinitionInactive,true);
    assert.equal(fs.existsSync(path.join(root,'inner-owner-receipt.json')),!['run-unknown-no-receipt','journal-before-run'].includes(scenario));
  }
  assert.ok(fs.existsSync(path.join(root,'result.json')));
  if(mode==='execute'){
    const expected=['register-unknown','journal-before-register','journal-before-run'].includes(scenario)?'UNCHANGED_BEFORE_DISPATCH':scenario==='run-unknown-no-receipt'?'NOT_PROVED':'CLEARED_BY_EXISTING_NATIVE_OWNER';
    assert.equal(result.priorBudgetQualification,expected);
  }
  accountingFiles={...accountingOriginal};
  return {scenario,calls: calls.length,status:result.status};
}
for(const scenario of ['happy','log-lag','register-unknown','run-unknown','stop-unknown','deregister-unknown','post-drift'])
  await test('injected local lifecycle '+scenario,()=>lifecycle(scenario,scenario));

for(const scenario of ['happy','register-unknown','run-unknown-no-receipt','journal-before-register','journal-before-run'])
  await test('execute clearance and current-accounting fence '+scenario,()=>lifecycle('execute-'+scenario,scenario,'execute'));

const summary={kind:'LOCAL_ONLY_CASE20_DRAFT_QUALIFICATION',sourceSha256:sourceHash,innerSha256:innerHash,
  pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length,results,
  limits:['Dispatcher main was never imported or executed. Only source declarations were extracted and named functions called.',
    'AWS clients, service snapshots and canonical-owner result checking are injected local fakes in lifecycle scenarios.',
    'No cloud, auth, provider, DB/fixture or live journal calls; local scratch files only. No actual plan, approval or promotion artifact was minted.',
    'These tests do not qualify a real AWS deployment, the packaged CLI/database owner, actual human approval, or a live setup result.']};
fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({pass:summary.pass,fail:summary.fail,receipt:path.join(out,'receipt.json')}));
if(summary.fail)process.exitCode=1;
