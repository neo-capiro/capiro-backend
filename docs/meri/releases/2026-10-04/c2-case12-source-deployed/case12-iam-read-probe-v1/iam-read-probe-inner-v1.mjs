import assert from 'node:assert/strict';
import {ECSClient,DescribeTasksCommand,DescribeTaskDefinitionCommand} from '@aws-sdk/client-ecs';
const SOURCE='e60f37189f8c9b68ab7d5ef66e515ed3be4ec3c1';
const IMAGE='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:202832655633f906dec412ca088a7263e8e8065cd9a602402d98e5d2b092fe22';
const ROLE='arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ';
const CLUSTER='arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev';
const FAMILY='capiro-dev-meri-c2-case12-iam-probe-20261004',NAME='meri-c12-iam-read-probe',TAG='meri-case12-setup-owner';
const PREFIX='MERI_CASE12_IAM_READ_PROBE ',LIMIT=128*1024;
function tag(rows,marker){assert.ok(Array.isArray(rows));assert.equal(new Set(rows.map(r=>r.key)).size,rows.length);assert.equal(rows.filter(r=>r.key===TAG&&r.value===marker).length,1);}
async function boundedJson(response){assert.equal(response.status,200);assert.ok(response.body);const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=LIMIT);chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export async function probe(){
 assert.ok(Date.now()<Date.parse('2026-10-04T21:00:00Z'));const marker=process.env.MERI_C12_IAM_MARKER;assert.equal(typeof marker,'string');assert.match(marker,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
 assert.equal(process.env.GIT_SHA,SOURCE);assert.equal(process.env.RELEASE_SHA,SOURCE);
 for(const key of Object.keys(process.env))assert.ok(!key.startsWith('AWS_ENDPOINT_URL'),'ENDPOINT_OVERRIDE');
 const url=new URL(process.env.ECS_CONTAINER_METADATA_URI_V4??'');assert.equal(url.protocol,'http:');assert.equal(url.hostname,'169.254.170.2');assert.ok(!url.port&&!url.username&&!url.password&&!url.search&&!url.hash);assert.match(url.pathname,/^\/v4\/[a-zA-Z0-9_-]+$/u);
 const meta=await boundedJson(await fetch(url.href+'/task',{signal:AbortSignal.timeout(3000),redirect:'error'}));assert.equal(meta.Cluster,CLUSTER);assert.equal(meta.Family,FAMILY);assert.ok((typeof meta.Revision==='string'&&meta.Revision.length>0)||(Number.isSafeInteger(meta.Revision)&&meta.Revision>0));assert.match(String(meta.Revision),/^[1-9][0-9]*$/u);assert.equal(typeof meta.TaskARN,'string');assert.match(meta.TaskARN,/^arn:aws:ecs:us-east-1:967807252336:task\/capiro-dev\/[a-f0-9]{32}$/u);
 assert.equal(meta.Containers?.length,1);assert.equal(meta.Containers[0].Name,NAME);assert.equal(meta.Containers[0].Image,IMAGE);
 const client=new ECSClient({region:'us-east-1',maxAttempts:1,ignoreConfiguredEndpointUrls:true});
 try{
  const taskResult=await client.send(new DescribeTasksCommand({cluster:CLUSTER,tasks:[meta.TaskARN],include:['TAGS']}),{abortSignal:AbortSignal.timeout(8000)});
  assert.equal(taskResult.failures?.length??0,0);assert.equal(taskResult.tasks?.length,1);const task=taskResult.tasks[0];assert.equal(task.taskArn,meta.TaskARN);assert.equal(task.clusterArn,CLUSTER);assert.equal(task.launchType,'FARGATE');assert.equal(task.group,'family:'+FAMILY);assert.equal(task.startedBy,'c12-'+marker.replaceAll('-',''));tag(task.tags,marker);
  assert.equal(task.containers?.length,1);assert.equal(task.containers[0].name,NAME);assert.equal(task.containers[0].image,IMAGE);assert.equal(task.containers[0].imageDigest,IMAGE.split('@')[1]);
  const td='arn:aws:ecs:us-east-1:967807252336:task-definition/'+FAMILY+':'+meta.Revision;assert.equal(task.taskDefinitionArn,td);
  const definitionResult=await client.send(new DescribeTaskDefinitionCommand({taskDefinition:td,include:['TAGS']}),{abortSignal:AbortSignal.timeout(8000)});const d=definitionResult.taskDefinition;assert.equal(d?.taskDefinitionArn,td);assert.equal(d.status,'ACTIVE');assert.equal(d.family,FAMILY);assert.equal(d.taskRoleArn,ROLE);assert.equal(d.networkMode,'awsvpc');assert.deepEqual(d.requiresCompatibilities,['FARGATE']);assert.equal(d.runtimePlatform?.cpuArchitecture,'ARM64');tag(definitionResult.tags,marker);
  assert.equal(d.containerDefinitions?.length,1);const c=d.containerDefinitions[0];assert.equal(c.name,NAME);assert.equal(c.image,IMAGE);assert.equal(c.secrets?.length??0,0);assert.equal(c.logConfiguration?.secretOptions?.length??0,0);assert.deepEqual(c.entryPoint,['node','--input-type=module','--eval']);assert.equal(c.command?.length,1);assert.equal(typeof c.command[0],'string');
  assert.ok(Array.isArray(c.environment));assert.equal(new Set(c.environment.map(e=>e.name)).size,c.environment.length);const env=Object.fromEntries(c.environment.map(e=>[e.name,e.value]));assert.deepEqual(Object.keys(env).sort(),['AWS_DEFAULT_REGION','AWS_MAX_ATTEMPTS','AWS_REGION','GIT_SHA','MERI_C12_IAM_MARKER','RELEASE_SHA']);assert.equal(env.GIT_SHA,SOURCE);assert.equal(env.RELEASE_SHA,SOURCE);assert.equal(env.MERI_C12_IAM_MARKER,marker);assert.equal(env.AWS_REGION,'us-east-1');assert.equal(env.AWS_DEFAULT_REGION,'us-east-1');assert.equal(env.AWS_MAX_ATTEMPTS,'1');
  return {kind:'meri-case12-iam-read-probe',version:1,status:'ACTUAL_SELF_ECS_READS_SUCCEEDED',sourceSha:SOURCE,image:IMAGE,taskArn:task.taskArn,taskDefinitionArn:td,taskRoleArn:ROLE,registrationMarker:marker,metadataV4:true,sdkCommands:['DescribeTasks','DescribeTaskDefinition'],maxAttempts:1,dbSecrets:0,providerSecrets:0,setupExecuted:false,nativeAdmissionQualified:false,captureAuthority:false,liveAcceptance:'NOT_RUN'};
 }finally{client.destroy();}
}
try{const result=await probe();const line=JSON.stringify(result);assert.ok(Buffer.byteLength(line)<4096);console.log(PREFIX+line);}catch{console.log(PREFIX+JSON.stringify({kind:'meri-case12-iam-read-probe',version:1,status:'FAILED',code:'CASE12_IAM_READ_PROBE_FAILED',captureAuthority:false,liveAcceptance:'NOT_RUN'}));process.exitCode=1;}
