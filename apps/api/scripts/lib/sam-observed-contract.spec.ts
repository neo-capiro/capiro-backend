import { createHash } from 'node:crypto';
import path from 'node:path';
import { awardKey, mapSamAction, mapObservedSamAction, observedTransactionInput, SAM_OBSERVED_ACTION_CONTRACT } from './sam-contract-action.js';
import { parseFiniteSamConfig } from './sam-finite-cohort.js';
const uid='CONT_AWD_OBSR1_9700_-NONE-_-NONE-',key=awardKey(uid)!;
const source=(label:unknown)=>({contractId:{piid:'OBSR1',subtier:{code:'9700'},modificationNumber:'P1',transactionNumber:'1'},coreData:{awardOrIDV:'AWARD',awardOrIDVType:{code:'B'}},awardDetails:{dollars:{actionObligation:'-1.50'},dates:{dateSigned:'2025-10-03'},transactionData:{lastModifiedDate:label,version:'WRONG_FIELD_NOT_THE_TIMESTAMP'}}});
const candidates=[{piid:'OBSR1',awardUniqueId:uid,identityKey:key}];
describe('approved observed contract regressions',()=>{
 it.each(['2026-08-13 15:30:52',' 2026-08-13 15:30:52 ','2026-08-13T15:30:52Z',null,undefined])('retains exact original lastModifiedDate %s without rewriting payload',label=>{
  const record=source(label),before=JSON.stringify(record),mapped=mapObservedSamAction(record,candidates);
  expect(mapped.ok).toBe(true);if(!mapped.ok)throw Error(mapped.reason);
  expect(mapped.value.sourceRevisionLabel).toBe(label??null);
  expect(mapped.value.signedObligationDelta).toBe('-1.50');
  expect(JSON.parse(mapped.value.sourceTransactionId)).toEqual([SAM_OBSERVED_ACTION_CONTRACT,key,'P1','1']);
  const run={contract:SAM_OBSERVED_ACTION_CONTRACT,producerCommit:'a'.repeat(40),imageDigest:`sha256:${'b'.repeat(64)}`,runId:'synthetic',targetId:'fixture-target-1'};
  const input=observedTransactionInput(record,mapped.value,run,'2026-11-05T00:00:00.000000Z');
  expect(input.raw.acquisitionProvenance).toMatchObject({revisionBasis:'latest_observed',sourceRevisionLabel:label??null});
  expect(input.raw.acquisitionProvenance).not.toHaveProperty('sourceRevisionOrder');
  expect(JSON.stringify(record)).toBe(before);expect(input.raw.sourcePayload).toBe(record);
 });
 it.each([1,{},'x'.repeat(257),'bad\nlabel'])('refuses malformed publisher-label type/size/control %p',label=>{
  expect(mapObservedSamAction(source(label),candidates)).toEqual({ok:false,reason:'invalid_source_revision'});
 });
 it('keeps old v2 clock validation intact',()=>{
  expect(mapSamAction(source('2026-08-13 15:30:52'),candidates)).toEqual({ok:false,reason:'invalid_source_revision'});
 });
 it('makes observed mode an explicit finite invocation, never an implicit fallback',()=>{
  const bytes=Buffer.from(JSON.stringify([key]));
  const args=['--award-keys-file','unused.json','--award-keys-sha256',createHash('sha256').update(bytes).digest('hex'),'--evidence-dir',path.resolve('synthetic-evidence'),'--expires-at','2026-11-06T00:00:00.000000Z','--producer-commit','a'.repeat(40),'--image-digest',`sha256:${'b'.repeat(64)}`,'--run-id','synthetic','--target-id','fixture-target-1'];
  const env={SAM_GOV_API_KEY:'synthetic'};const now=Date.parse('2026-11-05T00:00:00Z');
  expect(parseFiniteSamConfig(args,env,now,()=>bytes).run.contract).toBe('sam-contract-action/v2');
  expect(parseFiniteSamConfig([...args,'--revision-basis','latest_observed'],env,now,()=>bytes).run.contract).toBe(SAM_OBSERVED_ACTION_CONTRACT);
  expect(()=>parseFiniteSamConfig([...args,'--revision-basis','guess_utc'],env,now,()=>bytes)).toThrow();
 });
});
