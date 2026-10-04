import {case12SetupReservationHash as hash} from './case12-setup-reservation-owner.mjs';
const need=ok=>{if(!ok)throw Error('CASE12_NATIVE_CENSUS_UNPROVED');};
const HASH=/^[a-f0-9]{64}$/u;
const TD=/^arn:aws:ecs:us-east-1:967807252336:task-definition\/capiro-dev-[a-z0-9-]+:[1-9][0-9]*$/u;
const TASK=/^arn:aws:ecs:us-east-1:967807252336:task\/capiro-dev\/[a-f0-9]{32}$/u;
const API_IMAGE=/^967807252336\.dkr\.ecr\.us-east-1\.amazonaws\.com\/capiro\/dev\/api@sha256:[a-f0-9]{64}$/u;
const copy=structuredClone;
const textMatch=(v,re)=>typeof v==='string'&&re.test(v);
function pinsValid(p){
  need(p&&textMatch(p.apiTaskDefinition,TD)&&textMatch(p.apiImage,API_IMAGE)&&textMatch(p.apiEnvironmentSha256,HASH)&&textMatch(p.sourceGitRevision,/^[a-f0-9]{40}$/u));
  need(p.nightly&&p.nightly.rule==='capiro-dev-refresh-memory-graph'&&textMatch(p.nightly.taskDefinition,TD));
  for(const key of ['ruleSha256','targetSha256','taskInputSha256'])need(textMatch(p.nightly[key],HASH));
  need(typeof p.ratesExpiresAt==='string'&&Number.isFinite(Date.parse(p.ratesExpiresAt))&&new Date(p.ratesExpiresAt).toISOString()===p.ratesExpiresAt);
}
const cli=args=>Object.freeze({executable:'C:/Program Files/Amazon/AWSCLIV2/aws.exe',args:Object.freeze([...args,'--profile','capiro-dev','--region','us-east-1','--output','json','--no-cli-pager']),environment:Object.freeze({AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard'})});
/** Read-only command data, not a native caller or authority constructor. Root must
 * execute these through its fixed native AWS transport and authenticate all results. */
export function buildCase12SetupCensusReadPlan(pins){
  pinsValid(pins);return Object.freeze([
    ['caller',['sts','get-caller-identity']],
    ['services',['ecs','describe-services','--cluster','capiro-dev','--services','capiro-dev-api']],
    ['definition',['ecs','describe-task-definition','--task-definition',pins.apiTaskDefinition]],
    ['rule',['events','describe-rule','--name',pins.nightly.rule]],
    ['targets',['events','list-targets-by-rule','--rule',pins.nightly.rule,'--no-paginate']],
    ['nightlyDefinition',['ecs','describe-task-definition','--task-definition',pins.nightly.taskDefinition,'--include','TAGS']],
    ['broadRule',['events','describe-rule','--name','capiro-dev-memory-projection-worker']],
    ['list',['ecs','list-tasks','--cluster','capiro-dev','--desired-status','RUNNING','--no-paginate']],
  ].map(([key,args])=>Object.freeze({key,...cli(args)})));
}
function listValid(list){need(list&&!list.nextToken&&!list.NextToken&&Array.isArray(list.taskArns)&&list.taskArns.length>=2&&list.taskArns.length<=100&&list.taskArns.every(a=>typeof a==='string'&&TASK.test(a))&&new Set(list.taskArns).size===list.taskArns.length);}
export function buildCase12SetupDescribeTasksPlan(list){listValid(list);return cli(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...list.taskArns]);}
// Exact existing release taskInput writable/readonly boundary; no new normalization.
const writable=new Set(['family','taskRoleArn','executionRoleArn','networkMode','containerDefinitions','volumes','placementConstraints','requiresCompatibilities','cpu','memory','tags','pidMode','ipcMode','proxyConfiguration','inferenceAccelerators','ephemeralStorage','runtimePlatform','enableFaultInjection']);
const readonly=new Set(['taskDefinitionArn','revision','status','registeredAt','registeredBy','deregisteredAt','compatibilities','requiresAttributes']);
function taskInput(td){need(td&&typeof td==='object'&&!Array.isArray(td)&&Object.keys(td).every(k=>writable.has(k)||readonly.has(k)));const result=Object.fromEntries(Object.entries(td).filter(([k])=>writable.has(k)).map(([k,v])=>[k,copy(v)]));need(result.family&&Array.isArray(result.containerDefinitions)&&result.containerDefinitions.length);const tags=(result.tags??[]).filter(t=>!t.key.startsWith('aws:'));if(tags.length)result.tags=tags;else delete result.tags;return result;}
/** Pure inspection only. JSON passing this function is not cost authority. */
export function inspectCase12SetupCensus(census,pins,deadlineAtMs,nowMs=Date.now()){
  pinsValid(pins);need(Number.isSafeInteger(nowMs)&&Number.isSafeInteger(deadlineAtMs)&&deadlineAtMs>nowMs&&deadlineAtMs<=nowMs+86_400_000&&deadlineAtMs<=Date.parse(pins.ratesExpiresAt));
  const c=census;need(c?.caller?.Account==='967807252336'&&c.caller.Arn==='arn:aws:iam::967807252336:user/capirocli');
  need(!c.services?.failures?.length&&!c.services?.nextToken&&c.services?.services?.length===1);const service=c.services.services[0];
  need(service.serviceName==='capiro-dev-api'&&service.taskDefinition===pins.apiTaskDefinition&&service.desiredCount===2&&service.runningCount===2&&service.pendingCount===0&&service.deployments?.length===1&&service.deployments[0].status==='PRIMARY'&&service.deployments[0].rolloutState==='COMPLETED');
  const td=c.definition?.taskDefinition;need(td?.taskDefinitionArn===pins.apiTaskDefinition&&td.status==='ACTIVE'&&td.containerDefinitions?.length===1);const container=td.containerDefinitions[0];
  need(container.name==='api'&&container.image===pins.apiImage&&!container.environmentFiles?.length&&Array.isArray(container.environment)&&new Set(container.environment.map(e=>e.name)).size===container.environment.length&&hash(container.environment)===pins.apiEnvironmentSha256);
  const env=Object.fromEntries(container.environment.map(e=>[e.name,e.value]));need(env.GIT_SHA===pins.sourceGitRevision&&env.RELEASE_SHA===pins.sourceGitRevision&&env.MERI_SYNTHETIC_FIXTURE_NAMESPACE==='meri-foundation-20260928');
  need(c.rule?.Name===pins.nightly.rule&&c.rule.State==='ENABLED'&&c.rule.ScheduleExpression==='cron(30 4 * * ? *)'&&hash(c.rule)===pins.nightly.ruleSha256);
  need(c.targets?.Targets?.length===1&&!c.targets.NextToken&&!c.targets.nextToken&&hash(c.targets.Targets[0])===pins.nightly.targetSha256&&c.targets.Targets[0].EcsParameters?.TaskDefinitionArn===pins.nightly.taskDefinition);
  need(c.nightlyDefinition?.taskDefinition?.taskDefinitionArn===pins.nightly.taskDefinition&&c.nightlyDefinition.taskDefinition.status==='ACTIVE'&&hash(taskInput({...c.nightlyDefinition.taskDefinition,tags:c.nightlyDefinition.tags}))===pins.nightly.taskInputSha256);
  need(c.broadRule?.Name==='capiro-dev-memory-projection-worker'&&c.broadRule.State==='DISABLED');
  const next=new Date(nowMs);next.setUTCHours(4,30,0,0);if(next.getTime()<=nowMs)next.setUTCDate(next.getUTCDate()+1);need(deadlineAtMs+60_000<next.getTime());
  listValid(c.list);need(c.tasks&&!c.tasks.failures?.length&&!c.tasks.nextToken&&Array.isArray(c.tasks.tasks));const tasks=c.tasks.tasks;
  need(tasks.length===c.list.taskArns.length&&new Set(tasks.map(t=>t.taskArn)).size===tasks.length&&hash(tasks.map(t=>t.taskArn).sort())===hash([...c.list.taskArns].sort()));
  need(tasks.every(t=>textMatch(t.taskArn,TASK)&&t.desiredStatus==='RUNNING'&&textMatch(t.taskDefinitionArn,TD)));
  const api=tasks.filter(t=>t.group==='service:capiro-dev-api');need(api.length===2&&api.every(t=>t.lastStatus==='RUNNING'&&t.taskDefinitionArn===pins.apiTaskDefinition&&t.containers?.length===1&&t.containers[0].image===pins.apiImage&&t.containers[0].imageDigest===pins.apiImage.split('@')[1]&&!t.overrides?.taskRoleArn&&!t.overrides?.executionRoleArn&&!t.overrides?.containerOverrides?.some(o=>o.command?.length||o.environment?.length||o.environmentFiles?.length)));
  const approvedApi=new Set(api.map(t=>t.taskArn)),nightlyFamily=pins.nightly.taskDefinition.slice(0,pins.nightly.taskDefinition.lastIndexOf(':')+1);
  need(!tasks.some(t=>!approvedApi.has(t.taskArn)&&(/\/capiro-dev-(?:api(?::|-migrate)|memory-projection-worker|meri-)/u.test(t.taskDefinitionArn)||t.taskDefinitionArn.startsWith(nightlyFamily)||t.startedBy==='events-rule/capiro-dev-refresh-memory-graph')));
  return Object.freeze({censusSha256:hash(c),observedAtMs:nowMs,nextNightlyAt:next.toISOString(),apiTasks:Object.freeze(api.map(t=>t.taskArn).sort())});
}
