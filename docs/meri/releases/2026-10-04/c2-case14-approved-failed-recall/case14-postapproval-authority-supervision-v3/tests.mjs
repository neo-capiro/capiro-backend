// Codex offline supervision: no cloud calls or native child CLI execution.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {input as priorInput,now,nativeMock,projectMock} from './reviewed-sequence-fixture.mjs';
import {sequence} from '../case14-postapproval-preparation-v2/case14-postapproval-inner-v2.mjs';
import {sha256Bytes,sha256Stable} from '../../../meri-c1-20261002/evals/meri/live-v1/artifact-collector.mjs';
import {inspectCase14PostApprovalTask,inspectCase14PostApprovalReceipts,currentCase14PostApprovalTaskAuthority,readCase14PostApprovalTaskAuthority} from '../../../meri-c1-20261002/evals/meri/live-v1/case14-postapproval-task-authority.mjs';
import {claimCase14PostApprovalSetup,currentCase14PostApprovalSpendScope,bindCase14PostApprovalSetup} from '../../../meri-c1-20261002/evals/meri/live-v1/capture-spend-aggregate.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const source='c0f393f863bf73bd4e65e7a94e17c073e7be021e',image='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:024fcc82a2db7701f4a3e3311598a9a1d0933b3fe4fcf73751bf0e3fb866d8ce';
const taskArn='arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/'+ 'a'.repeat(32),definitionArn='arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-c2-case14-postapproval-20261004:91';
const approval={captureRunId:priorInput.captureRunId,apiSha:source,webSha:source,reviewer:priorInput.ctx,after:{fixtureEvidence:priorInput.approvedOwner}};
const input={...structuredClone(priorInput),approvalEvidenceSha256:sha256Stable(approval)};
const bytes=Buffer.from(JSON.stringify(input)+'\n'),inputByteSha256=sha256Bytes(bytes);
const scope={captureRunId:input.captureRunId,approvalWindow:input.approvalWindow,maxCostMicros:14000000,approvalBoundSha256:'c'.repeat(64)};
const raw=JSON.parse(readFileSync(root+'/corpus-read-definition-input.json','utf8'));
delete raw.taskRoleArn;raw.taskDefinitionArn=definitionArn;raw.family='capiro-dev-meri-c2-case14-postapproval-20261004';raw.status='INACTIVE';
const container=raw.containerDefinitions[0];container.image=image;container.entryPoint=['/usr/bin/dumb-init','--','node','--input-type=module','-e'];container.command=[readFileSync(root+'/case14-postapproval-preparation-v2/case14-postapproval-inner-v2.mjs','utf8')];
const env=new Map(container.environment.map(x=>[x.name,x.value]));for(const[k,v]of Object.entries({GIT_SHA:source,RELEASE_SHA:source,MERI_SYNTHETIC_FIXTURE_NAMESPACE:'meri-foundation-20260928',C2_CASE14_POSTAPPROVAL_INPUT_B64:bytes.toString('base64'),C2_CASE14_POSTAPPROVAL_INPUT_SHA256:inputByteSha256}))env.set(k,v);container.environment=[...env].map(([name,value])=>({name,value}));
const task={taskArn,taskDefinitionArn:definitionArn,createdAt:new Date(now-500).toISOString(),startedAt:new Date(now-400).toISOString(),stoppedAt:new Date(now+10000).toISOString(),lastStatus:'STOPPED',desiredStatus:'STOPPED',startedBy:'meri-c2-receipt-synthetic',overrides:{containerOverrides:[]},containers:[{name:container.name,image,imageDigest:image.split('@')[1],exitCode:0}]};
const taskPacket={task,definition:raw,approval,scope};
const receipts=[];await sequence(input,nativeMock,x=>receipts.push({sourceSha:source,inputByteSha256,...x}),()=>now,projectMock);
const packet={receipts,input,inputByteSha256};
const passed=[],accepted=[];
async function check(name,fn){await fn();passed.push(name);console.log('PASS '+name);}
function rejectTask(name,mutate){return check(name,()=>{const p=structuredClone(taskPacket);mutate(p);assert.throws(()=>inspectCase14PostApprovalTask(p));});}
function rejectReceipt(name,mutate){return check(name,()=>{const p=structuredClone(packet);mutate(p);assert.throws(()=>inspectCase14PostApprovalReceipts(p));});}
await check('positive exact native task/input/source comparison',()=>{const result=inspectCase14PostApprovalTask(taskPacket);assert.deepEqual(result.input,input);assert.equal(result.inputByteSha256,inputByteSha256);assert.equal(result.logStream.split('/').at(-1),'a'.repeat(32));});
await check('positive actual mocked sequence receipts and terminal proof',()=>{const value=inspectCase14PostApprovalReceipts(packet);assert.equal(value.status,'RECALL_BOUND_AND_BUDGET_INSTALLED');assert.equal(value.results['projection-terminal'].outbox.attempts,0);assert.equal(value.results['budget-install'].maxCostMicros,14000000);});
for(const[name,mutate]of[
 ['reject wrong task scope',p=>{p.task.taskArn=p.task.taskArn.replace('967807252336','111111111111');}],
 ['reject task/definition mismatch',p=>{p.task.taskDefinitionArn+='1';}],
 ['reject nonzero native exit',p=>{p.task.containers[0].exitCode=1;}],
 ['reject running native task',p=>{p.task.lastStatus='RUNNING';}],
 ['reject wrong digest',p=>{p.task.containers[0].imageDigest='sha256:'+'0'.repeat(64);}],
 ['reject changed inner source',p=>{p.definition.containerDefinitions[0].command[0]+='\n//modified';}],
 ['reject changed entrypoint',p=>{p.definition.containerDefinitions[0].entryPoint=['sh','-c'];}],
 ['reject task command override',p=>{p.task.overrides.containerOverrides=[{name:'api',command:['evil']}];}],
 ['reject task env override',p=>{p.task.overrides.containerOverrides=[{name:'api',environment:[{name:'GIT_SHA',value:'wrong'}]}];}],
 ['reject task role override',p=>{p.task.overrides.taskRoleArn='arn:aws:iam::967807252336:role/other';}],
 ['reject provider secret',p=>{p.definition.containerDefinitions[0].secrets.push({name:'OPENAI_API_KEY',valueFrom:'fake'});}],
 ['reject task role',p=>{p.definition.taskRoleArn='arn:aws:iam::967807252336:role/other';}],
 ['reject duplicate environment',p=>{p.definition.containerDefinitions[0].environment.push({...p.definition.containerDefinitions[0].environment[0]});}],
 ['reject raw provider key environment',p=>{p.definition.containerDefinitions[0].environment.push({name:'OPENAI_API_KEY',value:'synthetic'});}],
 ['reject input byte hash drift',p=>{p.definition.containerDefinitions[0].environment.find(x=>x.name==='C2_CASE14_POSTAPPROVAL_INPUT_SHA256').value='0'.repeat(64);}],
 ['reject reserialized capture scope swap',p=>{p.scope.captureRunId='66666666-6666-4666-8666-666666666666';}],
 ['reject approval owner swap',p=>{p.approval.after.fixtureEvidence.item.id='66666666-6666-4666-8666-666666666666';}],
 ['reject mismatched reservation window',p=>{p.scope.approvalWindow.deadlineAtMs+=1;}],
 ['reject stopped after window',p=>{p.task.stoppedAt=new Date(p.scope.approvalWindow.deadlineAtMs+1).toISOString();}],
])await rejectTask(name,mutate);
function changeInput(p,fn){const rows=p.definition.containerDefinitions[0].environment,i=JSON.parse(Buffer.from(rows.find(x=>x.name==='C2_CASE14_POSTAPPROVAL_INPUT_B64').value,'base64'));fn(i);const b=Buffer.from(JSON.stringify(i)+'\n');rows.find(x=>x.name==='C2_CASE14_POSTAPPROVAL_INPUT_B64').value=b.toString('base64');rows.find(x=>x.name==='C2_CASE14_POSTAPPROVAL_INPUT_SHA256').value=sha256Bytes(b);}
await rejectTask('reject rehashed wrong recall ceiling',p=>changeInput(p,i=>{i.limits.maxCostMicros=15000000;}));
await rejectTask('reject rehashed wrong reviewed rates',p=>changeInput(p,i=>{i.rateEvidence.rates[0].inputMicrosPerMillion=1;}));
for(const[name,mutate]of[
 ['reject missing native receipt',p=>{p.receipts=p.receipts.filter(x=>!(x.phase==='RECEIPT'&&x.stage==='recall-bind'));}],
 ['reject duplicate native receipt',p=>{p.receipts.push(structuredClone(p.receipts.find(x=>x.phase==='RECEIPT')));}],
 ['reject missing COMPLETE',p=>{p.receipts=p.receipts.filter(x=>x.phase!=='COMPLETE');}],
 ['reject duplicate COMPLETE',p=>{p.receipts.push(structuredClone(p.receipts.find(x=>x.phase==='COMPLETE')));}],
 ['reject explicit failure',p=>{p.receipts.push({sourceSha:source,inputByteSha256,phase:'FAILURE'});}],
 ['reject wrong framed input hash',p=>{p.receipts[0].inputByteSha256='0'.repeat(64);}],
 ['reject changed receipt bytes',p=>{p.receipts.find(x=>x.phase==='RECEIPT').data=Buffer.from('{}').toString('base64');}],
 ['reject missing terminal verification',p=>{p.receipts=p.receipts.filter(x=>!(x.phase==='VERIFIED'&&x.stage==='projection-terminal'));}],
 ['reject reordered verification',p=>{const ids=p.receipts.flatMap((x,i)=>x.phase==='VERIFIED'?[i]:[]);[p.receipts[ids[0]],p.receipts[ids[1]]]=[p.receipts[ids[1]],p.receipts[ids[0]]];}],
 ['reject foreign complete scope',p=>{p.receipts.find(x=>x.phase==='COMPLETE').value.captureRunId='66666666-6666-4666-8666-666666666666';}],
 ['reject unknown result proof',p=>{p.receipts.find(x=>x.phase==='COMPLETE').value.results['projection-terminal']={status:'PASS'};}],
])await rejectReceipt(name,mutate);
await rejectReceipt('reject wrong native installed ceiling after consistent receipt rehash',p=>{const r=p.receipts.find(x=>x.phase==='RECEIPT'&&x.stage==='budget-install'),v=JSON.parse(Buffer.from(r.data,'base64'));v.maxCostMicros=15000000;const b=Buffer.from(JSON.stringify(v)+'\n');r.data=b.toString('base64');r.bytes=b.length;r.sha256=sha256Bytes(b);p.receipts.find(x=>x.phase==='VERIFIED'&&x.stage==='budget-install').receiptSha256=r.sha256;p.receipts.find(x=>x.phase==='COMPLETE').value.results['budget-install']=v;});
await check('forged completed-setup JSON cannot mint WeakMap authority',()=>{assert.throws(()=>currentCase14PostApprovalTaskAuthority({kind:'meri-case14-owned-postapproval-task',captureRunId:scope.captureRunId,proofSha256:sha256Stable(packet)}, {}, {}));});
await check('forged setup reservation/outcome rejected before dispatcher',()=>{assert.throws(()=>claimCase14PostApprovalSetup({captureRunId:scope.captureRunId},approval));assert.throws(()=>currentCase14PostApprovalSpendScope({},approval));assert.throws(()=>bindCase14PostApprovalSetup({},approval,{}));});
await check('forged native factory arguments reject before any AWS call',async()=>{await assert.rejects(()=>readCase14PostApprovalTaskAuthority({spendReservation:{},approvalOutcome:approval,taskArn}));});
// These are evidence probes, not passing safety assertions. A newly tightened
// source changes them from accepted to rejected without weakening other tests.
for(const[name,mutate]of[
 ['active definition after claimed cleanup',p=>{p.definition.status='ACTIVE';}],
 ['foreign DB secret ARN with same name',p=>{p.definition.containerDefinitions[0].secrets[0].valueFrom='arn:aws:secretsmanager:us-east-1:967807252336:secret:other-db';}],
 ['foreign execution role',p=>{p.definition.executionRoleArn='arn:aws:iam::967807252336:role/other';}],
 ['task started before approved window',p=>{p.task.createdAt='2026-10-03T00:00:00.000Z';p.task.startedAt=p.task.createdAt;}],
 ['foreign startedBy',p=>{p.task.startedBy='unrelated-dispatch';}],
]){const p=structuredClone(taskPacket);mutate(p);let accepts=true;try{inspectCase14PostApprovalTask(p);}catch{accepts=false;}if(accepts)accepted.push(name);console.log((accepts?'GAP_ACCEPTED ':'REJECTED ')+name);}
const sourceFile='C:/dev/main/meri-c1-20261002/evals/meri/live-v1/case14-postapproval-task-authority.mjs';
const report={kind:'case14-postapproval-native-authority-codex-offline-review',preparedBy:'Codex',observedAt:new Date().toISOString(),status:accepted.length?'PASS_NEGATIVE_TESTS_WITH_REPORTED_GAPS':'PASS',tests:passed.length,checks:passed,acceptedGapProbes:accepted,sourceAuthoritySha256:sha256Bytes(readFileSync(sourceFile)),outerSha256:sha256Bytes(readFileSync(root+'/execute-case14-postapproval-outer-v1.mjs')),fixture:'Synthetic sequence fixtures; no live authority minted',providerCalls:0,cloudCalls:0,databaseCalls:0,journalMutations:0};
writeFileSync(new URL('./report.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
