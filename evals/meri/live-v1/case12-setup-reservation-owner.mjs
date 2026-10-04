import {createHash,randomUUID} from 'node:crypto';
const need=(ok)=>{if(!ok)throw Error('CASE12_SETUP_RESERVATION_REJECTED');};
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HASH=/^[a-f0-9]{64}$/u;
const TENANT='f2d6cf8f-057c-479a-8110-62fe5086d43f';
const NAMESPACE='meri-foundation-20260928';
function canonical(v){
  if(v===null||typeof v==='string'||typeof v==='boolean')return v;
  if(typeof v==='number'){need(Number.isFinite(v));return v;}
  if(Array.isArray(v))return Array.from(v,canonical);
  need(record(v));return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));
}
export const case12SetupReservationHash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const hash=case12SetupReservationHash;
const equal=(a,b)=>hash(a)===hash(b);
function freeze(v){if(v&&typeof v==='object'){for(const c of Object.values(v))freeze(c);Object.freeze(v);}return v;}
const snapshot=v=>freeze(structuredClone(canonical(v)));
const exact=(v,keys)=>need(record(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'));
const instant=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const TOTAL_MICROS=30_000_000,CASE_MICROS=15_000_000;
const HISTORICAL_PREFIX='abe458973e6998db20586c781ac5a3cbd4ca2fa565425e62722f0eb9c985210b';
const money=(v,max=TOTAL_MICROS)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
function checkedSnapshot(s){
  need(record(s)&&record(s.runs));
  const rows=Object.values(s.runs);need(rows.every(record));
  const case12=rows.filter(r=>r.caseId==='12');need(case12.length<=1);
  exact(s,['protocolVersion','eventCount','runs','activeRun','knownSettledCostMicros','conservativeApprovalCostMicros','committedCostMicros','remainingReservationMicros','perCaseMaxCostMicros','historicalPrefixSha256','olderCosts',...(case12.length?['case12CommittedCostMicros','case12RemainingCostMicros']:[])]);
  need(s.protocolVersion===3&&Number.isSafeInteger(s.eventCount)&&s.eventCount>=26&&s.perCaseMaxCostMicros===CASE_MICROS&&s.historicalPrefixSha256===HISTORICAL_PREFIX&&s.olderCosts==='UNRESOLVED_SEPARATE_NOT_REPLACED');
  for(const k of ['knownSettledCostMicros','conservativeApprovalCostMicros','committedCostMicros','remainingReservationMicros'])need(money(s[k]));
  let held=0;
  if(s.activeRun!==null){need(typeof s.activeRun==='string'&&Object.hasOwn(s.runs,s.activeRun));const active=s.runs[s.activeRun];need(money(active.ceilingMicros,CASE_MICROS)&&active.ceilingMicros>0&&!Object.hasOwn(active,'chargedCostMicros'));held=active.ceilingMicros;}
  need(s.committedCostMicros===s.knownSettledCostMicros+s.conservativeApprovalCostMicros+held&&s.remainingReservationMicros===TOTAL_MICROS-s.committedCostMicros);
  if(case12.length){
    let used=0;for(const row of case12){need(money(row.ceilingMicros,CASE_MICROS)&&row.ceilingMicros>0);if(Object.hasOwn(row,'chargedCostMicros')){need(money(row.chargedCostMicros,row.ceilingMicros));used+=row.chargedCostMicros;}else used+=row.ceilingMicros;}
    need(money(s.case12CommittedCostMicros,CASE_MICROS)&&money(s.case12RemainingCostMicros,CASE_MICROS)&&s.case12CommittedCostMicros===used&&s.case12RemainingCostMicros===CASE_MICROS-used);
  }
}

function checkedCheckpoint(v){
  exact(v,['kind','version','state','snapshot']);need(v.kind==='meri-fresh-capture-spend-checkpoint'&&v.version===1);
  need(record(v.state)&&v.state.freshVersion===1&&typeof v.state.root==='string'&&v.state.root.replaceAll('\\','/')==='C:/dev/main/outputs/meri-fresh-20261003');
  need(record(v.state.files)&&record(v.state.directories));checkedSnapshot(v.snapshot);
  return snapshot(v);
}
function checkedProof(v,runId,now){
  const fields=['kind','version','caseId','setupRunId','fixtureInstanceId','fixtureNamespace','tenantId','proposerUserId','reviewerUserId','clientId','setupPlanSha256','recipeSha256','orderedDefinitionSha256','sourceSha256','imageSha256','rateEvidenceSha256','rates','ratesExpiresAt','admittedAt','deadlineAt','maxCostMicros','providerRowsSha256','nativeCensusSha256','nativeCensusObservedAtMs'];
  exact(v,fields);need(v.kind==='meri-case12-native-setup-cost-bound'&&v.version===1&&v.caseId==='12'&&v.setupRunId===runId&&v.fixtureNamespace===NAMESPACE&&v.tenantId===TENANT);
  for(const k of ['setupRunId','fixtureInstanceId','proposerUserId','reviewerUserId','clientId'])need(typeof v[k]==='string'&&UUID.test(v[k]));
  need(v.proposerUserId!==v.reviewerUserId);
  for(const k of ['setupPlanSha256','recipeSha256','orderedDefinitionSha256','sourceSha256','imageSha256','rateEvidenceSha256','providerRowsSha256','nativeCensusSha256'])need(typeof v[k]==='string'&&HASH.test(v[k]));
  for(const k of ['admittedAt','deadlineAt','ratesExpiresAt'])need(instant(v[k]));
  need(Date.parse(v.admittedAt)<=now&&now<Date.parse(v.deadlineAt)&&Date.parse(v.deadlineAt)<=Date.parse(v.ratesExpiresAt)&&Date.parse(v.deadlineAt)<=now+86_400_000);
  need(Number.isSafeInteger(v.nativeCensusObservedAtMs)&&v.nativeCensusObservedAtMs<=now&&now-v.nativeCensusObservedAtMs<60_000);
  need(Number.isSafeInteger(v.maxCostMicros)&&v.maxCostMicros>0&&v.maxCostMicros<=15_000_000);
  exact(v.rates,['openai_embeddings','bedrock_embeddings']);let perRow=0;
  for(const rate of Object.values(v.rates)){exact(rate,['inputPerM','outputPerM']);need(typeof rate.inputPerM==='number'&&Number.isFinite(rate.inputPerM)&&rate.inputPerM>0&&rate.outputPerM===0);perRow+=Math.max(1,Math.ceil(((8192*rate.inputPerM)/1_000_000)*1_000_000));}
  need(v.maxCostMicros===510*perRow);return snapshot(v);
}
/** Output-only composition candidate. Ports MUST be wired to reviewed native owners;
 * injected test ports below this boundary are not native qualification or activation. */
export function createCase12SetupReservationOwner(prior,supplied){
  need(record(supplied));for(const k of ['nativeRequest','consumeCostAuthority','validateProviderPlan'])need(typeof supplied[k]==='function');
  const ports=Object.freeze({nativeRequest:supplied.nativeRequest.bind(supplied),consumeCostAuthority:supplied.consumeCostAuthority.bind(supplied),validateProviderPlan:supplied.validateProviderPlan.bind(supplied),now:typeof supplied.now==='function'?supplied.now.bind(supplied):Date.now});
  const initial=checkedCheckpoint(prior);let current=initial,attempted=false,poisoned=false,busy=false;const handles=new WeakMap();
  const owned=h=>{const b=handles.get(h);need(b&&!poisoned);return b;};
  async function exclusive(fn){need(!busy&&!poisoned);busy=true;try{return await fn();}finally{busy=false;}}
  async function native(op,event){
    try{const r=await ports.nativeRequest(snapshot({op,state:current.state,...(event?{event}:{})}));return checkedCheckpoint({kind:current.kind,version:1,state:r.state,snapshot:r.snapshot});}
    catch{poisoned=true;throw Error('CASE12_SETUP_NATIVE_UNCERTAINTY_HOLD_RETAINED');}
  }
  async function recheck(){
    const value=await native('fresh_read');if(!equal(value,current)){poisoned=true;throw Error('CASE12_SETUP_NATIVE_CHECKPOINT_CHANGED_HOLD_RETAINED');}return value;
  }
  function live(b){checkedProof(b.proof,b.proof.setupRunId,ports.now());}
  function scope(b){return snapshot({...b.input,dispatch:{...b.input.dispatch,...b.boundDispatch,...(b.taskArn?{taskArn:b.taskArn}:{})}});}
  const owner={
    checkpoint:()=>snapshot(current),
    reserve(input){return exclusive(async()=>{
      need(!attempted);attempted=true;exact(input,['setupRunId','costAuthority']);need(typeof input.setupRunId==='string'&&UUID.test(input.setupRunId));
      const proof=checkedProof(await ports.consumeCostAuthority(input.costAuthority,input.setupRunId),input.setupRunId,ports.now());
      await recheck();checkedProof(proof,input.setupRunId,ports.now());need(current.snapshot.activeRun===null&&!Object.values(current.snapshot.runs).some(r=>r.caseId==='12')&&current.snapshot.remainingReservationMicros>=proof.maxCostMicros);
      const reservationId=randomUUID(),pre=current;
      const event={kind:'case12_setup_reserve',caseId:'12',setupRunId:proof.setupRunId,reservationId,ceilingMicros:proof.maxCostMicros,setupPlanSha256:proof.setupPlanSha256,fixtureInstanceId:proof.fixtureInstanceId,providerDeadlineAtMs:Date.parse(proof.deadlineAt),captureAuthority:false};
      const next=await native('fresh_case12_setup_reserve',event),key='12:'+proof.setupRunId,row=next.snapshot.runs[key];
      try{
        need(next.snapshot.activeRun===key&&next.snapshot.eventCount===pre.snapshot.eventCount+1&&record(row));
        exact(row,['nativeCaptureVersion','sequence','atMs','event',...Object.keys(event).filter(k=>k!=='kind')]);
        for(const k of Object.keys(event).filter(k=>k!=='kind'))need(equal(row[k],event[k]));
        need(row.event==='case12_setup_reserved'&&row.nativeCaptureVersion===1&&row.sequence===next.snapshot.eventCount&&Number.isSafeInteger(row.atMs)&&row.atMs>=Date.parse(proof.admittedAt)&&row.atMs<Date.parse(proof.deadlineAt));
        const expectedSnapshot={...pre.snapshot,eventCount:pre.snapshot.eventCount+1,activeRun:key,runs:{...pre.snapshot.runs,[key]:row},committedCostMicros:pre.snapshot.committedCostMicros+proof.maxCostMicros,remainingReservationMicros:pre.snapshot.remainingReservationMicros-proof.maxCostMicros,case12CommittedCostMicros:proof.maxCostMicros,case12RemainingCostMicros:CASE_MICROS-proof.maxCostMicros};
        need(equal(next.snapshot,expectedSnapshot));
        need(equal(Object.keys(next.snapshot.runs).sort(),[...Object.keys(pre.snapshot.runs),key].sort()));
        for(const [oldKey,oldRow] of Object.entries(pre.snapshot.runs))need(equal(next.snapshot.runs[oldKey],oldRow));
        need(equal(next.state.directories,pre.state.directories)&&equal(Object.keys(next.state.files).sort(),Object.keys(pre.state.files).sort()));
        for(const name of Object.keys(pre.state.files).filter(n=>n!=='fresh-spend.jsonl'))need(equal(next.state.files[name],pre.state.files[name]));
        const before=pre.state.files['fresh-spend.jsonl'],after=next.state.files['fresh-spend.jsonl'];
        need(equal(after.identity,before.identity)&&typeof after.sha256==='string'&&HASH.test(after.sha256)&&after.sha256!==before.sha256&&Number.isSafeInteger(after.bytes)&&after.bytes>before.bytes);
      }catch{poisoned=true;throw Error('CASE12_SETUP_NATIVE_RESERVE_UNPROVED_HOLD_RETAINED');}
      current=next;const handle=Object.freeze({});handles.set(handle,{proof,reservationId,pre,post:next,phase:'RESERVED'});return handle;
    });},
    bindProviderPlan(handle,input){return exclusive(async()=>{
      const b=owned(handle);need(b.phase==='RESERVED');live(b);
      const candidate=snapshot(input),validated=snapshot(await ports.validateProviderPlan(candidate));need(equal(candidate,validated));const p=b.proof;
      for(const k of ['fixtureInstanceId','fixtureNamespace','tenantId','proposerUserId','reviewerUserId','clientId','setupPlanSha256','recipeSha256','orderedDefinitionSha256','sourceSha256','imageSha256','rateEvidenceSha256','rates','ratesExpiresAt','admittedAt','deadlineAt','maxCostMicros'])need(equal(candidate[k],p[k]));
      need(candidate.version===1&&candidate.caseId==='12'&&candidate.runId===p.setupRunId&&candidate.aggregateReservationId===b.reservationId&&candidate.aggregateCheckpointSha256===hash(b.pre));
      need(Array.isArray(candidate.rows)&&candidate.rows.length===510&&hash(candidate.rows)===p.providerRowsSha256);
      need(new Set(candidate.rows.map(r=>r.candidateId)).size===510&&candidate.rows.every((r,i)=>r.logicalId===(i===0?'MA510':`MA510-DISTRACTOR-${String(i).padStart(4,'0')}`)));
      b.plan=candidate;b.phase='PLAN_BOUND';return snapshot({providerPlanSha256:hash(candidate)});
    });},
    claimDispatch(handle){return exclusive(async()=>{
      const b=owned(handle);need(b.phase==='PLAN_BOUND');live(b);await recheck();live(b);
      b.phase='CLAIMED';b.input=snapshot({setupRunId:b.proof.setupRunId,reservationId:b.reservationId,fixtureInstanceId:b.proof.fixtureInstanceId,setupPlanSha256:b.proof.setupPlanSha256,providerPlanSha256:hash(b.plan),preHoldCheckpointSha256:hash(b.pre),postHoldCheckpointSha256:hash(b.post),costAuthoritySha256:hash(b.proof),providerPlan:b.plan,dispatch:{startedBy:'c12-'+randomUUID(),registrationMarker:randomUUID()}});return scope(b);
    });},
    bindDispatch(handle,input){return exclusive(async()=>{
      const b=owned(handle);need(b.phase==='CLAIMED');exact(input,['taskDefinitionArn','inputByteSha256']);
      need(typeof input.taskDefinitionArn==='string'&&/^arn:aws:ecs:us-east-1:967807252336:task-definition\/capiro-dev-meri-c2-case12-setup(?:-[a-z0-9-]+)?:[1-9][0-9]*$/u.test(input.taskDefinitionArn)&&typeof input.inputByteSha256==='string'&&HASH.test(input.inputByteSha256));
      live(b);await recheck();live(b);b.boundDispatch=snapshot(input);b.phase='DISPATCH_BOUND';return scope(b);
    });},
    bindTask(handle,taskArn){return exclusive(async()=>{
      const b=owned(handle);need(b.phase==='DISPATCH_BOUND'&&typeof taskArn==='string'&&/^arn:aws:ecs:us-east-1:967807252336:task\/capiro-dev\/[a-f0-9]{32}$/u.test(taskArn));
      await recheck();b.taskArn=taskArn;b.phase='TASK_BOUND';return scope(b);
    });},
    compactInput(handle){
      const b=owned(handle);need(['CLAIMED','DISPATCH_BOUND','TASK_BOUND'].includes(b.phase));
      const full=scope(b),providerEnvelope=Object.fromEntries(['runId','aggregateReservationId','sourceSha256','imageSha256','aggregateCheckpointSha256','rateEvidenceSha256','rates','ratesExpiresAt','admittedAt','deadlineAt'].map(k=>[k,b.plan[k]]));
      const {providerPlan,...identity}=full;return snapshot({kind:'meri-case12-native-setup-input',version:1,...identity,providerEnvelope});
    },
    currentScope(handle){return exclusive(async()=>{const b=owned(handle);need(['CLAIMED','DISPATCH_BOUND','TASK_BOUND'].includes(b.phase));await recheck();return scope(b);});}
  };
  return Object.freeze(owner);
}
