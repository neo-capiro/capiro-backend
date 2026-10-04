import assert from 'node:assert/strict';
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {fingerprint} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const packet=JSON.parse(readFileSync(root+'/capture-contract-release-packet.json','utf8'));
assert.equal(fingerprint(packet),'5d67f443a71180e7aa49e775f3f979a585348d5b6480a7e83b76432bef7bfbdf');
assert.ok(Date.parse(packet.expiresAt)>Date.now());
const approval={status:'APPROVED',scope:'EXACT_C2_CAPTURE_CONTRACT_RELEASE',
  reviewer:'Human user — explicit approval in current Codex chat',approvedAt:new Date().toISOString(),
  packetSha256:fingerprint(packet),answer:'Approve exact release',
  approvalSource:'Direct human reply to request_user_input_async call_00NoEl0jnnwTUCs7pQPFF780 in this chat',
  originalSnapshotExpiresAt:packet.expiresAt,
  executionCondition:'Exact packet candidates and baseline through the existing one-service release operator; API first, health verification after each. Preserve models, configuration and benchmark budget.',
  scopeDetails:packet.services.filter(s=>s.candidate).map(s=>({service:s.service,...s.candidate})),
  paidCaptureAuthority:false};
const fd=openSync(root+'/capture-contract-human-approval.json','wx');
try{writeFileSync(fd,JSON.stringify(approval,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
console.log(JSON.stringify({status:approval.status,packetSha256:approval.packetSha256,approvedAt:approval.approvedAt}));
