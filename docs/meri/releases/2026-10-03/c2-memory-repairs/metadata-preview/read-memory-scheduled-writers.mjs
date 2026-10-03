import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {aws,need} from '../meri-fresh-20261003/auth-preflight.mjs';
import {fingerprint} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const original=JSON.parse(readFileSync(root+'/metadata-preview-diagnostic-definition-input.json','utf8')).containerDefinitions[0].command[0];
writeFileSync(root+'/metadata-preview-diagnostic-inner.mjs',original);
const records=[];
for(const name of ['capiro-dev-refresh-memory-graph','capiro-dev-memory-projection-worker']) {
  const rule=aws(['events','describe-rule','--name',name]);
  const targets=aws(['events','list-targets-by-rule','--rule',name]).Targets;
  const bindings=[];
  for(const target of targets) {
    need(target.EcsParameters?.TaskDefinitionArn,'UNEXPECTED_MEMORY_SCHEDULE_TARGET');
    const task=aws(['ecs','describe-task-definition','--task-definition',target.EcsParameters.TaskDefinitionArn]).taskDefinition;
    const containers=task.containerDefinitions.map(c=>({name:c.name,image:c.image,entryPoint:c.entryPoint??null,command:c.command??null,
      releaseSha:c.environment?.find(e=>e.name==='RELEASE_SHA')?.value??c.environment?.find(e=>e.name==='GIT_SHA')?.value??null,
      environmentNames:(c.environment??[]).map(e=>e.name).sort(),secretNames:(c.secrets??[]).map(e=>e.name).sort(),
      logGroup:c.logConfiguration?.options?.['awslogs-group']??null,logPrefix:c.logConfiguration?.options?.['awslogs-stream-prefix']??null}));
    const imageDetails=[];
    for(const c of containers) {
      const match=/^967807252336\.dkr\.ecr\.us-east-1\.amazonaws\.com\/(.+?)(?::([^:@]+)|@(sha256:[a-f0-9]{64}))$/.exec(c.image);
      need(match,'SCHEDULE_IMAGE_UNSUPPORTED');
      let details;
      try { details=aws(['ecr','describe-images','--repository-name',match[1],'--image-ids',match[3]?'imageDigest='+match[3]:'imageTag='+match[2]]).imageDetails; }
      catch(error) { imageDetails.push({container:c.name,configuredImage:c.image,status:'ECR_LOOKUP_UNVERIFIED',error:'AWS_COMMAND_FAILED_ecr_describe-images'}); continue; }
      need(details.length===1,'SCHEDULE_IMAGE_UNVERIFIED');
      imageDetails.push({container:c.name,configuredImage:c.image,observedDigest:details[0].imageDigest,pushedAt:details[0].imagePushedAt});
    }
    bindings.push({id:target.Id,clusterArn:target.Arn,roleArn:target.RoleArn,input:target.Input?JSON.parse(target.Input):null,ecs:target.EcsParameters,
      targetSha256:fingerprint(target),taskDefinition:task.taskDefinitionArn,taskDefinitionSha256:fingerprint(task),containers,imageDetails});
  }
  records.push({name:rule.Name,arn:rule.Arn,state:rule.State,schedule:rule.ScheduleExpression,ruleSha256:fingerprint(rule),targets:bindings});
}
const result={at:new Date().toISOString(),status:'READ_ONLY_WRITER_INVENTORY',records,mutations:0,
  conclusion:'API service replacement alone does not replace the independently scheduled backfill image. Do not execute corpus reconciliation until recurring writer compatibility is addressed.'};
writeFileSync(root+'/memory-scheduled-writers.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result,null,2));
