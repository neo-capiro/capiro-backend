import test from 'node:test';
import assert from 'node:assert/strict';
import { application, request, custody, storeResult } from './objective-native-codec-loader.mjs';
const { CanonicalApplicationError, applicationHash } = application;
const hash = request.privateRequestJcsSha256;
const id = '00000000-0000-4000-8000-000000000099', hex = '9'.repeat(64);

// The same native journal envelope and refusal families apply to initial and
// preserving regeneration results. Each caller supplies its real publication.
export function nativeCompletionCases({ fixture, verify, checkWitness }) {
  const options = f => ({ admission:f.admission, acceptance:f.acceptance, publication:f.publication, nowMs:f.nowMs });
  const expected = f => { const { nowMs:_now,...rest } = options(f); return rest; };
  const refuse = (f, code) => assert.throws(() => verify(f.raw, options(f)), e =>
    e instanceof CanonicalApplicationError && (code === undefined || e.code === code));
  test('source custody binds actual native and typed codecs without behavior rewrites', () => {
    assert.equal(custody.length, 10);
    assert.equal(custody.filter(x=>x.decorator).length,1);
    assert.ok(custody.every(x=>/^[a-f0-9]{64}$/.test(x.sha256)));
  });
  test('published native bytes produce the immutable witness and literal payload', () => {
    const f=fixture(), before=structuredClone(f.raw), v=verify(f.raw, options(f));
    assert.deepEqual(f.raw,before);assert.deepEqual(v.payload,f.result.payload);
    assert.deepEqual(Object.keys(v),['payload','witness']);
    assert.equal(v.witness.completionId,f.acceptance.sourceBinding.runId);
    assert.equal(v.witness.sourceBindingSha256,hash(f.acceptance.sourceBinding));
    assert.equal(v.witness.corePayloadSha256,applicationHash(f.result.payload));
    assert.equal(v.witness.executionContextSha256,hash(f.publication.executionContext));
    assert.deepEqual(checkWitness(v.witness,expected(f)),v.witness);
    assert.ok(Object.isFrozen(v.payload.nodes[0]));assert.ok(Object.isFrozen(v.witness));
    for(const key of ['checkedAtMs','expiresAtMs','file','binding'])assert.equal(Object.hasOwn(v.witness,key),false);
  });
  test('historical authorized read preserves timely completion without renewing effects', () => {
    const f=fixture(), w=verify(f.raw,options(f)).witness;f.nowMs=5_000_000;
    assert.deepEqual(verify(f.raw,options(f)).witness,w);
    f.result.completedAtMs=5_000_000;storeResult(f);refuse(f,'SOURCE_STALE');
  });
  for(const [owner,field] of [['record','generationJobId'],['record','sourceAdmissionSha256'],['record','sourceRequestSha256'],
    ['record','typedRequestSha256'],['completion','completionId'],['completion','checkpointId']]) {
    test(`native ${owner}.${field} cannot substitute original work`,()=>{
      const f=fixture();f.raw[owner][field]=field.endsWith('Sha256')?hex:id;refuse(f);
    });
  }
  for(const where of ['record','result'])for(const field of ['tenantId','actorId','conversationId','runId','attemptId','workerId','writerFence']) {
    test(`${where} binding ${field} stays equal to the accepted run`,()=>{
      const f=fixture(), b=where==='record'?f.raw.record.binding:f.result.binding;
      b[field]=field==='writerFence'?2:id;if(where==='result')storeResult(f);refuse(f);
    });
  }
  for(const field of ['requestId','jobId','requestSha256','inputSha256','sourceSha256','contextSha256','basisSha256']) {
    test(`coherent result hashing cannot replace ${field}`,()=>{
      const f=fixture();f.result[field]=field.endsWith('Sha256')?hex:id;storeResult(f);refuse(f);
    });
  }
  for(const state of ['needs-information','refused','unknown','running','failed','cancelled'])test(`success codec refuses ${state}`,()=>{
    const f=fixture();f.result.state=state;storeResult(f);refuse(f,'OUTCOME_UNCONFIRMED');
  });
  for(const at of [999_999,1_009_999,1_019_999,1_800_000,2_000_000,3_000_000])test(`completion ${at} obeys every original time bound`,()=>{
    const f=fixture();f.result.completedAtMs=at;storeResult(f);refuse(f,'SOURCE_STALE');
  });
  test('future completion and malformed current clock refuse',()=>{
    const f=fixture();f.nowMs=1_029_999;refuse(f,'OUTCOME_UNCONFIRMED');
    for(const now of [NaN,Infinity,1.5,-1]){const g=fixture();g.nowMs=now;refuse(g);}
  });
  for(const mutate of [f=>{f.raw.file.path='../result.json';},f=>{f.raw.file.object.versionId=null;},
    f=>{f.raw.file.object.versionId='null';},f=>{f.raw.file.object.bytes=2_097_153;},
    f=>{f.raw.file.object.sha256=hex;},f=>{f.raw.file.object.bytes++;},f=>{f.raw.file.object.objectId='';},
    f=>{f.raw.file.base64=f.raw.file.base64.slice(4);},f=>{f.raw.completion.proof.files.workspace.entries.push(structuredClone(f.raw.completion.proof.files.workspace.entries[0]));}])
    test('fixed immutable file/bytes/unique manifest refuses drift',()=>{const f=fixture();mutate(f);refuse(f);});
  test('raw and semantic hashes stay distinct and independently bound',()=>{
    const f=fixture();assert.notEqual(f.result.resultSha256,f.raw.file.object.sha256);
    f.raw.file.object.sha256=f.result.resultSha256;refuse(f);
    const g=fixture();g.result.resultSha256=hash(g.result);storeResult(g,{semantic:false});refuse(g);
    const h=fixture();h.result.payload.summary='unbound payload';storeResult(h);refuse(h,'REQUEST_CONFLICT');
  });
  test('execution equality and actual native session receipt reject fabricated values',()=>{
    for(const field of ['provider','model','receiptRef','receiptSha256','bindingSha256']){
      const f=fixture();f.result.execution[field]=field.endsWith('Sha256')?hex:id;
      storeResult(f,{observation:false});refuse(f);
    }
    const f=fixture();f.raw.completion.typedResult.execution.receiptSha256=hex;
    f.result.execution.receiptSha256=hex;storeResult(f,{observation:false});refuse(f,'OUTCOME_UNCONFIRMED');
  });
  for(const at of ['outer','record','completion','proof','result','execution','file','object','witness'])test(`closed ${at} refuses unknown fields`,()=>{
    const f=fixture();
    if(at==='witness'){const w=verify(f.raw,options(f)).witness;assert.throws(()=>checkWitness({...w,extra:true},expected(f)),CanonicalApplicationError);return;}
    const targets={outer:f.raw,record:f.raw.record,completion:f.raw.completion,proof:f.raw.completion.proof,
      result:f.result,execution:f.raw.completion.typedResult.execution,file:f.raw.file,object:f.raw.file.object};
    targets[at].extra=true;if(at==='result')storeResult(f);refuse(f);
  });
  test('wire accessors/proxies/cycles/toJSON/nonfinite Unicode refuse without invocation',()=>{
    let calls=0;
    const f=fixture();Object.defineProperty(f.raw,'completion',{enumerable:true,get(){calls++;throw Error('unexpected');}});refuse(f);
    for(const value of [new Proxy({}, {ownKeys(){calls++;throw Error('unexpected');}}),new Date(0),new Array(2),
      {toJSON(){calls++;throw Error('unexpected');}},{bad:NaN},{bad:'\ud800'}]){
      const g=fixture();g.raw.completion=value;refuse(g);
    }
    const g=fixture();g.raw.self=g.raw;refuse(g);assert.equal(calls,0);
  });
  test('oversize body refuses without truncating',()=>{const f=fixture();f.raw.file.base64='x'.repeat(8*1024*1024+1);refuse(f);});
  test('stored witness pins every identity and original completion bounds',()=>{
    const f=fixture(),w=verify(f.raw,options(f)).witness;
    for(const field of ['generationJobId','generationRequestId','sourceAdmissionSha256','sourceRequestSha256',
      'sourceBindingSha256','typedRequestSha256','executionContextSha256','completionId','resultRef']){
      assert.throws(()=>checkWitness({...w,[field]:field.endsWith('Sha256')?hex:id},expected(f)),CanonicalApplicationError);
    }
    assert.throws(()=>checkWitness({...w,completedAtMs:1_800_000},expected(f)),CanonicalApplicationError);
    assert.throws(()=>checkWitness({...w,corePayloadSha256:null},expected(f)),CanonicalApplicationError);
  });
}
