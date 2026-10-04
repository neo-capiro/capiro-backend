import assert from 'node:assert/strict';
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {fingerprint} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const packet=JSON.parse(readFileSync(root+'/case14-source-release-packet-v2.json','utf8'));
assert.equal(fingerprint(packet),'1dba538b156ddbdac729dbc0c647d0d3c4b4f38bb3a583a8edc08ef6b0f2b5e2');
assert.ok(Date.parse(packet.expiresAt)>Date.now());
const approval={status:'APPROVED',scope:'EXACT_C2_MEMORY_SOURCE_RELEASE',
  reviewer:'Human user — explicit approval in current Codex chat',approvedAt:new Date().toISOString(),
  packetSha256:fingerprint(packet),answer:'Approved',
  approvalSource:'Direct human reply Approved to the immediately preceding exact API00e8c5ca/orchestrator94c82ec4 two-image release packet approval request in this Codex chat',
  originalSnapshotExpiresAt:packet.expiresAt,
  executionCondition:'Exact packet candidates and baseline through the existing one-service release operator; API then orchestrator, health verification after each. Preserve models, configuration and benchmark budget.',
  scopeDetails:packet.services.filter(s=>s.candidate).map(s=>({service:s.service,...s.candidate})),
  paidCaptureAuthority:false};
const fd=openSync(root+'/memory-source-human-approval.json','wx');
try{writeFileSync(fd,JSON.stringify(approval,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
console.log(JSON.stringify({status:approval.status,packetSha256:approval.packetSha256,approvedAt:approval.approvedAt}));
