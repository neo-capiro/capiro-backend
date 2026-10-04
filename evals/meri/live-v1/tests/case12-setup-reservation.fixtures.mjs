import {createHash,randomUUID} from 'node:crypto';
export const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const uuid=randomUUID;
export const copy=structuredClone;
export function syntheticFixture(createOwner){
  const started=Date.now();let currentTime=started;let current;let failRead=null;let gate=null;
  const runId=uuid();
  const rows=Array.from({length:510},(_,i)=>({candidateId:`00000000-0000-5000-8000-${String(i+1).padStart(12,'0')}`,logicalId:i===0?'MA510':`MA510-DISTRACTOR-${String(i).padStart(4,'0')}`,candidatePayloadSha256:hash(['synthetic payload',i]),requests:{openai_embeddings:{bodySha256:hash(['synthetic openai',i]),inputBytes:100+i},bedrock_embeddings:{bodySha256:hash(['synthetic bedrock',i]),inputBytes:150+i}}}));
  const proof={kind:'meri-case12-native-setup-cost-bound',version:1,caseId:'12',setupRunId:runId,fixtureInstanceId:uuid(),fixtureNamespace:'meri-foundation-20260928',tenantId:'f2d6cf8f-057c-479a-8110-62fe5086d43f',proposerUserId:uuid(),reviewerUserId:uuid(),clientId:uuid(),setupPlanSha256:hash('synthetic inspection'),recipeSha256:hash('synthetic recipe'),orderedDefinitionSha256:hash('synthetic definitions'),sourceSha256:hash('synthetic source manifest'),imageSha256:hash('synthetic image'),rateEvidenceSha256:hash('synthetic rate evidence'),rates:{openai_embeddings:{inputPerM:0.02,outputPerM:0},bedrock_embeddings:{inputPerM:0.01,outputPerM:0}},ratesExpiresAt:new Date(started+3_600_000).toISOString(),admittedAt:new Date(started-1000).toISOString(),deadlineAt:new Date(started+900_000).toISOString(),maxCostMicros:125460,providerRowsSha256:hash(rows),nativeCensusSha256:hash('synthetic native census'),nativeCensusObservedAtMs:started-100};
  const initial={kind:'meri-fresh-capture-spend-checkpoint',version:1,state:{root:'C:\\dev\\main\\outputs\\meri-fresh-20261003',freshVersion:1,directories:{'C:':{volume:1,fileId:1}},files:{'run-authorization.json':{identity:{volume:1,fileId:2},sha256:hash('synthetic authorization'),bytes:128},'fresh-spend.jsonl':{identity:{volume:1,fileId:3},sha256:hash('synthetic 26 prior events'),bytes:17588}}},snapshot:{protocolVersion:3,historicalPrefixSha256:'abe458973e6998db20586c781ac5a3cbd4ca2fa565425e62722f0eb9c985210b',olderCosts:'UNRESOLVED_SEPARATE_NOT_REPLACED',eventCount:26,runs:{},activeRun:null,knownSettledCostMicros:15_200_909,conservativeApprovalCostMicros:1_000_000,committedCostMicros:16_200_909,remainingReservationMicros:13_799_091,perCaseMaxCostMicros:15_000_000}};
  current=copy(initial);const calls=[];const capabilities=new WeakMap();
  const mint=()=>{const token=Object.freeze({});capabilities.set(token,false);return token;};
  const ports={
    now(){return currentTime;},
    async consumeCostAuthority(token,id){if(!capabilities.has(token)||capabilities.get(token)!==false||id!==runId)throw Error('COST_AUTHORITY_UNOWNED_OR_REPLAYED');capabilities.set(token,true);return copy(proof);},
    validateProviderPlan(plan){if(!plan||plan.version!==1||plan.caseId!=='12'||plan.rows?.length!==510)throw Error('SYNTHETIC_TEST_VALIDATOR_REJECTED');return copy(plan);},
    async nativeRequest(request){
      calls.push(copy(request));if(gate){const pending=gate;gate=null;await pending;}
      if(failRead){const e=failRead;failRead=null;throw e;}
      if(hash(request.state)!==hash(current.state))throw Error('NATIVE_CHECKPOINT_CHANGED');
      if(request.op==='fresh_read')return {state:copy(current.state),snapshot:copy(current.snapshot)};
      if(request.op!=='fresh_case12_setup_reserve'||current.snapshot.activeRun!==null)throw Error('NATIVE_OPERATION_REJECTED');
      const e=request.event;if(e.caseId!=='12'||e.kind!=='case12_setup_reserve')throw Error('NATIVE_SETUP_EVENT_REJECTED');
      const row={...copy(e),nativeCaptureVersion:1,sequence:27,atMs:currentTime,event:'case12_setup_reserved'};delete row.kind;
      current.state.files['fresh-spend.jsonl'].sha256=hash(row);current.state.files['fresh-spend.jsonl'].bytes+=JSON.stringify(row).length+1;
      current.snapshot={...current.snapshot,eventCount:27,activeRun:'12:'+e.setupRunId,runs:{['12:'+e.setupRunId]:row},committedCostMicros:16_200_909+e.ceilingMicros,remainingReservationMicros:13_799_091-e.ceilingMicros,case12CommittedCostMicros:e.ceilingMicros,case12RemainingCostMicros:15_000_000-e.ceilingMicros};
      return {state:copy(current.state),snapshot:copy(current.snapshot)};
    }
  };
  const owner=createOwner(copy(initial),ports);
  const providerPlan=()=>{
    const reservationId=calls.find(c=>c.op==='fresh_case12_setup_reserve')?.event.reservationId;
    return {version:1,caseId:'12',fixtureNamespace:proof.fixtureNamespace,fixtureInstanceId:proof.fixtureInstanceId,runId,aggregateReservationId:reservationId,tenantId:proof.tenantId,proposerUserId:proof.proposerUserId,reviewerUserId:proof.reviewerUserId,clientId:proof.clientId,setupPlanSha256:proof.setupPlanSha256,recipeSha256:proof.recipeSha256,orderedDefinitionSha256:proof.orderedDefinitionSha256,sourceSha256:proof.sourceSha256,imageSha256:proof.imageSha256,aggregateCheckpointSha256:hash(initial),rateEvidenceSha256:proof.rateEvidenceSha256,admittedAt:proof.admittedAt,deadlineAt:proof.deadlineAt,ratesExpiresAt:proof.ratesExpiresAt,rates:copy(proof.rates),maxCostMicros:proof.maxCostMicros,rows:copy(rows)};
  };
  return {owner,ports,proof,initial,calls,rows,runId,mint,providerPlan,now:()=>currentTime,advance:ms=>{currentTime+=ms;},failNext:()=>{failRead=Error('NATIVE_UNCERTAINTY');},mutateNative:fn=>fn(current),blockNext:()=>{let release;gate=new Promise(r=>release=r);return release;}};
}
