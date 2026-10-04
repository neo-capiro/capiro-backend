import test from 'node:test';
import assert from 'node:assert/strict';
import {createCase12SetupReservationOwner as createOwner} from '../case12-setup-reservation-owner.mjs';
import {syntheticFixture} from './case12-setup-reservation.fixtures.mjs';
const reserve=f=>f.owner.reserve({setupRunId:f.runId,costAuthority:f.mint()});
test('reviewer repro: string committed amount rejects during construction, before native access',()=>{
  let calls=0;assert.throws(()=>syntheticFixture((prior,ports)=>{prior.snapshot.committedCostMicros='16200909';return createOwner(prior,{...ports,nativeRequest:()=>{calls++;throw Error('UNREACHABLE');}});}));assert.equal(calls,0);
});
for(const [name,mutate] of [
  ['known-settled-change',s=>s.knownSettledCostMicros=0],
  ['conservative-change',s=>s.conservativeApprovalCostMicros=0],
  ['per-case-limit-change',s=>s.perCaseMaxCostMicros=999999999],
  ['case12-accounting-change',s=>{s.case12CommittedCostMicros=0;s.case12RemainingCostMicros=999999999;}],
  ['snapshot-key-added',s=>s.unreviewedAuthority=true],
  ['sum-preserving settled-conservative transfer',s=>{s.knownSettledCostMicros-=100;s.conservativeApprovalCostMicros+=100;}],
  ['sum-preserving wrong Case12 accounting',s=>{s.case12CommittedCostMicros-=100;s.case12RemainingCostMicros+=100;}],
  ['historical prefix changed',s=>s.historicalPrefixSha256='a'.repeat(64)],
  ['older-cost boundary changed',s=>s.olderCosts='KNOWN'],
  ['new reserved row key added',s=>s.runs[s.activeRun].unreviewedAuthority=true],
])test(`native reserved checkpoint rejects ${name} and retains poisoned hold`,async()=>{
  const f=syntheticFixture((prior,ports)=>createOwner(prior,{...ports,nativeRequest:async request=>{
    const result=await ports.nativeRequest(request);if(request.op==='fresh_case12_setup_reserve')mutate(result.snapshot);return result;
  }}));
  await assert.rejects(()=>reserve(f));await assert.rejects(()=>reserve(f));assert.equal(f.calls.filter(c=>c.op==='fresh_case12_setup_reserve').length,1);
});
for(const [name,mutate] of [
  ['missing prefix',s=>delete s.historicalPrefixSha256],
  ['missing older-cost boundary',s=>delete s.olderCosts],
  ['extra snapshot key',s=>s.ready=true],
  ['string known',s=>s.knownSettledCostMicros=String(s.knownSettledCostMicros)],
  ['fractional conservative',s=>s.conservativeApprovalCostMicros+=0.5],
  ['negative remaining',s=>s.remainingReservationMicros=-1],
  ['unsafe event count',s=>s.eventCount=Number.MAX_SAFE_INTEGER+1],
  ['global cap exceeded',s=>{s.knownSettledCostMicros=30_000_001;s.conservativeApprovalCostMicros=0;s.committedCostMicros=30_000_001;s.remainingReservationMicros=-1;}],
  ['case maximum changed',s=>s.perCaseMaxCostMicros=30_000_000],
  ['Case12 pair without run',s=>{s.case12CommittedCostMicros=0;s.case12RemainingCostMicros=15_000_000;}],
])test(`initial snapshot rejects ${name} before native calls`,()=>{
  let calls=0;assert.throws(()=>syntheticFixture((prior,ports)=>{mutate(prior.snapshot);return createOwner(prior,{...ports,nativeRequest:()=>{calls++;throw Error('UNREACHABLE');}});}));assert.equal(calls,0);
});
