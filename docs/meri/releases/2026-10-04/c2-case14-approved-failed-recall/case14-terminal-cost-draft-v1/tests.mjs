import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectCase14TerminalCost as inspect,prepareCase14TerminalCostAuthority,semantic,hash} from './authority-draft.mjs';
import {SCOPE as s,RETAINED_PINS as pins} from './fixed.mjs';
const retained=JSON.parse(fs.readFileSync(new URL('./retained-input.json',import.meta.url)));
const time=s.providerDeadlineAtMs+5000;
const response=(value,path,offset)=>({value:structuredClone(value),observation:{path,status:200,apiReleaseSha:s.sourceSha,observedAt:new Date(time+offset).toISOString(),bodySha256:hash(JSON.stringify(value)),bodyBytes:Buffer.byteLength(JSON.stringify(value))}});
const me=response(retained.diagnosticMe.value,'/api/me',100),conversation=response(retained.diagnosticConversation.value,'/api/clio/conversations/'+s.conversationId,200);
const post={me,conversation,cleanup:{status:'revoked'},summary:{kind:'case14-postdeadline-owned-provider-budget-readback',status:'READBACK_CAPTURED',captureRunId:s.captureRunId,conversationId:s.conversationId,tenantId:s.tenantId,userId:s.userId,sessionRevoked:true,journalUnchanged:true,afterProviderDeadline:true,messagesReadAfterDeadline:false,captureAuthority:false,applicationWrites:0,modelSubmissions:0,journalMutations:0,priorMessagesSha256:pins.diagnosticMessages.sha256,priorExecutionSha256:pins.execution.sha256,priorCheckpointSha256:pins.checkpoint.sha256,reads:[me.observation,conversation.observation],startedAt:new Date(time).toISOString(),finishedAt:new Date(time+300).toISOString()}};
test('UNIT postdeadline observations can qualify cost arithmetic only',()=>{
 const proof=inspect(retained,post);
 assert.equal(proof.chargedCostMicros,1569851);assert.equal(proof.conservativeApprovalCostMicros,1000000);assert.equal(proof.approvalBilledActualMicros,null);
 assert.equal(proof.providerTokens,62396);assert.equal(proof.providerAttempts,3);assert.equal(proof.combinedCommittedCostMicros,2569851);
 assert.equal(proof.captureAuthority,false);assert.equal(proof.answerGrade,'NOT_EVALUATED');assert.equal(proof.captureStatus,'CAPTURE_UNCERTAIN');
 fs.writeFileSync(new URL('./proof.unit.json',import.meta.url),JSON.stringify(proof,null,2)+'\n');
 fs.writeFileSync(new URL('./postdeadline.UNIT-ONLY.json',import.meta.url),JSON.stringify(post,null,2)+'\n');
});
test('draft has no mintable capability, even after valid pure inspection',()=>assert.throws(()=>prepareCase14TerminalCostAuthority(),/NOT_FROZEN/));
const mutations={
 'early postdeadline GET':x=>x.conversation.observation.observedAt=new Date(s.providerDeadlineAtMs).toISOString(),
 'wrong source header':x=>x.conversation.observation.apiReleaseSha=null,
 'wrong actor':x=>x.me.value.user.id=s.tenantId,
 'wrong role':x=>x.me.value.role='standard_user',
 'wrong tenant':x=>x.conversation.value.tenantId=s.userId,
 'wrong conversation':x=>x.conversation.value.id=s.captureRunId,
 'wrong client':x=>x.conversation.value.clientId=null,
 'wrong raw body digest':x=>x.conversation.observation.bodySha256='0'.repeat(64),
 'extra provider attempt':x=>x.conversation.value.metadata.serverCaptureProviderBudget.ledger.attempts.push(x.conversation.value.metadata.serverCaptureProviderBudget.ledger.attempts[0]),
 'inflight provider':x=>x.conversation.value.metadata.serverCaptureProviderBudget.ledger.attempts[0].status='reserved',
 'numeric tokens redacted':x=>x.conversation.value.metadata.serverCaptureProviderBudget.ledger.chargedTokens='[REDACTED]',
 'rate drift':x=>x.conversation.value.metadata.serverCaptureProviderBudget.qualification.rates[0].inputMicrosPerMillion=1,
 'qualification drift':x=>x.conversation.value.metadata.serverCaptureProviderBudget.qualification.maxCostMicros=15000000,
 'cost changed':x=>x.conversation.value.metadata.serverCaptureProviderBudget.ledger.chargedCostMicros=0,
 'not revoked':x=>x.cleanup.status='active',
 'journal mutated':x=>x.summary.journalUnchanged=false,
 'different prior checkpoint':x=>x.summary.priorCheckpointSha256='0'.repeat(64),
 'different prior signed raw messages':x=>x.summary.priorMessagesSha256='0'.repeat(64),
 'attempted writes':x=>x.summary.applicationWrites=1,
 'attempted submission':x=>x.summary.modelSubmissions=1,
 'authority promotion':x=>x.summary.captureAuthority=true,
 'expired message read':x=>x.summary.messagesReadAfterDeadline=true,
};
for(const[name,mutate]of Object.entries(mutations))test(name+' refuses',()=>{const v=structuredClone(post);mutate(v);assert.throws(()=>inspect(retained,v),/COST_REJECTED/);});
test('every original evidence pin detects mutation/deletion',()=>{for(const[name,pin]of Object.entries(pins)){if(!pin.semanticSha256)continue;const r=structuredClone(retained);r[name]=null;assert.throws(()=>inspect(r,post),/COST_REJECTED/);}});
test('actual v1 null-header/early diagnostic cannot be substituted',()=>{
 const v=structuredClone(post);v.conversation=JSON.parse(fs.readFileSync('C:/dev/main/outputs/meri-c2-20261003/case14-terminal-read-v1/conversation.json'));
 assert.throws(()=>inspect(retained,v),/COST_REJECTED/);
});
