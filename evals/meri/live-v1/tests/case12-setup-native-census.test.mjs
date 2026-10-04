import test from 'node:test';
import assert from 'node:assert/strict';
import {case12SetupReservationHash as hash} from '../case12-setup-reservation-owner.mjs';
import {buildCase12SetupCensusReadPlan,buildCase12SetupDescribeTasksPlan,inspectCase12SetupCensus} from '../case12-setup-native-census.mjs';
// Synthetic JSON data only; no AWS transport or live target state is read.
function fixture(){
  const now=Date.parse('2026-10-04T12:00:00.000Z'),revision='a'.repeat(40),image='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:'+'b'.repeat(64),apiTd='arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:999';
  const nightlyTd='arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-memory-graph:999';
  const environment=[{name:'GIT_SHA',value:revision},{name:'RELEASE_SHA',value:revision},{name:'MERI_SYNTHETIC_FIXTURE_NAMESPACE',value:'meri-foundation-20260928'}];
  const nightlyInput={family:'capiro-dev-memory-graph',containerDefinitions:[{name:'worker',image:'synthetic-nightly-image'}]};
  const rule={Name:'capiro-dev-refresh-memory-graph',State:'ENABLED',ScheduleExpression:'cron(30 4 * * ? *)'};
  const target={Id:'synthetic-nightly',EcsParameters:{TaskDefinitionArn:nightlyTd}};
  const tasks=['1','2'].map(i=>({taskArn:'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/'+i.repeat(32),taskDefinitionArn:apiTd,group:'service:capiro-dev-api',desiredStatus:'RUNNING',lastStatus:'RUNNING',containers:[{image,imageDigest:image.split('@')[1]}],overrides:{containerOverrides:[]}}));
  const census={caller:{Account:'967807252336',Arn:'arn:aws:iam::967807252336:user/capirocli'},services:{services:[{serviceName:'capiro-dev-api',taskDefinition:apiTd,desiredCount:2,runningCount:2,pendingCount:0,deployments:[{status:'PRIMARY',rolloutState:'COMPLETED'}]}],failures:[]},definition:{taskDefinition:{taskDefinitionArn:apiTd,status:'ACTIVE',containerDefinitions:[{name:'api',image,environment}]}},rule,targets:{Targets:[target]},nightlyDefinition:{taskDefinition:{...nightlyInput,taskDefinitionArn:nightlyTd,status:'ACTIVE'},tags:[]},broadRule:{Name:'capiro-dev-memory-projection-worker',State:'DISABLED'},list:{taskArns:tasks.map(t=>t.taskArn)},tasks:{tasks,failures:[]}};
  const pins={apiTaskDefinition:apiTd,apiImage:image,apiEnvironmentSha256:hash(environment),sourceGitRevision:revision,ratesExpiresAt:new Date(now+3_600_000).toISOString(),nightly:{rule:rule.Name,taskDefinition:nightlyTd,ruleSha256:hash(rule),targetSha256:hash(target),taskInputSha256:hash(nightlyInput)}};
  return {census,pins,now,deadline:now+900_000};
}
test('native read plan is fixed scoped single-attempt command data with dependent exact task describe',()=>{
  const f=fixture(),plan=buildCase12SetupCensusReadPlan(f.pins);assert.equal(plan.length,8);
  for(const step of plan){assert.equal(step.executable,'C:/Program Files/Amazon/AWSCLIV2/aws.exe');assert.equal(step.environment.AWS_MAX_ATTEMPTS,'1');assert.ok(step.args.includes('capiro-dev'));assert.ok(step.args.includes('us-east-1'));assert.equal(Object.isFrozen(step.args),true);}
  const describe=buildCase12SetupDescribeTasksPlan(f.census.list);assert.deepEqual(describe.args.slice(0,5),['ecs','describe-tasks','--cluster','capiro-dev','--tasks']);
  assert.ok(plan.find(p=>p.key==='targets').args.includes('--no-paginate'));
});
test('matching synthetic observations produce only immutable inspection facts',()=>{
  const f=fixture(),out=inspectCase12SetupCensus(f.census,f.pins,f.deadline,f.now);assert.equal(out.censusSha256,hash(f.census));assert.equal(out.apiTasks.length,2);assert.equal(out.captureAuthority,undefined);assert.equal(out.ready,undefined);
});
for(const [name,mutate] of [
  ['wrong account',f=>f.census.caller.Account='000000000000'],
  ['wrong principal',f=>f.census.caller.Arn='arn:aws:iam::967807252336:user/capiro'],
  ['API image drift',f=>f.census.definition.taskDefinition.containerDefinitions[0].image+='foreign'],
  ['API environment drift',f=>f.census.definition.taskDefinition.containerDefinitions[0].environment[0].value='c'.repeat(40)],
  ['task command override',f=>f.census.tasks.tasks[0].overrides.containerOverrides=[{name:'api',command:['foreign']}]],
  ['task envfile override',f=>f.census.tasks.tasks[0].overrides.containerOverrides=[{name:'api',environmentFiles:[{value:'foreign'}]}]],
  ['task role override',f=>f.census.tasks.tasks[0].overrides.taskRoleArn='foreign'],
  ['paginated task list',f=>f.census.list.nextToken='next'],
  ['duplicate task list',f=>f.census.list.taskArns[1]=f.census.list.taskArns[0]],
  ['foreign task ARN',f=>f.census.list.taskArns[0]=f.census.list.taskArns[0].replace('967807252336','111111111111')],
  ['missing described task',f=>f.census.tasks.tasks.pop()],
  ['uncertain describe failure',f=>f.census.tasks.failures=[{reason:'MISSING'}]],
  ['service deployment overlap',f=>f.census.services.services[0].deployments.push({status:'ACTIVE',rolloutState:'IN_PROGRESS'})],
  ['broad worker enabled',f=>f.census.broadRule.State='ENABLED'],
  ['target drift',f=>f.census.targets.Targets[0].Id='foreign'],
  ['nightly definition drift',f=>f.census.nightlyDefinition.taskDefinition.containerDefinitions[0].image='foreign'],
  ['expired rates',f=>f.pins.ratesExpiresAt=new Date(f.now-1).toISOString()],
  ['relevant pending standalone overlap',f=>{const t={...structuredClone(f.census.tasks.tasks[0]),taskArn:'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/'+'3'.repeat(32),taskDefinitionArn:'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-owned:1',group:'family:capiro-dev-meri-owned',lastStatus:'PROVISIONING'};f.census.tasks.tasks.push(t);f.census.list.taskArns.push(t.taskArn);}],
])test(`native census rejects ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>inspectCase12SetupCensus(f.census,f.pins,f.deadline,f.now),/CASE12_NATIVE_CENSUS_UNPROVED/);});
test('native census rejects provider window crossing the nightly schedule clearance',()=>{const f=fixture();f.now=Date.parse('2026-10-05T04:20:00.000Z');f.deadline=f.now+900_000;f.pins.ratesExpiresAt=new Date(f.now+3_600_000).toISOString();assert.throws(()=>inspectCase12SetupCensus(f.census,f.pins,f.deadline,f.now));});
for(const [name,definition,group,startedBy] of [
  ['projection service task','arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-memory-projection-worker:1','service:capiro-dev-memory-projection-worker',undefined],
  ['nightly exact definition without starter',null,'family:capiro-dev-memory-graph',undefined],
  ['nightly exact definition with other starter',null,'service:unrelated','other-starter'],
  ['older nightly definition revision','arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-memory-graph:998','service:unrelated',undefined],
  ['extra API family under foreign group','arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:998','service:unrelated',undefined],
])test(`native census rejects ${name} independently of labels`,()=>{
  const f=fixture(),t={...structuredClone(f.census.tasks.tasks[0]),taskArn:'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/'+'4'.repeat(32),taskDefinitionArn:definition??f.pins.nightly.taskDefinition,group,...(startedBy?{startedBy}:{})};
  f.census.tasks.tasks.push(t);f.census.list.taskArns.push(t.taskArn);
  assert.throws(()=>inspectCase12SetupCensus(f.census,f.pins,f.deadline,f.now),/CASE12_NATIVE_CENSUS_UNPROVED/);
});
for(const field of ['apiTaskDefinition','apiImage','apiEnvironmentSha256','sourceGitRevision','nightly.taskDefinition','nightly.ruleSha256','nightly.targetSha256','nightly.taskInputSha256'])test(`native read plan rejects array-valued ${field}`,()=>{
  const f=fixture();if(field.startsWith('nightly.')){const key=field.split('.')[1];f.pins.nightly[key]=[f.pins.nightly[key]];}else f.pins[field]=[f.pins[field]];
  assert.throws(()=>buildCase12SetupCensusReadPlan(f.pins),/CASE12_NATIVE_CENSUS_UNPROVED/);
});
