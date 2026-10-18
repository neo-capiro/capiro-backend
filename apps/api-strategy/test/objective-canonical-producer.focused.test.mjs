import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
const custody = [];
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function load(path, replacements = []) {
  const raw = await readFile(new URL(path, import.meta.url), 'utf8');
  let source = raw;
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length, 2, from); source = source.replace(from, JSON.stringify(to));
  }
  custody.push({ path, sha256: createHash('sha256').update(raw).digest('hex') });
  return url(stripTypeScriptTypes(source));
}
const applicationUrl = await load('../src/planner/objective-canonical-application.ts');
const generationUrl = await load('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl],
]);
// Dependency shims only: no Nest framework/HTTP graph is qualified. The actual
// Objective outcome validator is loaded unchanged from its owner source.
const nest = url('export class BadRequestException extends Error{}; export class ConflictException extends Error{};');
const enums = url(`export const STRATEGY_TYPES=${JSON.stringify(['appropriations','authorization','regulatory','coalition','procurement','earmark','amendment'])};`);
const objectiveUrl = await load('../src/meri/objective-generation.types.ts', [
  ["'@nestjs/common'", nest], ["'../strategy/dto/create-strategy.dto.js'", enums],
]);
const producerUrl = await load('../src/meri/objective-canonical-producer.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl],
  ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-generation.types.js'", objectiveUrl],
]);
const ledgerUrl = await load('../src/meri/objective-canonical-producer-ledger.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl],
  ["'./objective-canonical-generation.js'", generationUrl], ["'./objective-canonical-producer.js'", producerUrl],
]);
const draftUrl = await load('../src/meri/objective-canonical-draft.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl],
  ["'./objective-canonical-generation.js'", generationUrl],
]);
const app = await import(applicationUrl), generation = await import(generationUrl), producer = await import(producerUrl);
const ledger = await import(ledgerUrl), draft = await import(draftUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const copy = structuredClone;
function fixture() {
  const a = { schemaVersion: 1, namespace: generation.GENERATION_ADMISSION_NAMESPACE,
    canonical: { canonicalPlanId: id(1),tenantId: id(2),clientId: id(3),objectiveId: id(4),canonicalStrategyId:id(5),
      canonicalProjectId:id(6),bindingVersion:1,epoch:1,requestedIntentId:id(7),requestedObjectiveRevisionId:id(8),
      requestedObjectiveVersion:1,snapshotHash:'a'.repeat(64) },actorUserId:id(9),clerkUserId:'user_fixture',
    consentId:id(10),controlVersion:1,generationJobId:id(11),generationRequestId:id(12),admittedAtMs:1000,
    effectExpiresAtMs:20000,expectedStrategyVersionId:null };
  const binding={tenantId:id(2),actorId:a.clerkUserId,conversationId:id(13),runId:id(14),attemptId:id(15),workerId:id(16),writerFence:7};
  const accepted={schemaVersion:1,sourceAdmissionSha256:app.applicationHash(a),sourceBinding:binding,
    sourceRequestSha256:'b'.repeat(64),acceptedAtMs:1100,issuance:{issuanceKey:app.applicationHash(binding),binding,
      requestSha256:'b'.repeat(64),expiresAtMs:19000,grantId:id(17),capabilitySha256:'c'.repeat(64),factsSha256:'d'.repeat(64)}};
  const context={state:'complete',packetId:id(18),compiledAt:new Date(1050).toISOString(),sourceDigest:'e'.repeat(64),
    coverageDigest:'f'.repeat(64),inputDigest:'1'.repeat(64),issues:[],reobservedAt:new Date(1150).toISOString()};
  const receipt={schemaVersion:1,requestId:a.generationRequestId,source:{clientId:id(3),objectiveId:id(4),objectiveVersion:1,objectiveRevisionId:id(8)},
    context,result:{strategyId:id(5),strategyVersionId:id(19),savedAt:new Date(1200).toISOString(),sourceDigest:context.sourceDigest,
      contextPacketId:context.packetId,coverageDigest:context.coverageDigest,inputDigest:context.inputDigest},failure:null};
  const request={requestId:a.generationRequestId,clientId:id(3),objective:{objectiveId:id(4),objectiveVersion:1},type:'authorization'};
  const source={admission:a,acceptance:accepted,jobId:a.generationJobId,requestId:a.generationRequestId,attempt:2,
    coreFingerprint:app.applicationHash(request),receipt,strategyId:id(5),strategyVersionId:id(19),snapshotDigest:'2'.repeat(64)};
  const work={canonical:a.canonical,actorUserId:a.actorUserId,consentId:id(20),controlVersion:3,
    generationJobId:a.generationJobId,generationRequestId:a.generationRequestId,strategyId:id(5),strategyVersionId:id(19),
    objectiveReceiptSha256:app.applicationHash(receipt),snapshotDigest:source.snapshotDigest,
    applicationRequestId:app.canonicalApplicationRequestId(a.canonical,a.actorUserId)};
  const rows=new Map(), nodes=[], creates=[];
  const row=(kind,data)=>({id:generation.generationLedgerId(kind,id(2),a.clerkUserId,a.generationJobId),tenantId:id(2),
    ownerId:a.clerkUserId,kind,projectId:null,archived:false,version:1,shareTokenHash:null,data:copy(data)});
  for(const [kind,data]of [[generation.GENERATION_ADMISSION,a],[generation.GENERATION_ACCEPTANCE,accepted]]){
    const r=row(kind,data); rows.set(r.id,r);
  }
  const job={id:a.generationJobId,tenantId:id(2),clientId:id(3),ownerUserId:a.clerkUserId,status:'completed',strategyId:id(5),attempt:2,
    input:{canonicalGeneration:ledger.generationMarker(a),objectiveGeneration:{request,fingerprint:source.coreFingerprint,receipt}}};
  const version={id:id(19),strategyId:id(5),tenantId:id(2),coalescible:false,authorKind:'meri',authorUserId:a.clerkUserId,
    snapshot:{meta:{id:id(5),clientId:id(3)},nodes:[]}};
  source.snapshotDigest=app.applicationHash(version.snapshot); work.snapshotDigest=source.snapshotDigest;
  const tx={spPlannerResource:{findFirst:async({where})=>copy(rows.get(where.id)??null),create:async({data})=>{
    creates.push(copy(data));const r=row(data.kind,data.data); if(rows.has(r.id))throw Error('duplicate');rows.set(r.id,r);return copy(r);}},
    spDraftJob:{findFirst:async({where})=>where.id===job.id&&where.tenantId===job.tenantId?copy(job):null},
    spVersion:{findFirst:async({where})=>where.id===version.id&&where.tenantId===version.tenantId&&where.strategyId===version.strategyId?copy(version):null},
    spNode:{findMany:async({where})=>where.tenantId===a.canonical.tenantId&&where.strategyId===a.canonical.canonicalStrategyId?copy(nodes):[]}};
  return {a,accepted,source,work,rows,job,version,tx,nodes,creates};
}
/** Synthetic owner rows, not a DB transaction/authority or authentic model result. */
function normalizationFixture() {
  const x=fixture();
  const candidate={type:'authorization',rationale:'Private synthetic normalization rationale',summary:'Exact initial summary',
    nodes:['first_step','second_step'].map((sourceNodeKey,i)=>({sourceNodeKey,kind:'action',subject:'deliverable',
      title:`Step ${i+1}`,note:null,status:'draft',ownerRef:null,startsOn:'2026-10-16',endsOn:null,openEnded:false,
      sources:[],dependsOn:i?['first_step']:[]})),
    coverage:{complete:false,omitted:[],assumptions:['Synthetic pending source'],sources:[],
      pendingSources:[{section:'steward',ref:'synthetic-pending'}]}};
  x.normalized=draft.normalizeCanonicalDraft(candidate,{admission:x.a,queuedType:'authorization'});
  x.job.status='running';x.job.strategyId=null;x.job.claimedBy=`canonical:${x.accepted.issuance.issuanceKey}`;
  x.job.claimedAt=new Date(x.accepted.acceptedAtMs);x.job.input.dto={clientId:x.a.canonical.clientId,type:'authorization'};
  x.job.input.objectiveGeneration.receipt.result=null;
  x.version.snapshot.meta={...x.version.snapshot.meta,type:'authorization',meriSummary:x.normalized.response.summary,
    createdByUserId:x.a.clerkUserId};
  x.version.snapshot.nodes=x.normalized.response.nodes.map((node,i)=>{
    const {dependsOn,...fields}=node;
    return {id:x.normalized.nodeIds[i],...fields,dependsOnIds:dependsOn.map(index=>x.normalized.nodeIds[index]),
      meriAuthored:true,createdByUserId:x.a.clerkUserId,createdAt:new Date(1200).toISOString()};
  }).reverse(); // Snapshot ordering is independent of source-key mapping order.
  x.nodes.push(...x.normalized.nodeIds.map(nodeId=>({id:nodeId})).reverse());
  x.saved={strategyId:x.a.canonical.canonicalStrategyId,strategyVersionId:x.version.id};
  return x;
}
const recordNormalization=x=>ledger.recordCanonicalNormalization(x.tx,x.a.canonical.tenantId,x.a.clerkUserId,x.a.generationJobId,x.saved,x.normalized);
test('whole producer envelope and work hashes retain different domains and phase binding',()=>{
  const {work}=fixture(), body={schemaVersion:1,phase:'prepare',work};
  assert.deepEqual(producer.parseCanonicalProducerRequest(body),body);
  assert.notEqual(app.applicationHash(body),app.applicationHash(work));
  assert.notEqual(app.applicationHash(body),app.applicationHash({...body,phase:'read'}));
  assert.notEqual(app.applicationHash(body),app.applicationHash(producer.producerApplication(work)));
});
test('refuses extras, actor substitution, malformed UUID and arbitrary application identity',()=>{
  const {work}=fixture();
  for(const body of [{schemaVersion:1,phase:'prepare',work,credential:'no'},
    {schemaVersion:1,phase:'prepare',work:{...work,actorUserId:id(99)}},
    {schemaVersion:1,phase:'prepare',work:{...work,consentId:id(20)+'\n'}},
    {schemaVersion:1,phase:'prepare',work:{...work,applicationRequestId:id(99)}}])
    assert.throws(()=>producer.parseCanonicalProducerRequest(body),e=>e.code==='INPUT_INVALID');
});
test('two action consents differ and genuine saved output still correlates',()=>{
  const x=fixture(), saved=producer.canonicalGenerationProducer(x.source);
  assert.notEqual(x.a.consentId,x.work.consentId);
  assert.doesNotThrow(()=>producer.requireCanonicalProducerWork(saved,x.work));
});
test('original accepted request hash is not Core fingerprint or semantic admission hash',()=>{
  const x=fixture(), saved=producer.canonicalGenerationProducer(x.source);
  assert.notEqual(saved.acceptance.sourceRequestSha256,saved.generation.coreFingerprint);
  assert.notEqual(saved.acceptance.issuance.factsSha256,saved.acceptance.sourceAdmissionSha256);
});
test('rejects late or pre-acceptance save, wrong output/version and forged complete source',()=>{
  for(const change of [x=>{x.source.receipt.result.savedAt=new Date(19000).toISOString();},
    x=>{x.source.receipt.result.savedAt=new Date(1099).toISOString();},x=>{x.source.strategyId=id(90);},
    x=>{x.source.strategyVersionId=id(90);},x=>{x.source.receipt.source.objectiveRevisionId=id(90);}]){
    const x=fixture();change(x);assert.throws(()=>producer.canonicalGenerationProducer(x.source),e=>e.code==='OUTCOME_UNCONFIRMED');
  }
});
test('same owner insert-only receipt replays exact source; conflict does not update',async()=>{
  const x=fixture(); const saved=await ledger.recordCanonicalGenerationProducer(x.tx,id(2),x.a.clerkUserId,x.a.generationJobId);
  const before=copy([...x.rows]);
  assert.deepEqual(await ledger.readCanonicalGenerationProducer(x.tx,id(2),x.a.clerkUserId,x.a.generationJobId),saved);
  assert.deepEqual(await ledger.recordCanonicalGenerationProducer(x.tx,id(2),x.a.clerkUserId,x.a.generationJobId),saved);
  await assert.rejects(()=>ledger.insertGenerationLedger(x.tx,generation.GENERATION_PRODUCER,id(2),x.a.clerkUserId,x.a.generationJobId,
    {...saved,snapshotDigest:'f'.repeat(64)}),e=>e.code==='REQUEST_CONFLICT');
  assert.deepEqual([...x.rows],before);
});
test('retained producer reconstruction has no host-clock or current-source dependency',async()=>{
  const x=fixture();await ledger.recordCanonicalGenerationProducer(x.tx,id(2),x.a.clerkUserId,x.a.generationJobId);
  assert.ok(Date.now()>x.accepted.issuance.expiresAtMs);
  const value=await ledger.readCanonicalGenerationProducer(x.tx,id(2),x.a.clerkUserId,x.a.generationJobId);
  assert.equal(value.acceptance.issuance.expiresAtMs,19000);
  // This is custody reconstruction only. Real service separately checks fresh authority.
});
test('lost/corrupt association, mutable private rows and wrong snapshot client refuse',async()=>{
  for(const change of [x=>{x.rows.delete(generation.generationLedgerId(generation.GENERATION_ACCEPTANCE,id(2),x.a.clerkUserId,x.a.generationJobId));},
    x=>{x.rows.get(generation.generationLedgerId(generation.GENERATION_ADMISSION,id(2),x.a.clerkUserId,x.a.generationJobId)).version=2;},
    x=>{x.job.input.objectiveGeneration.fingerprint='0'.repeat(64);},x=>{x.version.snapshot.meta.clientId=id(99);},
    x=>{x.job.input.canonicalGeneration.admissionId=id(99);}]){
    const x=fixture();change(x);await assert.rejects(()=>ledger.recordCanonicalGenerationProducer(x.tx,id(2),x.a.clerkUserId,x.a.generationJobId));
    assert.equal(x.rows.has(generation.generationLedgerId(generation.GENERATION_PRODUCER,id(2),x.a.clerkUserId,x.a.generationJobId)),false);
  }
});
test('current work cannot silently adopt a different actor, source version or receipt',()=>{
  const x=fixture(), saved=producer.canonicalGenerationProducer(x.source);
  for(const changed of [{...x.work,actorUserId:id(99)},{...x.work,strategyVersionId:id(99)},
    {...x.work,objectiveReceiptSha256:'0'.repeat(64)}])
    assert.throws(()=>producer.requireCanonicalProducerWork(saved,changed),e=>e.code==='REQUEST_CONFLICT');
});
test('retained stored producer corruption refuses instead of being treated as absent',async()=>{
  const x=fixture();await ledger.recordCanonicalGenerationProducer(x.tx,id(2),x.a.clerkUserId,x.a.generationJobId);
  x.rows.get(generation.generationLedgerId(generation.GENERATION_PRODUCER,id(2),x.a.clerkUserId,x.a.generationJobId)).data.snapshotDigest='0'.repeat(64);
  await assert.rejects(()=>ledger.readCanonicalGenerationProducer(x.tx,id(2),x.a.clerkUserId,x.a.generationJobId),e=>e.code==='OUTCOME_UNCONFIRMED');
});
test('initial normalization records the exact private witness and source-key to actual-node mapping',async()=>{
  const x=normalizationFixture(), before=copy(x.normalized), value=await recordNormalization(x);
  assert.deepEqual(value.normalizationWitness,before.normalizationWitness);
  assert.deepEqual(value.nodes,before.sourceKeys.map((sourceNodeKey,i)=>({sourceNodeKey,nodeId:before.nodeIds[i]})));
  assert.equal(value.generationJobId,x.a.generationJobId);assert.equal(value.generationRequestId,x.a.generationRequestId);
  assert.equal(value.sourceAdmissionId,generation.generationLedgerId(generation.GENERATION_ADMISSION,id(2),x.a.clerkUserId,x.a.generationJobId));
  assert.equal(value.sourceAdmissionSha256,app.applicationHash(x.a));
  assert.equal(value.sourceAcceptanceId,generation.generationLedgerId(generation.GENERATION_ACCEPTANCE,id(2),x.a.clerkUserId,x.a.generationJobId));
  assert.equal(value.sourceAcceptanceSha256,app.applicationHash(x.accepted));
  assert.equal(value.strategyId,x.saved.strategyId);assert.equal(value.strategyVersionId,x.version.id);
  assert.equal(value.snapshotDigest,app.applicationHash(x.version.snapshot));
  assert.equal(app.applicationHash(value.nodes.map(n=>n.sourceNodeKey)),value.normalizationWitness.sourceKeysSha256);
  assert.equal(app.applicationHash(value.nodes.map(n=>n.nodeId)),value.normalizationWitness.nodeIdsSha256);
  const row=x.rows.get(generation.generationLedgerId(generation.GENERATION_NORMALIZATION,id(2),x.a.clerkUserId,x.a.generationJobId));
  assert.deepEqual(row.data,value);assert.equal(row.ownerId,x.a.clerkUserId);assert.equal(row.shareTokenHash,null);
  assert.equal(x.creates.length,1);
  assert.deepEqual({projectId:x.creates[0].projectId,version:x.creates[0].version,archived:x.creates[0].archived,
    shareTokenHash:x.creates[0].shareTokenHash},{projectId:null,version:1,archived:false,shareTokenHash:null});
  assert.deepEqual(x.normalized,before);assert.equal(x.job.status,'running');
});
test('wrong claim, saved version/node or normalization witness refuses before any private row insertion',async()=>{
  const changes=[x=>{x.job.claimedBy='canonical:wrong';},x=>{x.job.attempt=3;},x=>{x.job.ownerUserId='user_other';},
    x=>{x.version.id=id(99);},x=>{x.version.coalescible=true;},x=>{x.version.authorUserId='user_other';},
    x=>{x.version.snapshot.meta.clientId=id(99);},x=>{x.version.snapshot.meta.type='appropriations';},
    x=>{x.version.snapshot.meta.meriSummary='changed';},x=>{x.version.snapshot.nodes.pop();},
    x=>{x.version.snapshot.nodes[1].id=x.version.snapshot.nodes[0].id;},x=>{x.nodes[0].id=id(99);},
    x=>{x.nodes.pop();},x=>{x.normalized=copy(x.normalized);x.normalized.normalizationWitness.sourceAdmissionSha256='0'.repeat(64);},
    x=>{x.normalized=copy(x.normalized);x.normalized.normalizationWitness.normalizedResponseSha256='0'.repeat(64);},
    x=>{x.normalized=copy(x.normalized);x.normalized.normalizationWitness.nodeIdsSha256='0'.repeat(64);},
    x=>{x.normalized=copy(x.normalized);x.normalized.normalizationWitness.sourceKeysSha256='0'.repeat(64);}];
  for(const change of changes){
    const x=normalizationFixture();change(x);const before=copy([...x.rows]);
    await assert.rejects(()=>recordNormalization(x),e=>e.code==='OUTCOME_UNCONFIRMED');
    assert.deepEqual([...x.rows],before);assert.equal(x.creates.length,0);
  }
});
test('normalization exact replay inserts once; a conflicting witnessed payload never updates the private record',async()=>{
  const x=normalizationFixture(), first=await recordNormalization(x), before=copy([...x.rows]);
  assert.deepEqual(await recordNormalization(x),first);assert.equal(x.creates.length,1);
  x.normalized=copy(x.normalized);x.normalized.normalizationWitness.rationale='Different private rationale';
  await assert.rejects(()=>recordNormalization(x),e=>e.code==='REQUEST_CONFLICT');
  assert.deepEqual([...x.rows],before);assert.equal(x.creates.length,1);
});
test('all four private generation kinds refuse share-token metadata instead of returning owner-private data',async()=>{
  for(const kind of [generation.GENERATION_ADMISSION,generation.GENERATION_ACCEPTANCE,generation.GENERATION_PRODUCER,generation.GENERATION_NORMALIZATION]){
    const x=kind===generation.GENERATION_NORMALIZATION?normalizationFixture():fixture();
    if(kind===generation.GENERATION_PRODUCER)await ledger.recordCanonicalGenerationProducer(x.tx,id(2),x.a.clerkUserId,x.a.generationJobId);
    if(kind===generation.GENERATION_NORMALIZATION)await recordNormalization(x);
    const row=x.rows.get(generation.generationLedgerId(kind,id(2),x.a.clerkUserId,x.a.generationJobId));
    row.shareTokenHash='f'.repeat(64);const before=copy([...x.rows]);
    await assert.rejects(()=>ledger.readGenerationLedger(x.tx,kind,id(2),x.a.clerkUserId,x.a.generationJobId),e=>e.code==='OUTCOME_UNCONFIRMED');
    if(kind===generation.GENERATION_NORMALIZATION)await assert.rejects(()=>recordNormalization(x),e=>e.code==='OUTCOME_UNCONFIRMED');
    assert.deepEqual([...x.rows],before);
  }
});
console.log(JSON.stringify({sourceCustody:custody,qualification:'source fixtures; no database/HTTP/current authority proof'}));
