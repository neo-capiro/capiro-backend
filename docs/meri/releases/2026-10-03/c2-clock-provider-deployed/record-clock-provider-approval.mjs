import assert from 'node:assert/strict';
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {fingerprint} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const packet=JSON.parse(readFileSync(root+'/clock-provider-release-packet.json','utf8'));
assert.equal(fingerprint(packet),'98a95643241e321b6f8950449e0a2ef16a35f6a32d37cbcd089cc1a8a7520190');
const approval={status:'APPROVED',scope:'EXACT_C2_CLOCK_PROVIDER_RELEASE',
  reviewer:'Neo Martinez — explicit approval in current Codex chat',approvedAt:new Date().toISOString(),
  packetSha256:fingerprint(packet),answer:'Approved',
  approvalSource:'Direct human reply to the immediately preceding exact clock/provider release packet request in this chat',
  originalSnapshotExpiresAt:packet.expiresAt,originalSnapshotExpiredAtRecording:Date.parse(packet.expiresAt)<=Date.now(),
  executionCondition:'Fresh existing-operator checks and a successor snapshot must prove the exact same candidates, baselines, configuration, rollback, schema and scope before promotion. Original packet is retained; expiry is not waived.',
  scopeDetails:packet.services.filter(s=>s.candidate).map(s=>({service:s.service,...s.candidate})),
  paidCaptureAuthority:false};
const fd=openSync(root+'/clock-provider-human-approval.json','wx');
try{writeFileSync(fd,JSON.stringify(approval,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
console.log(JSON.stringify({status:approval.status,packetSha256:approval.packetSha256,approvedAt:approval.approvedAt,originalSnapshotExpired:approval.originalSnapshotExpiredAtRecording}));
