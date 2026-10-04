import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as diskRead} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
const base='C:/dev/main/outputs/meri-c2-20261003';
const source=diskRead(base+'/run-case14-native-owner-read-v1.mjs','utf8').replace(/^import .*;\r?\n/gm,'');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const fn=new AsyncFunction('readFileSync','writeFileSync','mkdirSync','createHash','randomUUID','assert','aws','awsSingleAttempt','setTimeout','console',source);
const image='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:23f529da3c1c00d401968811575dc075bced6c60669baa9a09e9c23575c9c452';
async function scenario(mode){
 const saved=new Map();let definition,request,stops=0,launches=0,logReads=0;
 const td='arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-c2-case14-owner-read-20261003:1',arn='arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
 const live={image,environment:[{name:'RELEASE_SHA',value:'4f0253874357c272fda1ae2a5271ee4af645f0bc'},...['MEMORY_CLIENT_REVIEW','MEMORY_GOVERNANCE_LIFECYCLE','MEMORY_GOVERNANCE_ENFORCE','MEMORY_GOVERNANCE_CENTER'].map(name=>({name,value:'enforce'})),{name:'MERI_SYNTHETIC_FIXTURE_NAMESPACE',value:'meri-foundation-20260928'}]};
 const task=()=>({taskArn:arn,taskDefinitionArn:td,startedBy:request?.startedBy,lastStatus:mode==='lost-found'&&stops===0?'RUNNING':'STOPPED',containers:[{image,imageDigest:image.split('@')[1],exitCode:0}]});
 const result={status:'CANONICAL_OWNER_ABSENT',transactionRolledBack:true,providerCalls:0,businessWrites:0,acceptanceAuthority:false};
 const bytes=Buffer.from(JSON.stringify(result)+'\n'),meta={sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,chunks:1};
 const messages=[{phase:'BEGIN',...meta},{phase:'CHUNK',index:0,data:bytes.toString('base64')},{phase:'END',...meta}].map((v,i)=>({timestamp:i,ingestionTime:i,message:'C2_CASE14_NATIVE_READ '+JSON.stringify(v)}));
 const aws=args=>{
  const action=args[1];
  if(action==='describe-services')return {services:[{taskDefinition:'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:521',deployments:[{rolloutState:'COMPLETED'}],runningCount:2,pendingCount:0,networkConfiguration:{},platformVersion:'1.4.0'}]};
  if(action==='get-caller-identity')return {Account:'967807252336',Arn:'arn:aws:iam::967807252336:user/capirocli'};
  if(action==='describe-task-definition')return {taskDefinition:{containerDefinitions:[live]}};
  if(action==='describe-tasks')return {tasks:[task()],failures:[]};
  if(action==='list-tasks')return {taskArns:mode==='lost-found'?[arn]:[]};
  if(action==='get-log-events'){logReads++;return {events:logReads===1?messages.slice(0,2):messages,nextForwardToken:logReads===1?'first':'done'};}
  throw new Error('UNEXPECTED_READ_'+action);
 };
 const single=args=>{
  const action=args[1],path=args.at(-1).replace(/^file:\/\//,'');
  if(action==='register-task-definition'){if(mode==='registration-lost')throw new Error('LOST');definition=JSON.parse(saved.get(path));return {taskDefinition:{...definition,taskDefinitionArn:td}};}
  if(action==='run-task'){launches++;request=JSON.parse(saved.get(path));if(mode.startsWith('lost'))throw new Error('LOST');return {failures:[],tasks:[task()]};}
  if(action==='stop-task'){stops++;return {};}
  if(action==='deregister-task-definition')return {taskDefinition:{status:'INACTIVE'}};
  throw new Error('UNEXPECTED_MUTATION_'+action);
 };
 let error;
 try{await fn((p,enc)=>saved.has(p)?saved.get(p):diskRead(p,enc),(p,b)=>{assert.equal(saved.has(p),false);saved.set(p,b);},()=>{},createHash,randomUUID,assert,aws,single,(f)=>{f();return 1;},{log:()=>{}});}catch(e){error=e;}
 const cleanup=JSON.parse([...saved].find(([p])=>p.endsWith('/cleanup.json'))?.[1]??'null');
 return {error,cleanup,launches,stops,saved};
}
test('happy path deduplicates repeated transport events and confirms cleanup',async()=>{const r=await scenario('happy');assert.ifError(r.error);assert.equal(r.cleanup.cleanupComplete,true);assert.equal(r.launches,1);});
test('uncertain run acknowledgment discovers/stops exact task, preserves failure',async()=>{const r=await scenario('lost-found');assert.ok(r.error);assert.equal(r.cleanup.cleanupComplete,true);assert.equal(r.stops,1);assert.equal(r.launches,1);});
test('uncertain run with no match cannot claim cleanup complete',async()=>{const r=await scenario('lost-missing');assert.ok(r.error);assert.equal(r.cleanup.cleanupComplete,false);assert.equal(r.launches,1);});
test('uncertain registration cannot claim cleanup complete or launch a task',async()=>{const r=await scenario('registration-lost');assert.ok(r.error);assert.equal(r.cleanup.cleanupComplete,false);assert.equal(r.launches,0);});
