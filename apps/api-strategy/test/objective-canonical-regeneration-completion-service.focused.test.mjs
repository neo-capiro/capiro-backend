// Actual completion service, saved-generation helper, normalizers and input
// checker. SQL/current authority/retained codecs/persistence/Strategy writer
// are named synthetic ports. No SDK, DB CAS, native concurrency, genuine
// custody, Nest provider graph or semantic TypeScript qualification is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const custody = [], slot = Symbol.for('capiro.regeneration-completion-service.synthetic');
const copy = v => structuredClone(v);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hex = c => c.repeat(64);
const data = s => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
async function source(path, imports = [], injectable = false, mode = 'strip') {
  const url = new URL(path, import.meta.url), raw = await readFile(url, 'utf8');
  let text = raw;
  if (injectable) { assert.equal(text.split('@Injectable()').length, 2); text = text.replace('@Injectable()', ''); }
  for (const [from, to] of imports) { assert.equal(text.split(from).length, 2, from); text = text.replace(from, JSON.stringify(to)); }
  const stripped = stripTypeScriptTypes(text, { mode, sourceUrl: url.href });
  custody.push({ path, rawSha256: createHash('sha256').update(raw).digest('hex'),
    transformedSha256: createHash('sha256').update(stripped).digest('hex'), mode,
    imports: imports.map(([from]) => from), decoratorRemoved: injectable });
  return data(stripped);
}
const appUrl = await source('../src/planner/objective-canonical-application.ts');
const genUrl = await source('../src/meri/objective-canonical-generation.ts', [["'../planner/objective-canonical-application.js'", appUrl]]);
const normalizerUrl = await source('../src/meri/objective-canonical-draft.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", genUrl],
]);
const inputUrl = await source('../src/meri/objective-canonical-job-input.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", genUrl],
]);
const app = await import(appUrl), gen = await import(genUrl);
const VERSION = 'capiro.objective-strategy.regeneration-request/20261016.1';
const nest = data(`export const Injectable=()=>x=>x;export class HttpException extends Error{constructor(body,status){super(body.code);this.body=body;this.status=status;}getResponse(){return this.body;}getStatus(){return this.status;}}`);
const ports = data(`
  import assert from 'node:assert/strict';
  import {applicationHash,CanonicalApplicationError} from ${JSON.stringify(appUrl)};
  export {GENERATION_ADMISSION,GENERATION_ACCEPTANCE,GENERATION_NORMALIZATION,GENERATION_PRODUCER,
    generationLedgerId,canonicalGenerationAdmissionSha256} from ${JSON.stringify(genUrl)};
  export {deriveCanonicalJobInput} from ${JSON.stringify(inputUrl)};
  import {normalizeCanonicalDraft as initial,normalizeCanonicalRegenerationDraft as regen} from ${JSON.stringify(normalizerUrl)};
  const state=()=>globalThis[Symbol.for('capiro.regeneration-completion-service.synthetic')];
  const clone=v=>structuredClone(v),fail=(code='OUTCOME_UNCONFIRMED')=>{throw new CanonicalApplicationError(code);};
  export class PrismaService{};export class ObjectiveCanonicalWorkloadAuthority{};export class MeriService{};
  export class ObjectiveCanonicalResultOwner{};export class ObjectiveCanonicalOwnerDirectory{};export class StrategyContextPlaneClient{};
  export const CORE_CANONICAL_REGENERATION_REQUEST_VERSION=${JSON.stringify(VERSION)};
  function row(tx,tenant,clerk,job){const s=state();assert.equal(tx.fixture,s);const r=s.records.get(job);
    if(!r||r.job.tenantId!==tenant||r.job.ownerUserId!==clerk)fail();return r;}
  export async function generationAssociation(tx,tenant,clerk,job){return clone(row(tx,tenant,clerk,job).association);}
  export async function readCanonicalRequestPublication(tx,a){const r=row(tx,a.canonical.tenantId,a.clerkUserId,a.generationJobId);
    if(applicationHash(r.job.input.dto)!==r.originalDtoSha)fail('REQUEST_CONFLICT');
    return clone(r.stored);}
  export async function readCanonicalGenerationProducer(tx,tenant,clerk,job){const r=row(tx,tenant,clerk,job);if(!r.producer)fail();return clone(r.producer);}
  export async function readGenerationLedger(tx,kind,tenant,clerk,job){assert.equal(kind,'objective_canonical_generation_normalization');return clone(row(tx,tenant,clerk,job).normalization);}
  function witness(v,expected,mode){const s=state();s.calls[mode+'Witness']++;if(!v||v.valid!==true)fail();
    assert.equal(v.generationJobId,expected.admission.generationJobId);return clone(v);}
  export const checkCanonicalCompletionWitness=(v,e)=>witness(v,e,'initial');
  export const checkCanonicalRegenerationCompletionWitness=(v,e)=>witness(v,e,'regen');
  export function checkCanonicalRegenerationNormalization(record,e){const s=state();s.calls.normalizationReplay++;
    assert.deepEqual(e.basis,s.originalBasis,'historical replay uses original immutable published basis');
    assert.equal(e.saved.strategyVersionId,s.saved.strategyVersionId);assert.deepEqual(e.saved.snapshot,s.savedSnapshot);
    if(s.normalizationError)fail();assert.deepEqual(record.priorBasis,e.basis);return clone(record);}
  function verified(raw,e,mode){const s=state();s.calls[mode+'Verify']++;assert.equal(raw,s.rawResult);
    assert.deepEqual(e.admission,s.current.association.admission);assert.deepEqual(e.acceptance,s.current.association.acceptance);
    assert.deepEqual(e.publication,s.current.stored.publication);assert.equal(e.nowMs,s.now);
    if(s.codecError)fail();return {payload:clone(raw.payload),witness:clone(raw.witness),checkedAtMs:s.now,expiresAtMs:raw.expiresAtMs};}
  export const verifyRetainedCanonicalCompletion=(raw,e)=>verified(raw,e,'initial');
  export const verifyRetainedCanonicalRegenerationCompletion=(raw,e)=>verified(raw,e,'regen');
  export function normalizeCanonicalDraft(payload,o){state().calls.initialNormalize++;return initial(payload,o);}
  export function normalizeCanonicalRegenerationDraft(payload,o){const s=state();s.calls.regenNormalize++;
    assert.deepEqual(o.basis,s.originalBasis);return regen(payload,o);}
  export async function requireCanonicalGenerationReadWithinTx(tx,a,clerk){const s=state();assert.equal(tx.fixture,s);
    assert.equal(clerk,a.clerkUserId);if(s.readRevoked)fail('AUTHORITY_UNAVAILABLE');}
  export async function requireCanonicalGenerationEffectWithinTx(tx,a,actual){const s=state();s.calls.effect++;
    assert.equal(tx.fixture,s);assert.equal(actual.generationJobId,a.generationJobId);
    if(s.effectUnavailable)fail('SOURCE_STALE');}
  export function objectivePersistence(claim,context,compiled){const s=state();s.calls.persistence++;
    assert.equal(claim.id,s.current.job.id);assert.equal(claim.attempt,2);
    assert.equal(claim.claimToken,'canonical:'+s.current.association.acceptance.issuance.issuanceKey);
    assert.deepEqual(compiled(),s.current.stored.compiled);
    return {beforeTransaction:async()=>{assert.equal(s.depth,0);await context.recheckObjective(claim,compiled());
      claim.input.objectiveGeneration.historyCheckedAt='2026-10-16T00:00:01.000Z';},
      beforeWrite:async tx=>{assert.equal(tx.fixture,s);s.calls.beforeWrite++;
        if(s.current.job.status!=='running'||s.current.job.input.canonicalTerminal!==undefined)fail('REQUEST_CONFLICT');},
      afterWrite:async(tx,saved)=>{assert.equal(tx.fixture,s);s.calls.afterWrite++;
        const r=s.current;r.job.status='completed';r.job.strategyId=saved.strategyId;
        r.job.input=clone(claim.input);r.job.input.canonicalCompletion=clone(claim.completion);
        r.job.input.objectiveGeneration.receipt.result={...saved,savedAt:'2026-10-16T00:00:01.000Z'};
        r.producer={sourceAdmission:clone(r.association.admission),acceptance:clone(r.association.acceptance),
          objectiveReceipt:clone(r.job.input.objectiveGeneration.receipt),snapshotDigest:s.snapshotDigest};
        r.normalization={schemaVersion:s.mode==='regenerate'?2:1,generationJobId:r.job.id,generationRequestId:r.association.admission.generationRequestId,
          sourceAdmissionSha256:applicationHash(r.association.admission),sourceAcceptanceSha256:applicationHash(r.association.acceptance),
          strategyId:saved.strategyId,strategyVersionId:saved.strategyVersionId,snapshotDigest:s.snapshotDigest,
          normalizationWitness:{proposedPayloadSha256:claim.completion.corePayloadSha256},
          ...(s.mode==='regenerate'?{priorBasis:clone(s.originalBasis)}:{})};}
    };}
`);
const savedUrl = await source('../src/meri/objective-canonical-saved-generation.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
  ...['objective-canonical-completion-receipt','objective-canonical-regeneration-completion-receipt','objective-canonical-generation',
    'objective-canonical-producer-ledger','objective-canonical-request-ledger','objective-canonical-regeneration-request',
    'objective-canonical-regeneration-ledger'].map(name => [`'./${name}.js'`, ports]),
]);
const serviceUrl = await source('../src/meri/objective-canonical-completion.service.ts', [
  ["'@nestjs/common'", nest], ["'../planner/objective-canonical-application.js'", appUrl],
  ["'../prisma/prisma.service.js'", ports], ["'../planner/objective-canonical-authority.js'", ports],
  ["'./objective-canonical-saved-generation.js'", savedUrl],
  ...['meri.service','objective-canonical-result-owner','objective-canonical-owner-directory','strategy-context-plane.client',
    'objective-generation-completion','objective-canonical-draft','objective-canonical-completion-receipt',
    'objective-canonical-regeneration-completion-receipt','objective-canonical-producer-ledger','objective-canonical-generation',
    'objective-canonical-request-ledger','objective-canonical-regeneration-request','objective-canonical-job-input',
    'objective-canonical-generation-fence'].map(name => [`'./${name}.js'`, ports]),
], true, 'transform');
const { ObjectiveCanonicalCompletionService } = await import(serviceUrl);
const { readCanonicalSavedGeneration, requireCanonicalBasisCustody } = await import(savedUrl);

function fixture(mode = 'regenerate') {
  const s = { mode, depth: 0, now: 10_000, records: new Map(), versions: new Map(), writes: 0, reads: 0,
    calls: Object.fromEntries(['initialVerify','regenVerify','initialWitness','regenWitness','initialNormalize','regenNormalize',
      'normalizationReplay','effect','persistence','beforeWrite','afterWrite','draftWriter','regenWriter','forbidden','owner'].map(k => [k,0])) };
  const canonical = { canonicalPlanId:id(1),tenantId:id(2),clientId:id(3),objectiveId:id(4),canonicalStrategyId:id(5),canonicalProjectId:id(6),
    bindingVersion:2,epoch:1,requestedIntentId:id(7),requestedObjectiveRevisionId:id(8),requestedObjectiveVersion:2,snapshotHash:hex('a') };
  function record(jobId, requestId, prior = false) {
    const c = prior ? {...canonical,bindingVersion:1,requestedIntentId:id(70),requestedObjectiveRevisionId:id(71),requestedObjectiveVersion:1} : copy(canonical);
    const a = {schemaVersion:1,namespace:gen.GENERATION_ADMISSION_NAMESPACE,canonical:c,actorUserId:id(9),clerkUserId:'user_original',
      consentId:prior?id(72):id(12),controlVersion:prior?1:2,generationJobId:jobId,generationRequestId:requestId,admittedAtMs:1000,effectExpiresAtMs:50_000,
      expectedStrategyVersionId:!prior&&mode==='regenerate'?id(20):null};
    const binding={tenantId:id(2),actorId:'user_original',conversationId:prior?id(73):id(13),runId:prior?id(74):id(14),attemptId:prior?id(75):id(15),workerId:prior?id(76):id(16),writerFence:1};
    const acceptance={schemaVersion:1,sourceAdmissionSha256:app.applicationHash(a),sourceBinding:binding,sourceRequestSha256:hex('b'),acceptedAtMs:1100,
      issuance:{issuanceKey:app.applicationHash(binding),binding,requestSha256:hex('b'),expiresAtMs:45_000,grantId:prior?id(77):id(17),capabilitySha256:hex('c'),factsSha256:hex('d')}};
    const request={requestId,clientId:id(3),objective:{objectiveId:id(4),objectiveVersion:c.requestedObjectiveVersion},type:'authorization'};
    const source={clientId:id(3),objectiveId:id(4),objectiveVersion:c.requestedObjectiveVersion,objectiveRevisionId:c.requestedObjectiveRevisionId};
    const context={state:'complete',packetId:id(18),compiledAt:'2026-10-16T00:00:00.000Z',reobservedAt:null,sourceDigest:hex('1'),coverageDigest:hex('2'),inputDigest:hex('3'),issues:[]};
    const dto={clientId:id(3),type:'authorization',goal:'Original raw goal',meriContext:null,ownerUserId:'user_original',targetDate:null,attachmentIds:[]};
    const job={id:jobId,tenantId:id(2),clientId:id(3),ownerUserId:'user_original',status:'running',attempt:2,claimedBy:'canonical:'+acceptance.issuance.issuanceKey,
      strategyId:null,requestKey:'objective-v1:'+app.applicationHash([id(2),'user_original',requestId]),input:{dto,bearer:null,
        canonicalGeneration:{admissionId:gen.generationLedgerId(gen.GENERATION_ADMISSION,id(2),'user_original',jobId)},
        objectiveGeneration:{request,fingerprint:app.applicationHash(request),receipt:{schemaVersion:1,requestId,source,context,result:null,failure:null}}}};
    return {job,association:{admission:a,acceptance},originalDtoSha:app.applicationHash(dto),stored:{publicationSha256:hex(prior?'4':'5'),
      publication:{request:{basis:null,principal:{ownerActorId:'user_original'}}},compiled:{source,context}},normalization:null,producer:null};
  }
  s.prior=record(id(60),id(61),true);s.current=record(id(10),id(11));
  s.saved={strategyId:id(5),strategyVersionId:id(30)};
  const oldSnapshot={meta:{id:id(5),clientId:id(3),title:'Human original title'},nodes:[{id:id(21),title:'Original retained node'}]};
  s.savedSnapshot={meta:{id:id(5),clientId:id(3),title:'Preserved human title'},nodes:[{id:id(21),title:'Retained node'},{id:id(22),title:'New node'}]};
  s.snapshotDigest=app.applicationHash(s.savedSnapshot);
  const p=s.prior, pa=p.association.admission;
  p.job.status='completed';p.job.strategyId=id(5);p.job.input.canonicalCompletion={valid:true,generationJobId:p.job.id,generationRequestId:pa.generationRequestId,corePayloadSha256:hex('6')};
  p.job.input.objectiveGeneration.receipt.result={strategyId:id(5),strategyVersionId:id(20),savedAt:'2026-10-16T00:00:00.000Z'};
  p.producer={sourceAdmission:copy(pa),acceptance:copy(p.association.acceptance),objectiveReceipt:copy(p.job.input.objectiveGeneration.receipt),snapshotDigest:app.applicationHash(oldSnapshot)};
  p.normalization={schemaVersion:1,generationJobId:p.job.id,generationRequestId:pa.generationRequestId,sourceAdmissionSha256:app.applicationHash(pa),
    sourceAcceptanceSha256:app.applicationHash(p.association.acceptance),strategyId:id(5),strategyVersionId:id(20),snapshotDigest:p.producer.snapshotDigest,
    normalizationWitness:{proposedPayloadSha256:hex('6')}};
  const ref={ownerUserId:'user_original',generationJobId:p.job.id,generationRequestId:pa.generationRequestId,canonicalBindingVersion:1,
    admissionId:gen.generationLedgerId(gen.GENERATION_ADMISSION,id(2),'user_original',p.job.id),admissionSha256:app.applicationHash(pa),
    acceptanceId:gen.generationLedgerId(gen.GENERATION_ACCEPTANCE,id(2),'user_original',p.job.id),acceptanceSha256:app.applicationHash(p.association.acceptance),
    normalizationId:gen.generationLedgerId(gen.GENERATION_NORMALIZATION,id(2),'user_original',p.job.id),normalizationSha256:app.applicationHash(p.normalization),
    producerId:gen.generationLedgerId(gen.GENERATION_PRODUCER,id(2),'user_original',p.job.id),producerSha256:app.applicationHash(p.producer),
    strategyVersionId:id(20),snapshotSha256:p.producer.snapshotDigest};
  const basis={schemaVersion:1,namespace:'capiro.objective-strategy.basis:v1',canonical:copy(canonical),sourceAdmissionSha256:app.applicationHash(s.current.association.admission),
    strategyId:id(5),expectedStrategyVersionId:id(20),snapshot:oldSnapshot,snapshotSha256:app.applicationHash(oldSnapshot),
    sourceIndex:[{sourceNodeKey:'retained',nodeId:id(21)}],archiveIndex:[],provenance:[ref]};
  basis.sourceIndexSha256=app.applicationHash(basis.sourceIndex);basis.archiveIndexSha256=app.applicationHash(basis.archiveIndex);
  s.originalBasis=copy(basis);s.currentBasis=copy(basis);s.currentHead=id(20);
  if(mode==='regenerate')s.current.stored.publication.request={requestVersion:VERSION,operation:'strategy.draft',
    applicationTarget:{mode:'regenerate',canonical:copy(canonical),expectedStrategyVersionId:id(20)},basis,basisSha256:app.applicationHash(basis),principal:{ownerActorId:'user_original'}};
  const node=(key,title)=>({sourceNodeKey:key,kind:'action',subject:'deliverable',title,note:null,status:'suggested',ownerRef:null,startsOn:'2026-10-16',endsOn:null,openEnded:false,sources:[],dependsOn:[]});
  const payload={type:'authorization',rationale:'Proposed rationale',summary:'Proposed summary',nodes:[node('retained','Proposed existing'),node('new_work','Proposed new')],
    coverage:{complete:true,omitted:[],assumptions:[],sources:[],pendingSources:[]}};
  s.witness={valid:true,generationJobId:id(10),generationRequestId:id(11),corePayloadSha256:app.applicationHash(payload)};
  s.rawResult={payload,witness:copy(s.witness),expiresAtMs:35_000};
  s.records.set(p.job.id,p);s.records.set(s.current.job.id,s.current);
  s.versions.set(id(20),{id:id(20),coalescible:false,authorKind:'meri',authorUserId:'user_original',snapshot:copy(oldSnapshot)});
  const tx={fixture:s,$queryRaw:async(strings)=>{assert.equal(s.depth,1);const sql=strings.join('?');
    if(sql.includes('clock_timestamp'))return[{ms:String(s.now)}];if(sql.includes('FOR UPDATE'))return[{id:s.current.job.id}];throw Error('unexpected synthetic SQL');},
    spDraftJob:{findFirst:async({where})=>{assert.equal(s.depth,1);if(s.failCompletedRead&&s.current.job.status==='completed'){s.failCompletedRead=false;throw Error('lost reply');}
      const r=s.records.get(where.id);return r&&r.job.tenantId===where.tenantId&&r.job.ownerUserId===where.ownerUserId?copy(r.job):null;}},
    spVersion:{findFirst:async({where})=>{assert.equal(s.depth,1);s.versionSelectors??=[];s.versionSelectors.push(copy(where));return copy(s.versions.get(where.id)??null);}}};
  s.db={withTenant:async(tenant,run,o)=>{assert.equal(tenant,id(2));assert.equal(o.timeoutMs,15_000);assert.equal(s.depth,0);
    const before=copy({records:s.records,versions:s.versions,writes:s.writes});s.depth++;
    try{return await run(tx);}catch(error){s.records=before.records;s.versions=before.versions;s.writes=before.writes;s.current=s.records.get(id(10));s.prior=s.records.get(id(60));throw error;}finally{s.depth--;}}};
  const grant={tenantId:id(2),actorUserId:id(9),clerkUserId:'user_original',consentId:id(12),controlVersion:2,checkedAtMs:9999,
    expiresAtMs:40_000,delegationExpiresAtMs:41_000,claimExpiresAtMs:42_000};
  s.authority={verifyGeneration:async(_http,subject)=>({...grant,requestSha256:subject.requestSha256}),assertGenerationCurrent:async()=>{
    assert.equal(s.depth,1);if(s.revoked||s.revokeAfterWrite&&s.writes>0)throw new app.CanonicalApplicationError('AUTHORITY_UNAVAILABLE');}};
  s.reader={read:async(selection,{signal})=>{assert.equal(s.depth,0);assert.equal(signal.aborted,false);s.reads++;
    assert.deepEqual(selection,{generationJobId:id(10),binding:s.current.association.acceptance.sourceBinding,sourceAdmissionSha256:app.applicationHash(s.current.association.admission)});
    s.onRead?.(s);return s.rawResult;}};
  s.owners={read:async()=>{assert.equal(s.depth,1);s.calls.owner++;return copy(s.ownerRows??[{ownerRef:'user_original',clerkUserId:'user_original'}]);}};
  s.context={recheckObjective:async()=>{assert.equal(s.depth,0);s.onContext?.(s);return 'unused';}};
  const write=async(kind,tenant,clerk,a,normalized,runtime)=>{s.calls[kind+'Writer']++;assert.equal(s.depth,0);assert.equal(tenant,id(2));assert.equal(clerk,'user_original');
    s.lastNormalized=copy(normalized);assert.equal(normalized.response.nodes.length,2);s.lastExpectedHead=a.expectedStrategyVersionId;
    if(kind==='regen'){assert.equal(normalized.nodeIds[0],id(21));assert.equal(normalized.normalizationWitness.basisSha256,app.applicationHash(s.originalBasis));}
    await runtime.persistence.beforeTransaction();await s.db.withTenant(tenant,async writerTx=>{await runtime.persistence.beforeWrite(writerTx);
      if(kind==='regen'&&(s.currentHead!==a.expectedStrategyVersionId||app.applicationHash(s.currentBasis)!==app.applicationHash(s.originalBasis)))throw new app.CanonicalApplicationError('SOURCE_STALE');
      s.writes++;s.versions.set(s.saved.strategyVersionId,{id:s.saved.strategyVersionId,coalescible:false,authorKind:'meri',authorUserId:'user_original',snapshot:copy(s.savedSnapshot)});
      await runtime.persistence.afterWrite(writerTx,s.saved);},{timeoutMs:15_000});if(s.loseReply)s.failCompletedRead=true;};
  s.writer={applyCanonicalDraft:(...args)=>write('draft',...args),applyCanonicalRegeneration:(...args)=>write('regen',...args),
    draft(){s.calls.forbidden++;throw Error('No model query');},generate(){s.calls.forbidden++;throw Error('No second writer');}};
  s.service=new ObjectiveCanonicalCompletionService(s.db,s.authority,s.reader,s.writer,s.context,s.owners);
  s.body={schemaVersion:1,generationJobId:id(10)};s.http={controlledFixture:true};s.tx=tx;
  globalThis[slot]=s;return s;
}
const complete=s=>s.service.complete(s.http,s.body);
const lookup=s=>s.service.lookup(s.http,id(10));
const reject=(status,code)=>e=>{assert.equal(e.getStatus(),status);assert.equal(e.getResponse().code,code);assert.equal(e.getResponse().outcome,'unconfirmed');return true;};
function noWrite(s){assert.equal(s.writes,0);assert.equal(s.current.job.input.canonicalCompletion,undefined);assert.equal(s.current.producer,null);assert.equal(s.current.normalization,null);assert.equal(s.calls.forbidden,0);assert.equal(s.depth,0);}

test('private regeneration dispatch invokes actual preserving normalizer and only the existing regeneration writer port',async()=>{
  const s=fixture(),body=copy(s.body),r=await complete(s);assert.deepEqual(s.body,body);
  assert.equal(s.calls.regenVerify,1);assert.equal(s.calls.initialVerify,0);assert.equal(s.calls.regenNormalize,1);assert.equal(s.calls.initialNormalize,0);
  assert.equal(s.calls.regenWriter,1);assert.equal(s.calls.draftWriter,0);assert.equal(s.lastExpectedHead,id(20));assert.equal(s.writes,1);
  assert.equal(s.lastNormalized.nodeIds[0],id(21));assert.notEqual(s.lastNormalized.nodeIds[1],id(21));
  assert.equal(r.objectiveReceipt.result.strategyVersionId,id(30));assert.equal(s.calls.normalizationReplay,1);assert.equal(s.calls.forbidden,0);
});
test('initial branch retains its own codec/normalizer/draft writer with the unchanged two-field request',async()=>{
  const s=fixture('initial');await complete(s);assert.equal(s.calls.initialVerify,1);assert.equal(s.calls.regenVerify,0);
  assert.equal(s.calls.initialNormalize,1);assert.equal(s.calls.regenNormalize,0);assert.equal(s.calls.draftWriter,1);assert.equal(s.calls.regenWriter,0);
  assert.deepEqual(Object.keys(s.body).sort(),['generationJobId','schemaVersion']);
});
test('all original basis provenance must have a genuine saved-custody witness before new Strategy effects',async()=>{
  const s=fixture();delete s.prior.job.input.canonicalCompletion;await assert.rejects(()=>complete(s),reject(503,'OUTCOME_UNCONFIRMED'));
  assert.equal(s.calls.regenWriter,0);noWrite(s);
});
test('basis custody compares immutable predecessor IDs/hashes, not a producer label or reserved Strategy ID',async()=>{
  const s=fixture();s.current.stored.publication.request.basis.provenance[0].normalizationSha256=hex('9');
  s.current.stored.publication.request.basisSha256=app.applicationHash(s.current.stored.publication.request.basis);
  s.originalBasis=copy(s.current.stored.publication.request.basis);
  await assert.rejects(()=>complete(s),reject(503,'OUTCOME_UNCONFIRMED'));assert.equal(s.calls.regenWriter,0);noWrite(s);
});
test('historical same-job replay uses original published basis and exact saved version before fresh-effect/head gates',async()=>{
  const s=fixture(),first=await complete(s),reads=s.reads,write=s.writes;s.currentHead=id(90);s.currentBasis.snapshot.meta.title='Human changed current title';s.effectUnavailable=true;
  const again=await complete(s),observed=await lookup(s);assert.deepEqual(again,first);assert.deepEqual(observed,first);
  assert.equal(s.reads,reads);assert.equal(s.writes,write);assert.equal(s.calls.regenWriter,1);
  assert.ok(s.versionSelectors.every(v=>v.id===id(30)));assert.equal(s.calls.forbidden,0);
});
test('lost committed response is recovered by original receipt lookup without refreshing result or dispatching a query',async()=>{
  const s=fixture();s.loseReply=true;await assert.rejects(()=>complete(s),reject(503,'OUTCOME_UNCONFIRMED'));
  assert.equal(s.writes,1);assert.equal(s.current.job.status,'completed');s.loseReply=false;
  const recovered=await lookup(s);assert.equal(recovered.objectiveReceipt.result.strategyVersionId,id(30));assert.equal(s.reads,1);assert.equal(s.calls.regenWriter,1);
});
for(const mutate of [s=>{s.current.stored.publicationSha256=hex('9');},s=>{s.current.association.acceptance.sourceRequestSha256=hex('9');},
  s=>{s.current.job.input.dto.goal='Changed original input';},s=>{s.current.job.input.canonicalTerminal={original:'other terminal'};s.current.job.status='failed';}]){
  test('IO cannot replace original publication/association/input or overwrite a terminal winner',async()=>{
    const s=fixture();s.onRead=mutate;await assert.rejects(()=>complete(s),reject(409,'REQUEST_CONFLICT'));assert.equal(s.calls.regenWriter,0);noWrite(s);
  });
}
test('writer repeats basis custody under its own transaction rather than trusting preparation locks',async()=>{
  const s=fixture();s.onContext=state=>{delete state.prior.job.input.canonicalCompletion;};
  await assert.rejects(()=>complete(s),reject(503,'OUTCOME_UNCONFIRMED'));assert.equal(s.calls.regenWriter,1);noWrite(s);
});
for(const mutate of [s=>{s.currentHead=id(99);},s=>{s.currentBasis.snapshot.meta.title='A later human edit';}]){
  test('existing writer expected-head/whole-basis refusal rolls back rather than adopting the newest head',async()=>{
    const s=fixture();s.onContext=mutate;await assert.rejects(()=>complete(s),reject(409,'SOURCE_STALE'));assert.equal(s.calls.regenWriter,1);noWrite(s);
  });
}
test('owner reassignment change between preparation and actual write refuses and preserves prior Strategy',async()=>{
  const s=fixture();s.onContext=state=>{state.ownerRows=[];};await assert.rejects(()=>complete(s),reject(409,'SOURCE_STALE'));noWrite(s);
});
test('authority release failure rolls back version, private completion and normalization together',async()=>{
  const s=fixture();s.revokeAfterWrite=true;await assert.rejects(()=>complete(s),reject(503,'AUTHORITY_UNAVAILABLE'));
  noWrite(s);assert.equal(s.versions.has(id(30)),false);assert.equal(s.versions.has(id(20)),true);
});
test('schema-two saved normalization is replayed against original basis and immutable saved-version snapshot',async()=>{
  const s=fixture();await complete(s);s.currentHead=id(99);s.currentBasis.snapshot.meta.title='Edited later';
  const read=await s.db.withTenant(id(2),tx=>readCanonicalSavedGeneration(tx,{tenantId:id(2),clerkUserId:'user_original',generationJobId:id(10)}),{timeoutMs:15_000});
  assert.equal(read.normalization.schemaVersion,2);assert.deepEqual(read.normalization.priorBasis,s.originalBasis);assert.equal(read.receipt.snapshotDigest,s.snapshotDigest);
  s.normalizationError=true;await assert.rejects(()=>lookup(s),reject(503,'OUTCOME_UNCONFIRMED'));assert.equal(s.writes,1);
});
test('unsupported request version or expected-head mismatch does not become initial generation',async()=>{
  for(const mutate of [r=>{r.requestVersion='unknown-version';},r=>{r.applicationTarget.expectedStrategyVersionId=id(99);}]){
    const s=fixture();mutate(s.current.stored.publication.request);await assert.rejects(()=>complete(s),reject(503,'AUTHORITY_UNAVAILABLE'));
    assert.equal(s.reads,0);assert.equal(s.calls.draftWriter,0);noWrite(s);
  }
});
test('actual basis-custody helper can read the prior immutable result without consulting a latest head',async()=>{
  const s=fixture();s.currentHead=id(99);await s.db.withTenant(id(2),tx=>requireCanonicalBasisCustody(tx,s.originalBasis),{timeoutMs:15_000});
  assert.equal(s.writes,0);assert.equal(s.reads,0);assert.equal(s.calls.forbidden,0);
});
test('reports only source orchestration with explicit synthetic proof boundaries',()=>{
  assert.equal(custody.length,6);
  console.log(JSON.stringify({qualification:'source-orchestration-only',sourceCustody:custody,
    actual:['completion service','saved-generation helper','basis-custody helper','normalizers','original input checker'],
    synthetic:['retained codecs and owner proof','SQL/transaction rollback model','current authority','existing Strategy writer/persistence ports','schema-two normalization replay owner'],
    semanticFrameworkNativeHttpGenuineCustody:'UNQUALIFIED',network:false,processes:0}));
});
