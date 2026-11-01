import test from 'node:test';
import assert from 'node:assert/strict';
import { projectObjectiveSourceEvidence } from '../src/context/objective-generation-evidence.ts';
import { selectStrategyReferenceRows } from '../../../packages/shared/src/strategy-reference-selection.ts';
import { hasOriginalAcceptedCitation, projectSavedObjectiveCitations } from '../../api-strategy/src/strategy/objective-saved-citations.ts';
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-11-01T09:00:00.000Z', before = '2026-11-01T08:00:00.000Z', client = id(1);
function fact() { return {domain:'strategies_work', recordId:id(2), payload: {
  kind:'context_fact', id:id(2), clientId:client, documentId:id(3), documentTitle:'Approved brief', state:'active',
  fact:'A retained approved fact.', sourceRef:'section:1', authority:'firm_approved', asOf:before, citation:null, updatedAt:before,
  documentWitness:{clientId:client,scope:'client',state:'active',checksum:'a'.repeat(64),revision:'revision-1',
    authority:'firm_approved',sourceOfTruth:true,validUntil:null,updatedAt:before},
}}; }
function memory() { return {domain:'institutional_knowledge', recordId:id(4), updatedAt:before, payload:{
  sourceKind:'governed_memory',memoryItemId:id(4),clientId:client,scope:'client',title:'Approved direction',
  value:'Use the actual approved body.',contentStatus:'available', governance:{status:'active',stale:false,
    conflictStatus:'none',memoryClass:'client_steering',authority:'client_approved',approvedByUserId:id(5),approvedAt:before},
},provenance:{sourceType:'approved_document_edit',sourceVersion:'version-1',contentHash:'b'.repeat(64)}}; }
const project = rows => projectObjectiveSourceEvidence(rows,client,at);
test('approved fact binds parent document checksum, exact locator, body and current scope', () => {
  const row=fact(), [one]=project([row]); assert.equal(one.reviewState,'accepted'); assert.equal(one.text,row.payload.fact);
  row.payload.documentWitness.checksum='b'.repeat(64); assert.notEqual(project([row])[0].ref,one.ref);
  row.payload.sourceRef='section:2'; assert.notEqual(project([row])[0].ref,one.ref);
});
test('same-client fact with foreign parent, mismatched shared scope or retired parent is never admitted', () => {
  for (const change of [{clientId:id(9)},{scope:'strategy'},{state:'archived'},{checksum:'not-a-hash'}]) {
    const row=fact(); Object.assign(row.payload.documentWitness,change); assert.deepEqual(project([row]),[]);
  }
  const row=fact(); row.payload.clientId=null; row.payload.documentWitness.clientId=null;
  assert.deepEqual(project([row]),[]); row.payload.documentWitness.scope='firm'; assert.equal(project([row])[0].scope,'tenant-shared');
});
test('working draft and unapproved extracted evidence remain pending', () => {
  const row=fact(); row.payload.documentWitness.authority='working_draft'; assert.equal(project([row])[0].reviewState,'pending');
  row.payload.state='rejected'; assert.deepEqual(project([row]),[]);
});
test('client-approved source-of-truth retains its owning approval, while mismatched fact authority stays pending', () => {
  const row=fact(); row.payload.documentWitness.authority='client_approved'; row.payload.authority='client_approved';
  assert.equal(project([row])[0].reviewState,'accepted'); row.payload.authority='working_draft';
  assert.equal(project([row])[0].reviewState,'pending');
});
test('memory cites actual body and current approved nonconflicting owner state, not title alone', () => {
  const row=memory(), [one]=project([row]); assert.equal(one.text,row.payload.value); assert.equal(one.reviewState,'accepted');
  row.payload.value='Changed canonical body'; assert.notEqual(project([row])[0].ref,one.ref);
  row.payload.governance.approvedAt=null; assert.equal(project([row])[0].reviewState,'pending');
  row.payload.contentStatus='metadata_only'; assert.deepEqual(project([row]),[]);
  row.payload.contentStatus='available'; row.payload.governance.conflictStatus='open'; assert.deepEqual(project([row]),[]);
});
test('long approved memory keeps full generation body and hash while citation display explicitly bounds its excerpt', () => {
  const row=memory(); row.payload.value='A'.repeat(50000); const original=project([row]);
  assert.equal(original[0].text.length,50000);
  const citation=projectSavedObjectiveCitations(saved(original),original).nodes[0].citations[0];
  assert.equal(citation.text.length,24000); assert.equal(citation.textComplete,false);
  row.payload.value+='B'; assert.notEqual(project([row])[0].ref,original[0].ref);
  assert.equal(projectSavedObjectiveCitations(saved(original),project([row])).nodes[0].citations[0].state,'changed');
});
test('calendar owner selects override per kind without baseline leakage or date conversion', () => {
  const baseline=[{id:id(10),kind:'congress_milestone',label:'Baseline',fy:null,startsOn:'2026-11-01',endsOn:'2026-12-01',tone:null,position:0},
    {id:id(11),kind:'ppbe_lane_bar',label:'Lane',fy:2027,startsOn:null,endsOn:null,tone:null,position:1}];
  const override={...baseline[0],id:id(12),label:'Override'};
  const selected=selectStrategyReferenceRows(baseline,[override]).map(({source,row})=>({...row,source}));
  assert.deepEqual(selected.map(r=>r.id),[id(12),id(11)]);
  const evidence=projectObjectiveSourceEvidence([],client,at,selected);
  assert.match(evidence.find(e=>e.sourceId===id(12)).text,/start: 2026-11-01; end: 2026-12-01/);
  override.startsOn='2026-11-02'; const changed=selectStrategyReferenceRows(baseline,[override]).map(({source,row})=>({...row,source}));
  assert.notEqual(projectObjectiveSourceEvidence([],client,at,changed).find(e=>e.sourceId===id(12)).ref,evidence.find(e=>e.sourceId===id(12)).ref);
});
function saved(evidence) { return {review:{source:{snapshotDigest:'immutable'}},evidence,
  nodes:[{id:id(20),provenance:{sources:evidence.map(e=>({section:'Untrusted display label',ref:e.ref}))}}]}; }
test('empty or unadmitted original citations need no unrelated current-source read', () => {
  const empty=saved([]); assert.equal(hasOriginalAcceptedCitation(empty),false);
  assert.deepEqual(projectSavedObjectiveCitations(empty,[]).nodes[0].citations,[]);
  const state=saved(project([fact()])); assert.equal(hasOriginalAcceptedCitation(state),true);
  state.evidence=[]; assert.equal(hasOriginalAcceptedCitation(state),false);
  assert.deepEqual(projectSavedObjectiveCitations(state,[]).nodes[0].citations,[{index:0,state:'unavailable'}]);
});
test('saved citations require original accepted publication and same immutable source; no newer text substitution', () => {
  const original=project([fact()]), state=saved(original), prior=structuredClone(state);
  assert.equal(projectSavedObjectiveCitations(state,original).nodes[0].citations[0].state,'available');
  const refreshed=structuredClone(original); refreshed[0].asOfMs+=10000;
  assert.equal(projectSavedObjectiveCitations(state,refreshed).nodes[0].citations[0].asOfMs,original[0].asOfMs);
  const changed=fact(); changed.payload.fact='New text must not replace original';
  const value=projectSavedObjectiveCitations(state,project([changed])).nodes[0].citations[0];
  assert.equal(value.state,'changed'); assert.equal(Object.hasOwn(value,'text'),false); assert.deepEqual(state,prior);
});
test('revoked, missing, substituted foreign and pending sources reveal no retained content or locator', () => {
  const evidence=project([fact()]), state=saved(evidence);
  assert.deepEqual(projectSavedObjectiveCitations(state,[]).nodes[0].citations,[{index:0,state:'unavailable'}]);
  state.evidence=[]; assert.deepEqual(projectSavedObjectiveCitations(state,evidence).nodes[0].citations,[{index:0,state:'unavailable'}]);
  state.evidence=[{...evidence[0],reviewState:'pending'}];
  assert.deepEqual(projectSavedObjectiveCitations(state,evidence).nodes[0].citations,[{index:0,state:'unavailable'}]);
});
