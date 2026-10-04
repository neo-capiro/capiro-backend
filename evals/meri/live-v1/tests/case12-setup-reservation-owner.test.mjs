import test from 'node:test';
import assert from 'node:assert/strict';
import {createCase12SetupReservationOwner} from '../case12-setup-reservation-owner.mjs';
import {syntheticFixture,hash,copy} from './case12-setup-reservation.fixtures.mjs';
const fixture=()=>syntheticFixture(createCase12SetupReservationOwner);
const reserve=async f=>f.owner.reserve({setupRunId:f.runId,costAuthority:f.mint()});
const bound=async f=>{const h=await reserve(f);await f.owner.bindProviderPlan(h,f.providerPlan());return h;};
test('independent: exact Python event and pre-hold provider plan make no circular checkpoint hash',async()=>{
  const f=fixture(),h=await bound(f),r=f.calls.find(x=>x.op==='fresh_case12_setup_reserve');
  assert.deepEqual(Object.keys(r.event).sort(),['kind','caseId','setupRunId','reservationId','ceilingMicros','setupPlanSha256','fixtureInstanceId','providerDeadlineAtMs','captureAuthority'].sort());
  assert.equal(r.event.kind,'case12_setup_reserve');assert.equal(r.event.captureAuthority,false);
  const data=await f.owner.claimDispatch(h);
  assert.equal(data.preHoldCheckpointSha256,hash(f.initial));assert.equal(data.providerPlan.aggregateCheckpointSha256,data.preHoldCheckpointSha256);
  assert.notEqual(data.postHoldCheckpointSha256,data.preHoldCheckpointSha256);
  assert.equal(data.providerPlanSha256,hash(data.providerPlan));assert.equal(data.reservationId,r.event.reservationId);
  assert.equal(data.costAuthoritySha256,hash(f.proof));assert.equal(typeof data.dispatch.startedBy,'string');
  assert.equal(typeof f.owner.settle,'undefined');assert.equal(typeof f.owner.adopt,'undefined');assert.equal(typeof f.owner.restore,'undefined');
});
test('independent: cloned and foreign handles cannot claim or bind',async()=>{
  const f=fixture(),other=fixture(),h=await bound(f);
  await assert.rejects(async()=>f.owner.claimDispatch(JSON.parse(JSON.stringify(h))));
  await assert.rejects(async()=>other.owner.claimDispatch(h));
  await assert.rejects(async()=>other.owner.bindProviderPlan(h,f.providerPlan()));
});
test('independent: one claim and one reservation only',async()=>{
  const f=fixture(),h=await bound(f);await f.owner.claimDispatch(h);
  await assert.rejects(async()=>f.owner.claimDispatch(h));await assert.rejects(async()=>reserve(f));
  assert.equal(f.calls.filter(c=>c.op==='fresh_case12_setup_reserve').length,1);
});
test('independent: bound native ports survive caller method replacement',async()=>{
  const f=fixture();f.ports.nativeRequest=()=>{throw Error('MUTATED_NATIVE_PORT');};f.ports.consumeCostAuthority=()=>{throw Error('MUTATED_COST_PORT');};
  const h=await reserve(f);await f.owner.bindProviderPlan(h,f.providerPlan());await f.owner.claimDispatch(h);
});
test('independent: concurrent reserve cannot race native durable hold',async()=>{
  const f=fixture(),release=f.blockNext();const pending=reserve(f);
  await assert.rejects(async()=>reserve(f));release();await pending;
  assert.equal(f.calls.filter(c=>c.op==='fresh_case12_setup_reserve').length,1);
});
test('independent: native post-hold uncertainty poisons future dispatch',async()=>{
  const f=fixture(),h=await bound(f);f.failNext();await assert.rejects(async()=>f.owner.claimDispatch(h));
  await assert.rejects(async()=>f.owner.claimDispatch(h));assert.equal(f.calls.filter(c=>c.op==='fresh_case12_setup_reserve').length,1);
});
test('independent: native held row mutation rejects dispatch even when file identity stays same',async()=>{
  const f=fixture(),h=await bound(f);f.mutateNative(c=>{c.snapshot.runs['12:'+f.runId].ceilingMicros+=1;});
  await assert.rejects(async()=>f.owner.claimDispatch(h));
});
test('independent: checkpoint content replacement before reserve is rejected',async()=>{
  const f=fixture();f.mutateNative(c=>{c.state.files['fresh-spend.jsonl'].sha256=hash('replaced');});
  await assert.rejects(async()=>reserve(f));assert.equal(f.calls.filter(c=>c.op==='fresh_case12_setup_reserve').length,0);
});
test('independent: provider-plan body mutation and source mutation each reject binding',async()=>{
  for(const mutate of [p=>p.rows[10].requests.openai_embeddings.bodySha256=hash('changed'),p=>p.sourceSha256=hash('foreign source'),p=>p.rates.openai_embeddings.inputPerM+=0.1,p=>p.tenantId='11111111-1111-4111-8111-111111111111']){
    const f=fixture(),h=await reserve(f),p=f.providerPlan();mutate(p);await assert.rejects(async()=>f.owner.bindProviderPlan(h,p));
  }
});
test('independent: plan bind snapshots mutable caller rows',async()=>{
  const f=fixture(),h=await reserve(f),p=f.providerPlan();await f.owner.bindProviderPlan(h,p);p.rows[0].logicalId='changed';
  const scope=await f.owner.claimDispatch(h);assert.equal(scope.providerPlan.rows[0].logicalId,'MA510');
});
test('independent: expired admission and stale native census reject before durable reserve',async()=>{
  for(const advance of [61_000,901_000]){const f=fixture();f.advance(advance);await assert.rejects(async()=>reserve(f));assert.equal(f.calls.filter(c=>c.op==='fresh_case12_setup_reserve').length,0);}
});
test('independent: unknown dispatcher keys cannot bind an unverified input',async()=>{
  const f=fixture(),h=await bound(f);await f.owner.claimDispatch(h);
  await assert.rejects(async()=>f.owner.bindDispatch(h,{taskDefinitionArn:'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-c2-case12-setup:1',inputByteSha256:hash('synthetic input'),ready:true}));
});
test('independent: proof input is not a substitute for cost authority',async()=>{
  const f=fixture();await assert.rejects(async()=>f.owner.reserve({setupRunId:f.runId,costAuthority:copy(f.proof)}));
  assert.equal(f.calls.filter(c=>c.op==='fresh_case12_setup_reserve').length,0);
});
test('independent: compact helper input omits rows and binds recomputed plan envelope',async()=>{
  const f=fixture(),h=await bound(f);await f.owner.claimDispatch(h);const input=f.owner.compactInput(h);
  assert.equal(input.providerPlan,undefined);assert.equal(input.providerEnvelope.rows,undefined);
  assert.equal(input.providerEnvelope.aggregateCheckpointSha256,hash(f.initial));
  assert.ok(Buffer.byteLength(JSON.stringify(input))<4096);assert.equal(input.providerPlanSha256,hash(f.providerPlan()));
});
test('independent: same task readback remains possible after deadline but a second dispatch is denied',async()=>{
  const f=fixture(),h=await bound(f);await f.owner.claimDispatch(h);
  await f.owner.bindDispatch(h,{taskDefinitionArn:'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-c2-case12-setup:1',inputByteSha256:hash('synthetic input')});
  f.advance(901_000);await f.owner.bindTask(h,'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/'+'a'.repeat(32));
  const current=await f.owner.currentScope(h);assert.equal(current.setupRunId,f.runId);await assert.rejects(async()=>f.owner.claimDispatch(h));
});
test('independent: cost proof ceiling must equal exact compiled full-input arithmetic',async()=>{
  const f=fixture();f.proof.maxCostMicros-=1;await assert.rejects(async()=>reserve(f));assert.equal(f.calls.length,0);
});
test('independent: fresh-read delay cannot admit with a stale native census',async()=>{
  const f=fixture(),release=f.blockNext(),pending=reserve(f);f.advance(61_000);release();await assert.rejects(async()=>pending);
  assert.equal(f.calls.filter(c=>c.op==='fresh_case12_setup_reserve').length,0);
});
test('independent: array-valued dispatch hash is rejected before binding',async()=>{
  const f=fixture(),h=await bound(f);await f.owner.claimDispatch(h);
  await assert.rejects(async()=>f.owner.bindDispatch(h,{taskDefinitionArn:'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-c2-case12-setup:1',inputByteSha256:['a'.repeat(64)]}));
  assert.equal(f.owner.compactInput(h).dispatch.inputByteSha256,undefined);
});
test('independent: array-valued native journal hash poisons ambiguous reserved hold',async()=>{
  const f=syntheticFixture((prior,ports)=>createCase12SetupReservationOwner(prior,{...ports,nativeRequest:async request=>{
    const result=await ports.nativeRequest(request);if(request.op==='fresh_case12_setup_reserve')result.state.files['fresh-spend.jsonl'].sha256=[result.state.files['fresh-spend.jsonl'].sha256];return result;
  }}));
  await assert.rejects(async()=>reserve(f),/CASE12_SETUP_NATIVE_RESERVE_UNPROVED_HOLD_RETAINED/);
  await assert.rejects(async()=>reserve(f));assert.equal(f.calls.filter(c=>c.op==='fresh_case12_setup_reserve').length,1);
});
