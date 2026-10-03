import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { aws, need } from '../meri-fresh-20261003/auth-preflight.mjs';
import { releaseOperator } from 'file:///C:/dev/main/meri-closeout-c0-20261002/scripts/meri-release.mjs';
import { fingerprint, taskInput } from 'file:///C:/dev/main/meri-closeout-c0-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c0-completion-20261002';
const repo='C:/dev/main/meri-closeout-c0-20261002';
const save=(name,v)=>writeFileSync(root+'/'+name,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const run=(command,args,cwd=repo)=>execFileSync(command,args,{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const identity=aws(['sts','get-caller-identity']);
need(identity.Account==='967807252336','WRONG_ACCOUNT');
const mapBytes=readFileSync('C:/dev/capiro-agent-ops/machine-paths.local.yaml');
const map=Object.fromEntries(mapBytes.toString().split(/\r?\n/).filter(l=>/^[a-z_]+: /.test(l)).map(l=>{const i=l.indexOf(': ');return[l.slice(0,i),l.slice(i+2).replace(/^'|'$/g,'')]}));
need(Object.entries(map).every(([k,v])=>k==='aws_region'?v==='us-east-1':existsSync(v)),'INVALID_MACHINE_PATH');
save('source-and-machine.json',{observedAt:new Date().toISOString(),fetchedMainSha:run('git',['rev-parse','origin/main']),taskHeadBefore:run('git',['rev-parse','HEAD']),commitsSinceAudit:run('git',['rev-list','--count','723735ed1f5c562ab10e6077c67261285ea102fd..origin/main']),policySha:run('git',['rev-parse','HEAD'],map.ops_repo_root),machineMap:{path:'C:/dev/capiro-agent-ops/machine-paths.local.yaml',sha256:createHash('sha256').update(mapBytes).digest('hex'),pathsVerified:true,gitIgnored:run('git',['check-ignore','machine-paths.local.yaml'],map.ops_repo_root)==='machine-paths.local.yaml',logicalKeys:Object.keys(map)},aws:{profile:'capiro-dev',region:'us-east-1',account:identity.Account,principal:identity.Arn},openPullRequests:JSON.parse(run('gh',['pr','list','--state','open','--limit','100','--json','number,title,headRefName,baseRefName,url']))});
const operator=releaseOperator({aws:async args=>aws(args)});
for(const [service,priorRevision] of [['api',514],['meriv2-orchestrator',104],['web-vnext',387]]) {
  const snapshot=await operator.snapshot(service);
  const c=snapshot.task.containerDefinitions.find(c=>c.name===service);
  const env=Object.fromEntries((c.environment??[]).filter(e=>!/(KEY|TOKEN|SECRET|PASS|URL)/.test(e.name)&&(/^(GIT_SHA|RELEASE_SHA|MEMORY_)/.test(e.name)||/^MERI.*(MODEL|EFFORT|ENABLE|REQUIRE|ROLLOUT|ENFORCE|SHADOW|CANARY|READONLY|NAMESPACE|MODE)/.test(e.name))).map(e=>[e.name,e.value]));
  const cohortSummary={};
  for(const name of Object.keys(env).filter(k=>/TENANTS|TENANT_SLUGS/.test(k))){const value=env[name];cohortSummary[name]={sha256:createHash('sha256').update(value).digest('hex'),count:value.split(',').length,syntheticT1Included:value.includes('f2d6cf8f-057c-479a-8110-62fe5086d43f')||value.includes('meri-foundation-20260928-t1')};delete env[name];}
  const currentEcr=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids','imageDigest='+snapshot.baseline.imageDigest]);
  need(currentEcr.imageDetails.length===1,'CURRENT_IMAGE_UNAVAILABLE');
  const prior=aws(['ecs','describe-task-definition','--task-definition',`capiro-dev-${service}:${priorRevision}`]).taskDefinition;
  const priorContainer=prior.containerDefinitions.find(c=>c.name===service);
  const pinned=priorContainer.image.includes('@sha256:');
  const imageId=pinned?'imageDigest='+priorContainer.image.split('@')[1]:'imageTag='+priorContainer.image.split(':').at(-1);
  const priorEcr=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids',imageId]);
  need(priorEcr.imageDetails.length===1,'PRIOR_IMAGE_UNAVAILABLE');
  const previous={taskDefinitionArn:prior.taskDefinitionArn,status:prior.status,image:priorContainer.image,immutable:pinned,resolvedDigest:priorEcr.imageDetails[0].imageDigest,taskHash:fingerprint(taskInput(prior)),sourceSha:(priorContainer.environment??[]).find(e=>e.name==='RELEASE_SHA')?.value??null,availability:'VERIFIED',rollbackExecuted:false};
  save(service+'-current.json',{observedAt:new Date().toISOString(),service,...snapshot.baseline,sourceSha:env.RELEASE_SHA??env.GIT_SHA??null,image:c.image,selectedEnvironment:env,cohortSummary,currentEcrAvailable:true,previousArtifact:previous,nextReleaseRollback:{image:c.image,taskDefinitionArn:snapshot.task.taskDefinitionArn,configHash:snapshot.baseline.configHash,basis:'Verified current healthy baseline. Retain API/web for an orchestrator-only C1 repair.',compatibilityRequires:'Next C1 patch must not change schema/API/config; requalify at its exact commit.'},serviceUpdated:false});
  console.log(JSON.stringify({service,revision:snapshot.task.revision,status:'CURRENT_AND_PREVIOUS_IMAGE_VERIFIED'}));
}
