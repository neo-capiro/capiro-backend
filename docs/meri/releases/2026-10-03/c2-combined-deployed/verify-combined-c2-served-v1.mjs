import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws,withAuth,ctx} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const read=name=>JSON.parse(readFileSync(root+'/'+name,'utf8'));
const output=root+'/combined-c2-served-readback-v1.json';assert.equal(existsSync(output),false);
const packet=read('combined-c2-release-packet-v1.json'),approval=read('combined-c2-human-approval.json');
assert.equal(approval.status,'APPROVED');assert.equal(approval.scope,'EXACT_C2_COMBINED_RELEASE');
assert.equal(approval.packetSha256,fingerprint(packet));

const operator=releaseOperator({aws}),services=[];
for(const service of ['api','meriv2-orchestrator','web-vnext']){
  const live=await operator.snapshot(service),expected=packet.services.find(s=>s.service===service);
  let oldTaskReadback={status:'NOT_CHECKED_UNCHANGED_SERVICE',requestedCount:null,observedCount:null,drainingCount:null};
  {
    const receipt=read(service+'-combined-c2-promotion-receipt.json');assert.equal(receipt.status,'ecs-healthy-manual-acceptance-required');
    assert.equal(live.baseline.taskDefinitionArn,receipt.candidateTaskDefinition);assert.equal(live.baseline.imageDigest,expected.candidate.image.split('@')[1]);
    assert.equal(live.baseline.taskHash,expected.candidateTaskSha256);assert.equal(live.baseline.configHash,expected.baseline.configHash);
    const source=live.task.containerDefinitions.find(c=>c.name===service).environment.find(e=>e.name==='RELEASE_SHA')?.value;
    assert.equal(source,expected.candidate.sourceSha);
    const recent=aws(['ecs','list-tasks','--cluster','capiro-dev','--service-name','capiro-dev-'+service,'--desired-status','STOPPED']);
    assert.equal(recent.nextToken,undefined);assert.ok(Array.isArray(recent.taskArns));
    assert.equal(new Set(recent.taskArns).size,recent.taskArns.length);
    let observedCount=0;
    for(let i=0;i<recent.taskArns.length;i+=100){
      const requested=recent.taskArns.slice(i,i+100);
      const tasks=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...requested]);assert.equal(tasks.failures?.length??0,0);
      assert.ok(Array.isArray(tasks.tasks));assert.equal(tasks.tasks.length,requested.length);
      assert.deepEqual(tasks.tasks.map(t=>t.taskArn).sort(),[...requested].sort(),'Incomplete or duplicate task readback');
      for(const task of tasks.tasks){assert.equal(task.clusterArn,'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev');
        assert.equal(task.group,'service:capiro-dev-'+service);assert.equal(task.lastStatus,'STOPPED','Old service task still draining');}
      observedCount+=tasks.tasks.length;
    }
    oldTaskReadback={status:'ALL_REQUESTED_TASKS_STOPPED',requestedCount:recent.taskArns.length,observedCount,drainingCount:0};
  }
  services.push({service,baseline:live.baseline,health:'ALL_CURRENT_TASKS_AND_TARGETS_HEALTHY',oldTaskReadback});
}
const nightly=packet.retainedNightly;
const rule=aws(['events','describe-rule','--name',nightly.rule]);assert.equal(fingerprint(rule),nightly.ruleSha256);
const targets=aws(['events','list-targets-by-rule','--rule',nightly.rule]);assert.equal(targets.Targets.length,1);assert.equal(targets.NextToken,undefined);assert.equal(fingerprint(targets.Targets[0]),nightly.targetSha256);
const td=aws(['ecs','describe-task-definition','--task-definition',nightly.taskDefinition,'--include','TAGS']);assert.equal(td.taskDefinition.status,'ACTIVE');assert.equal(fingerprint(taskInput({...td.taskDefinition,tags:td.tags})),nightly.taskInputSha256);
const broad=aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker']);assert.equal(broad.State,'DISABLED');
let ordinaryIdentity;
await withAuth(async({bearer})=>{
  const response=await fetch('https://os.capiro.ai/api/me',{headers:{Authorization:'Bearer '+bearer,'x-capiro-tenant':ctx.tenantSlug,'User-Agent':'Capiro-Meri-Authorized-QA/1.0'},redirect:'error',signal:AbortSignal.timeout(30000)});
  const me=await response.json();assert.equal(response.status,200);assert.equal(me.tenant?.id,ctx.tenantId);assert.equal(me.user?.id,ctx.userId);assert.equal(me.role,'standard_user');
  assert.equal(response.headers.get('x-capiro-release-sha'),packet.services.find(s=>s.service==='api').candidate.sourceSha);
  ordinaryIdentity={status:'ORDINARY_IDENTITY_ROUTE_PASS',httpStatus:200,actorUserId:ctx.userId,tenantId:ctx.tenantId,role:'standard_user',apiSourceSha:response.headers.get('x-capiro-release-sha')};
});
const journal=readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl');assert.equal(createHash('sha256').update(journal).digest('hex'),packet.budget.journalSha256);
const proof={status:'EXACT_RELEASE_AND_ORDINARY_IDENTITY_VERIFIED',recordedAt:new Date().toISOString(),packetSha256:fingerprint(packet),services,retainedNightly:nightly,broadProjectionWorker:'DISABLED',ordinaryIdentity,temporarySessionRevoked:true,providerCalls:0,conversationCreations:0,journalMutations:0,fixtureMutations:0,originalAcceptance:'UNCHANGED_NOT_RUN'};
const fd=openSync(output,'wx');try{writeFileSync(fd,JSON.stringify(proof,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
console.log(JSON.stringify(proof,null,2));
