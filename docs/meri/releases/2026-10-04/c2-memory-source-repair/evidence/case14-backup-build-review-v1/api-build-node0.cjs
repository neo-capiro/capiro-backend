const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {MemoryStoreService} = require('./dist/memory/memory-store.service.js');
const {defaultMemoryGovernanceFields} = require('./dist/memory/memory.types.js');
const {readOwnPendingMemoryProposals} = require('./dist/meri/meri-memory-proposal-read.js');
const {MERI_CAPABILITY_REGISTRY} = require('@capiro/shared');
(async () => {
  const tenantId=randomUUID(), userId=randomUUID(), clientId=randomUUID(), candidateId=randomUUID();
  assert.equal(MERI_CAPABILITY_REGISTRY.find(t=>t.name==='list_memory_proposals').readOnly,true);
  const ctx={tenantId,userId,role:'standard_user'};
  const pending=await readOwnPendingMemoryProposals(ctx,{clientId},{listOwnProposals:async (actor,filter)=>{
    assert.deepEqual(actor,ctx); assert.deepEqual(filter,{clientId,limit:5,status:'pending'});
    return {enabled:true,nextCursor:null,candidates:[{id:candidateId,status:'pending',scope:'client',clientId,
      sourceKind:'model_extraction',createdAt:'2026-09-26T16:00:00Z',restricted:false,
      proposal:{key:'Synthetic preference',value:'prefers SMS alerts'}}]};
  }});
  assert.equal(pending.claimsAreApprovedFacts,false); assert.equal(pending.candidates[0].approvedFact,false);
  assert.equal(pending.candidates[0].proposedText,'prefers SMS alerts');
  assert.equal(pending.candidates[0].memoryItemId,undefined);
  const item={...defaultMemoryGovernanceFields(),id:'',tenantId,clientId,ownerUserId:null,type:'note',visibility:'tenant',
    entityId:null,slug:'clio:'+randomUUID(),title:'Synthetic',aliases:[],tags:[],source:'manual',sourceRef:candidateId,
    provenance:'human',sections:[],schemaVersion:1,memoryClass:'client_steering',memoryAuthority:'analyst_verified',
    memoryScope:'client',governedStatus:'active',sourceVersion:'candidate:'+candidateId,assertedByUserId:userId,
    approvedByUserId:randomUUID(),approvedAt:'2026-09-26T16:00:00Z'};
  let existingId, restores=0;
  const tx={$queryRaw:async (sql,...values)=>[{id:existingId??values[0]}],$executeRaw:async (sql,...values)=>{
    if(sql.join('?').includes('UPDATE memory_items')){restores++;const index=sql.findIndex(s=>s.includes('retention_policy_jsonb ='));
      assert.equal(values[index],null);}
    return 1;
  }};
  const store=new MemoryStoreService({withSystem:fn=>fn(tx)},{});
  existingId=await store.upsertSystem(item); assert.equal(restores,1);
  assert.equal(await store.upsertSystem(item),existingId); assert.equal(restores,1);
  console.log('OFFLINE_PACKAGED_C2_MEMORY_PASS');
})().catch(error=>{console.error(error);process.exitCode=1;});
