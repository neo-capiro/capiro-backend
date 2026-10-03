// Prepare a reviewable unsigned packet. This does not fabricate human qualification.
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {candidateTask,fingerprint} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const imageFor=(service,digest)=>'967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/'+service+'@'+digest;
const [evidenceCommit]=process.argv.slice(2);assert.match(evidenceCommit??'',/^[a-f0-9]{40}$/);
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002';
const arc='docs/meri/releases/2026-10-03/c2-memory-lifecycle/';
const versioned=file=>JSON.parse(execFileSync('git',['show',evidenceCommit+':'+arc+file],{cwd:repo,encoding:'utf8',windowsHide:true}));
const save=(name,value)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const qualification=versioned('release-qualification.json'),review=versioned('release-independent-review.json');
assert.equal(qualification.status,'AUTOMATED_QUALIFICATION_PASSED_HUMAN_RELEASE_REVIEW_PENDING');
assert.equal(qualification.humanApproval,null);assert.equal(review.result,'PASS');assert.equal(review.humanReleaseApproval,false);
assert.equal(qualification.schemaChange,false);assert.equal(qualification.currentSchema.status,'VERIFIED_READ_ONLY');
assert.equal(qualification.cleanupPreview.status,'PROJECTION_CLEANUP_PREVIEW_ROLLED_BACK');
assert.equal(aws(['sts','get-caller-identity']).Account,'967807252336');
const prior=JSON.parse(readFileSync(root+'/served-baseline.json','utf8'));
const operator=releaseOperator({aws}),services=[];
for(const service of ['api','meriv2-orchestrator','web-vnext']) {
  const live=await operator.snapshot(service),expected=prior.identities.find(i=>i.service===service);
  assert.deepEqual(live.baseline,expected.baseline,service+' baseline drift');
  const c=live.task.containerDefinitions.find(c=>c.name===service);
  const sourceSha=c.environment.find(e=>e.name==='RELEASE_SHA')?.value??c.environment.find(e=>e.name==='GIT_SHA')?.value;
  assert.equal(sourceSha,expected.sourceSha,service+' source drift');
  if(service==='web-vnext'){services.push({service,change:'NONE',sourceSha,image:c.image,baseline:live.baseline});continue;}
  const candidate=qualification.candidates[service];
  const buildPath='builds/'+(service==='api'?'api':'meriv2-orchestrator')+'/build-readback.json';
  const b=versioned(buildPath);assert.equal(b.status,'SUCCEEDED');assert.equal(b.sourceSha,candidate.sourceSha);assert.equal(b.image,candidate.image);
  for(const id of ['imageTag='+candidate.sourceSha,'imageDigest='+candidate.image.split('@')[1]]) {
    const d=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids',id]).imageDetails;
    assert.equal(d.length,1);assert.equal(d[0].imageDigest,candidate.image.split('@')[1]);
  }
  const rollbackImage=imageFor(service,live.baseline.imageDigest);
  const rollback=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids','imageDigest='+live.baseline.imageDigest]).imageDetails;
  assert.equal(rollback.length,1);assert.equal(rollback[0].imageDigest,live.baseline.imageDigest);
  const proposed=candidateTask(live.task,service,candidate.image,candidate.sourceSha);
  const fallback=candidateTask(live.task,service,rollbackImage);
  services.push({service,change:'IMAGE_AND_RELEASE_IDENTITY_ONLY',candidate,baseline:live.baseline,
    candidateTaskSha256:fingerprint(proposed),rollbackImage,rollbackTaskSha256:fingerprint(fallback),
    configurationPreserved:true,buildEvidence:buildPath});
}
const nightly=JSON.parse(readFileSync(root+'/memory-refresh-pin-manifest.json','utf8'));
assert.equal(nightly.status,'PREPARED_NOT_APPLIED');assert.equal(nightly.humanReleaseApproval,null);
assert.equal(nightly.qualificationSha256,fingerprint(qualification));
assert.equal(nightly.sourceSha,qualification.candidates.api.sourceSha);assert.equal(nightly.image,qualification.candidates.api.image);
assert.ok(Date.parse(nightly.expiresAt)>Date.now());
const prefix='https://github.com/neo-capiro/capirov2/blob/'+evidenceCommit+'/'+arc;
const packet={kind:'C2 memory lifecycle exact release review packet',version:1,status:'AWAITING_HUMAN_REVIEW',
  preparedAt:new Date().toISOString(),expiresAt:nightly.expiresAt,evidenceCommit,
  evidence:[prefix+'README.md',prefix+'release-qualification.json',prefix+'release-independent-review.json'],
  qualificationSha256:fingerprint(qualification),services,nightlyManifestSha256:fingerprint(nightly),
  nightly:{rule:nightly.rule,targetId:nightly.targetId,sourceSha:nightly.sourceSha,image:nightly.image,
    baselineRuleSha256:nightly.baselineRuleSha256,baselineTargetSha256:nightly.baselineTargetSha256,
    baselineTaskDefinition:nightly.baselineTaskDefinition,candidateTaskSha256:nightly.taskInputSha256},
  maintenance:{namespace:'meri-foundation-20260928',originalFixtureInstances:['84a3a6a1-ddc8-4810-b120-9a5df0cf1ed9','f6164496-9dac-4771-980f-2f362081942e'],
    previewPlanSha256:qualification.cleanupPreview.planSha256,originalCleanupJobs:qualification.cleanupPreview.plan.jobs.map(j=>({id:j.id,itemId:j.itemId,operation:j.operation})),
    observedProjectionCount:qualification.cleanupPreview.plan.projectionCount,tentativeMetadataRows:3,
    authorizeFreshIdenticalScopePlanOnly:true,requireGuardedWritersAndFreshExpectedPlan:true,noReset:true,noReapproval:true,noCompletedJobReplay:true},
  executionOrder:['Deploy API and verify exact healthy image, unchanged config and old-writer drain',
    'Deploy orchestrator and verify exact healthy image and unchanged config',
    'Pin the one existing nightly target after fresh owner/drift checks; do not manually invoke it',
    'Preview the exact six existing cleanup jobs again, then execute once against the exact fresh plan',
    'Preview the three bounded metadata repairs again, then reconcile once against the exact fresh plan',
    'Read the strict current corpus independently and preserve all original fixture history'],
  rollback:{application:'Use the exact prior healthy images listed per service; retain additive migration452 and indexes.',
    nightly:nightly.rollback,maintenance:'Forward-only canonical maintenance; do not restore retired projections or replay original approvals.'},
  unchanged:['Model/provider configuration','Feature flags','Roles/network/secret references','Nightly schedule and command','Web service','Disabled broad projection worker'],
  newProviderCalls:0,newCaptureAuthority:false,schemaChange:false,migrationExecution:false,
  acceptance:{original75:0,cd:0,cw:0},awsWrites:0,
  humanReleaseApproval:null,deployableManifest:false,
  approvalRequirement:'docs/meri/deployment-prerequisite.md: Qualification is an explicit human-reviewed attestation. The operator must inspect the candidate-bound evidence before signing off.'};
save('memory-lifecycle-release-packet.json',packet);
const hash=fingerprint(packet);
save('memory-lifecycle-release-packet.md',`# C2 memory release review\n\nThis packet is prepared and has not been deployed. Technical qualification and independent review passed.\n\nPacket fingerprint: \`${hash}\`. Prepared ${packet.preparedAt}; expires ${packet.expiresAt}. [Versioned evidence](${prefix}README.md).\n\n| Target | Exact source | Image digest | Current rollback |\n| --- | --- | --- | --- |\n${services.filter(s=>s.candidate).map(s=>`| ${s.service} | \`${s.candidate.sourceSha}\` | \`${s.candidate.image.split('@')[1]}\` | \`${s.rollbackImage.split('@')[1]}\` |`).join('\n')}\n\nThe existing nightly refresh uses the same proposed API image. Its schedule, command, roles, network, feature flags and secret references stay unchanged. No manual all-tenant refresh is proposed. The separate broad projection worker stays disabled.\n\nThe subsequent maintenance is limited to six original cleanup obligations and three metadata repairs in the existing synthetic fixture. The live preview passed and rolled back. Fresh identical-scope plans must pass before either operation commits; original approvals, memory content and historical evidence are preserved. No paid capture or new capture authority is included.\n\nApplication rollback uses the exact prior healthy images above and retains the existing additive mail indexes. Keep the guarded writer for unrelated application rollback; disable only the nightly rule if that writer fails. Do not restore retired projections.\n\n[Complete operation sequence and hashes](memory-lifecycle-release-packet.json). The repository [release rule](https://github.com/neo-capiro/capirov2/blob/${evidenceCommit}/docs/meri/deployment-prerequisite.md#qualification-evidence-and-migration-rules) requires an **explicit human-reviewed attestation** for these artifacts. Human approval is pending; no approval is inferred from passing automated tests.\n`);
console.log(JSON.stringify({status:packet.status,packetSha256:hash,evidenceCommit,expiresAt:packet.expiresAt,services:services.filter(s=>s.candidate).map(s=>({service:s.service,...s.candidate,baseline:s.baseline,candidateTaskSha256:s.candidateTaskSha256})),nightlyManifestSha256:packet.nightlyManifestSha256,originalCleanupJobs:packet.maintenance.originalCleanupJobs.length,projectionCount:packet.maintenance.observedProjectionCount,metadataRows:3,awsWrites:0},null,2));
