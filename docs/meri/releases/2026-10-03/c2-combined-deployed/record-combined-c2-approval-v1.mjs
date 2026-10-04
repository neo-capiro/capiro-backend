import assert from 'node:assert/strict';
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {fingerprint} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const packet=JSON.parse(readFileSync(root+'/combined-c2-release-packet-v1.json','utf8'));
assert.equal(fingerprint(packet),'8f246b44000e35548444642a31079c8b65f04aa3abf6fd0fcf6768864c3f9c7b');
assert.ok(Date.parse(packet.expiresAt)>Date.now());
const approval={status:'APPROVED',scope:'EXACT_C2_COMBINED_RELEASE',
  reviewer:'Human user — explicit approval in current Codex chat',approvedAt:new Date().toISOString(),
  packetSha256:fingerprint(packet),answer:'Approved',
  approvalSource:'Direct human reply Approved to the immediately preceding exact three-image release packet approval request in this Codex chat',
  originalSnapshotExpiresAt:packet.expiresAt,
  executionCondition:'Exact packet candidates and baseline through the existing one-service release operator; API then orchestrator then Web, health verification after each. Preserve models, configuration and benchmark budget.',
  scopeDetails:packet.services.filter(s=>s.candidate).map(s=>({service:s.service,...s.candidate})),
  paidCaptureAuthority:false};
const fd=openSync(root+'/combined-c2-human-approval.json','wx');
try{writeFileSync(fd,JSON.stringify(approval,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
console.log(JSON.stringify({status:approval.status,packetSha256:approval.packetSha256,approvedAt:approval.approvedAt}));
