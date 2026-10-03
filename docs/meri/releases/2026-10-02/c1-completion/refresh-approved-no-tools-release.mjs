import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,validateQualification} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c1-20261002';
const old=JSON.parse(readFileSync(root+'/orchestrator-no-tools-manifest.json','utf8'));
const oldHash='cdae48fbe78e3355f896f5516b6704d30153a8058be3ec5c968d9aa00ae9b762';
assert.equal(fingerprint(old),oldHash);
assert.equal(old.qualification.sourceSha,'cfd0adf0c54776f81f4b4e57c1a43190766e195e');
assert.equal(old.qualification.image,'967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/meriv2-orchestrator@sha256:a53bf1a432f212b8e43be903f766c52ec4a8307d5fce1cbec1bdfbf45196ddea');
validateQualification(old.qualification,old.service,old.qualification.image,Date.now());
const operator=releaseOperator({aws});
const previous=JSON.parse(readFileSync(root+'/mail-defaults-final-service-readback.json','utf8'));
const siblings=[];
for(const service of ['api','web-vnext']){
  const s=await operator.snapshot(service);
  const expected=previous.identities.find(i=>i.service===service);
  assert.deepEqual(s.baseline,expected.baseline,service+' baseline changed');
  const c=s.task.containerDefinitions.find(c=>c.name===service);
  const sourceSha=c.environment?.find(e=>e.name==='RELEASE_SHA')?.value??c.environment?.find(e=>e.name==='GIT_SHA')?.value;
  assert.equal(sourceSha,expected.sourceSha,service+' source changed');
  siblings.push({service,baseline:s.baseline,image:c.image,sourceSha});
}
const renewed=await operator.prepare(old.qualification);
assert.deepEqual({...renewed,preparedAt:old.preparedAt},old,'Anything except the preparation timestamp changed');
const hash=fingerprint(renewed);
const approval={
  recordedAt:new Date().toISOString(),source:'Explicit human message in current Codex conversation',userText:'Approved',
  service:old.service,sourceSha:old.qualification.sourceSha,image:old.qualification.image,
  approvedReviewPacket:'docs/meri/releases/2026-10-02/c1-no-tools-repair/RELEASE-REVIEW.md',
  approvedReviewPacketCommit:'8797a3d4b81d75a43c53924e79dc42ac13c5202d',
  originalManifestHash:oldHash,effectiveManifestHash:hash,
  renewal:{reason:'One-hour preparation window elapsed before human reply; exact approved artifact and complete baseline revalidated',onlyChangedField:'preparedAt',previous:old.preparedAt,current:renewed.preparedAt,qualificationUnchanged:true,baselineUnchanged:true,siblingsUnchanged:true},
  scope:['Promote the exact approved concise-warning image using fresh canonical checks','Verify C1 in the signed-in workspace','Proceed through all C2 after C1 completes, per the preceding explicit instruction'],
  inheritedNewArtifactApproval:false,
};
writeFileSync(root+'/orchestrator-no-tools-manifest-refreshed.json',JSON.stringify(renewed,null,2)+'\n',{flag:'wx'});
writeFileSync(root+'/owner-no-tools-approval.json',JSON.stringify(approval,null,2)+'\n',{flag:'wx'});
writeFileSync(root+'/no-tools-refreshed-sibling-readback.json',JSON.stringify({observedAt:new Date().toISOString(),services:siblings,awsWrites:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'APPROVED_SAME_ARTIFACT_REFRESHED',manifestHash:hash,sourceSha:approval.sourceSha,image:approval.image,preparedAt:renewed.preparedAt,changedFields:['preparedAt'],awsWrites:0},null,2));
