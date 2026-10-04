import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const parent='C:/dev/main/outputs/meri-c2-20261003',root=parent+'/case14-source-release-preparation-v1';
const candidate=JSON.parse(readFileSync('C:/dev/main/outputs/meri-c2-20261003/case14-memory-source-candidate-v1.json','utf8'));
const sha=candidate.sourceSha;
if(!/^[a-f0-9]{40}$/.test(sha)||candidate.sourceCheckpointSha256!=='0b825aaf0c2c5140d166afcc628706649428d7d7e6263e05a8f9783a72e45307')throw new Error('CANDIDATE_BINDING_REQUIRED');
const repo='C:/dev/main/meri-c1-20261002',sourceSha=sha;
const read=name=>JSON.parse(readFileSync(parent+'/'+name,'utf8'));
const save=(name,obj)=>writeFileSync(root+'/'+name,JSON.stringify(obj,null,2)+'\n',{flag:'wx'});
const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
assert.equal(git(['rev-parse','HEAD']),sourceSha);assert.equal(git(['status','--porcelain']), '');
const caller=aws(['sts','get-caller-identity']);assert.equal(caller.Arn,'arn:aws:iam::967807252336:user/capirocli');
const allowed=['AWS_REGION_DEFAULT','OPENAI_MODEL','MERIV3_MODEL','MERIV3_FAST_MODEL','MERIV3_DEEP_MODEL','MERIV3_MAX_MODEL','MERI_JEV_MODEL','MERI_JEV_PROVIDER_MODE','MERI_JEV_PROVIDER_SURFACES','MERI_JEV_TASKS','RETRIEVAL_RERANK_ENABLED','NVIDIA_RERANK_MODEL','MERIV3_ENABLED','MERI_NATIVE_ENABLED','MERI_CONTEXT_MODE'];
const presenceOnly=['AWS_ENDPOINT_URL','AWS_ENDPOINT_URL_BEDROCK_RUNTIME','AWS_IGNORE_CONFIGURED_ENDPOINT_URLS','NVIDIA_API_KEY','NVIDIA_RERANK_URL','NVIDIA_RERANK_BASE_URL','NVIDIA_BASE_URL','OPENAI_BASE_URL','OPENAI_API_BASE','OPENAI_SERVICE_TIER'];
const operator=releaseOperator({aws}),services=[];
for(const service of ['api','meriv2-orchestrator','web-vnext']){
  const snapshot=await operator.snapshot(service),container=snapshot.task.containerDefinitions.find(c=>c.name===service);
  {
    const promoted=read(service+'-combined-c2-promotion-receipt.json');
    assert.equal(snapshot.baseline.taskDefinitionArn,promoted.candidateTaskDefinition);
    assert.equal(snapshot.baseline.taskHash,promoted.candidateTaskHash);
    assert.equal(snapshot.baseline.imageDigest,promoted.candidateImage.split('@')[1]);
    assert.equal(snapshot.baseline.configHash,promoted.configHash);
  }
  const env=new Map((container.environment??[]).map(e=>[e.name,e.value]));
  const secretNames=new Set((container.secrets??[]).map(e=>e.name));
  const config=Object.fromEntries(allowed.filter(k=>env.has(k)).map(k=>[k,env.get(k)]));
  const presence=Object.fromEntries(presenceOnly.map(k=>[k,{plainEntries:(container.environment??[]).filter(e=>e.name===k).length,secretReferencePresent:secretNames.has(k)}]));
  assert.equal(container.environmentFiles?.length??0,0);
  services.push({service,baseline:snapshot.baseline,sourceSha:env.get('RELEASE_SHA')??env.get('GIT_SHA'),image:container.image,health:'ALL_RUNNING_TASKS_AND_ALB_TARGETS_VERIFIED',modelsAndFlags:config,presenceOnly:presence,environmentFiles:0});
}
const pin=read('memory-refresh-pin-apply-result.json'),manifest=read('memory-refresh-pin-manifest.json');
const rule=aws(['events','describe-rule','--name',manifest.rule]);assert.equal(fingerprint(rule),manifest.baselineRuleSha256);
const target=aws(['events','list-targets-by-rule','--rule',manifest.rule]);assert.equal(target.Targets.length,1);assert.equal(target.NextToken,undefined);assert.equal(fingerprint(target.Targets[0]),pin.targetSha256);
assert.equal(target.Targets[0].EcsParameters.TaskDefinitionArn,pin.taskDefinition);
const td=aws(['ecs','describe-task-definition','--task-definition',pin.taskDefinition,'--include','TAGS']);
assert.equal(td.taskDefinition.status,'ACTIVE');assert.equal(fingerprint(taskInput({...td.taskDefinition,tags:td.tags})),manifest.taskInputSha256);
const broad=aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker']);assert.equal(broad.State,'DISABLED');assert.equal(fingerprint(broad),manifest.strictProjectionWorker.ruleSha256);
const broadTargets=aws(['events','list-targets-by-rule','--rule','capiro-dev-memory-projection-worker']);assert.equal(broadTargets.NextToken,undefined);assert.equal(fingerprint(broadTargets.Targets),manifest.strictProjectionWorker.targetsSha256);
const commonInvariantPaths=['pnpm-lock.yaml','apps/api/prisma'];
const comparison=[];
for(const service of services){
  const invariantPaths=[...(service.service==='web-vnext'?['pnpm-lock.yaml']:commonInvariantPaths),'apps/'+(service.service==='web-vnext'?'web':service.service)+'/Dockerfile','apps/'+(service.service==='web-vnext'?'web':service.service)+'/package.json'];
  assert.equal(git(['diff','--name-only',service.sourceSha,sourceSha,'--',...invariantPaths]),'');
  const paths=service.service==='api'?['apps/api/src','packages/meriv2-core/src']:service.service==='web-vnext'?['apps/web/src']:['apps/meriv2-orchestrator/src','packages/meriv2-core/src'];
  comparison.push({service:service.service,baselineSourceSha:service.sourceSha,candidateSourceSha:sourceSha,unchangedMigrationDependencyAndContainerPaths:invariantPaths,changedRuntimePaths:git(['diff','--name-only',service.sourceSha,sourceSha,'--',...paths]).split('\n').filter(Boolean)});
}
mkdirSync(root);
const proof={version:1,status:'CURRENT_SERVED_BASELINE_AND_CONFIG_VERIFIED_READ_ONLY',observedAt:new Date().toISOString(),candidateSourceSha:sourceSha,callerArn:caller.Arn,services,
  retainedNightly:{rule:manifest.rule,targetId:manifest.targetId,taskDefinition:pin.taskDefinition,sourceSha:pin.sourceSha,image:pin.image,ruleSha256:fingerprint(rule),targetSha256:pin.targetSha256,taskInputSha256:manifest.taskInputSha256,change:'NONE'},
  broadProjectionWorker:{state:broad.State,change:'NONE'},comparison,awsWrites:0,providerCalls:0,
  limits:['Configuration readback contains allowlisted model/flag values and presence only for endpoint/tier/key names; no secret values or full environment arrays were fetched from secret storage or persisted.', 'NVIDIA absence is task configuration evidence, not hosted-account billing entitlement or an independent process-environment inspection.', 'This snapshot is a drift fence, not a distributed deployment lock. Fresh candidate-bound checks and human release review remain required.']};
save('served-baseline.json',proof);
console.log(JSON.stringify({status:proof.status,observedAt:proof.observedAt,services:services.map(s=>({service:s.service,sourceSha:s.sourceSha,...s.baseline})),retainedNightly:proof.retainedNightly,awsWrites:0},null,2));
