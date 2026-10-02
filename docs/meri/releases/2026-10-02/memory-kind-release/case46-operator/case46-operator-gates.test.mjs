import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {inspectInputs} from './case46-operator-gates.mjs';
import {case46Sample} from 'file:///C:/dev/cap-meri-mail-deadline/evals/meri/live-v1/tests/case46-fixture.mjs';
function sample(){
 const f=case46Sample(),s=f.scope;
 const ready={version:1,kind:'meri-case46-root-ready',status:'READY',target:'https://os.capiro.ai',maximumNewTurns:1,maximumApprovals:1,
  fullFile01Acceptance:false,observedAt:f.now-1000,expiresAt:f.now+500000,apiSha:s.apiSha,orchestratorSha:s.orchestratorSha,webSha:s.webSha,
  aggregateRoot:resolve('C:/dev/cap-meri-foundation-evidence/oct02-original-aggregate-operator-v5/original-spend-journal'),builds:{test:'OFFLINE'}};
 const binding={version:1,caseId:'46',captureRunId:s.captureRunId,conversationId:s.conversationId,bindingSha256:s.bindingSha256,
  currentVerifySha256:s.currentVerifySha256,qualificationSha256:s.qualificationSha256,expiresAt:f.now+600000};
 const source={physicalId:f.before.source.physicalId};
 const receipt={version:1,caseId:'46',fixtureNamespace:s.fixtureNamespace,tenantId:s.tenantId,actorUserId:s.userId,clientId:s.clientId,
  captureRunId:s.captureRunId,conversationId:s.conversationId,chatTurns:0,outputArtifacts:0,claimSha256:'a'.repeat(64),planSha256:'b'.repeat(64),binding,source};
 const rows=['CLAIM','INPUT_SOURCE','EMPTY_CONVERSATION','CAPTURE_BINDING'].flatMap(stage=>['INTENT','VERIFIED'].map(phase=>({kind:'meri-case46-setup',caseId:'46',captureRunId:s.captureRunId,stage,phase})));
 rows[3].source=source;rows[7].binding=binding;rows.push({kind:'meri-case46-setup',caseId:'46',captureRunId:s.captureRunId,stage:'COMPLETE',phase:'VERIFIED',receipt});
 return {ready,config:{schemaVersion:1,provenance:'LIVE_CAPTURE',target:{apiOrigin:ready.target,environment:'capiro-dev'},scope:s,
  deployment:{apiSha:s.apiSha,orchestratorSha:s.orchestratorSha,builds:ready.builds}},
  setup:{status:'VERIFIED',mode:'case46-setup-execute',sourceSha:s.apiSha,containerExitCode:0,ownerReceipts:rows},
  checkpoint:{kind:'meri-original-capture-spend-checkpoint',version:1,state:{root:ready.aggregateRoot},snapshot:{activeRun:null,remainingReservationMicros:27000000,
   runs:{'01:c6ffa5ad-dd9f-4912-bc31-a03231a9b903':{kind:'settle'}}}},now:f.now};
}
test('pure gate requires actual source-owned setup ordering and the same first-case aggregate boundary',()=>assert.equal(inspectInputs(sample()).config.scope.caseId,'46'));
for(const [name,change] of Object.entries({
 unsealed:x=>x.ready.status='UNSEALED',expired:x=>x.now=x.ready.expiresAt,
 expanded_turns:x=>x.ready.maximumNewTurns=2,wrong_target:x=>x.ready.target='https://app.capiro.ai',
 source:x=>x.setup.sourceSha='0'.repeat(40),failed_setup:x=>x.setup.containerExitCode=1,
 partial_seed:x=>x.setup.ownerReceipts.pop(),wrong_order:x=>x.setup.ownerReceipts[2].stage='CAPTURE_BINDING',
 wrong_actor:x=>x.setup.ownerReceipts[8].receipt.actorUserId='00000000-0000-4000-8000-000000000000',
 preexisting_turn:x=>x.setup.ownerReceipts[8].receipt.chatTurns=1,
 binding:x=>x.config.scope.bindingSha256='0'.repeat(64),duplicate_effect:x=>x.setup.ownerReceipts[8].receipt.outputArtifacts=1,
 other_ledger:x=>x.checkpoint.state.root+='-replacement',unsettled:x=>x.checkpoint.snapshot.activeRun='01:pending',
 fresh_ledger:x=>x.checkpoint.snapshot.runs={},exhausted:x=>x.checkpoint.snapshot.remainingReservationMicros=1,
 }))test(`local readiness rejects ${name}`,()=>{const x=sample();change(x);assert.throws(()=>inspectInputs(x));});
