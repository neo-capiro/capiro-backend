import assert from 'node:assert/strict';
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {fingerprint} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const REVIEWED_PACKET_SHA256='781b944fee40f504c744dda2f609f0f63446b9693dd2cdb661ecde756f749fc2';
assert.match(REVIEWED_PACKET_SHA256??'',/^[a-f0-9]{64}$/,'Concrete reviewed packet must be bound before any file or AWS access');
const root='C:/dev/main/outputs/meri-c2-20261003';
const packet=JSON.parse(readFileSync(root+'/case12-source-release-packet-v1.json','utf8'));
assert.equal(fingerprint(packet),REVIEWED_PACKET_SHA256);
assert.ok(Date.parse(packet.expiresAt)>Date.now());
const approval={status:'APPROVED',scope:'EXACT_C2_CASE12_RELEASE_AND_TEMPORARY_IAM',
  reviewer:'Human user — explicit approval in current Codex chat',approvedAt:new Date().toISOString(),
  packetSha256:fingerprint(packet),answer:'Approved',
  approvalSource:'Direct human reply Approved to the immediately preceding exact API20283265/orchestrator33ecf4fc and temporary IAM packet approval request in this Codex chat',
  originalSnapshotExpiresAt:packet.expiresAt,
  executionCondition:'Exact packet candidates and baseline through the existing one-service release operator; API then orchestrator, health verification after each. Preserve models, service configuration and benchmark budget. Separately apply and remove only the exact temporary IAM policy in the reviewed packet; require actual helper access before setup.',
  scopeDetails:packet.services.filter(s=>s.candidate).map(s=>({service:s.service,...s.candidate})),
  temporaryIam:{roleArn:packet.temporaryIam.roleArn,policyName:packet.temporaryIam.policyName,policySha256:packet.temporaryIam.policySha256,expiresAt:packet.temporaryIam.expiresAt},
  paidCaptureAuthority:false};
const fd=openSync(root+'/case12-release-human-approval.json','wx');
try{writeFileSync(fd,JSON.stringify(approval,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
console.log(JSON.stringify({status:approval.status,packetSha256:approval.packetSha256,approvedAt:approval.approvedAt}));
