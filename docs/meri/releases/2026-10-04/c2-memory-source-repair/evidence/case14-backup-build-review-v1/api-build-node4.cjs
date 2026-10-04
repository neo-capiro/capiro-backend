const assert = require('node:assert/strict');
const {TitanEmbeddingProvider} = require('./dist/embeddings/titan-embedding.provider.js');
const {NvidiaRerankingProvider} = require('./dist/reranking/nvidia-reranking.provider.js');
const {withCaptureApiProviderScope,captureApiProviderScopeActive} = require('./dist/meri/meri-capture-api-provider-scope.js');
(async()=>{
  let transportCalls=0,databaseCalls=0;
  const prisma={withTenantUser:async()=>{databaseCalls++;throw new Error('No database in packaged guard probe');}};
  const policy={expectedCaptureWrites:['context_packet_and_evidence','conversation_user_message','conversation_assistant_message','provider_budget_ledger']};
  const ctx={tenantId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',role:'standard_user'};
  const capture=fn=>withCaptureApiProviderScope(prisma,ctx,policy,fn);
  const titan=new TitanEmbeddingProvider({region:'eu-west-1',dimensions:2,invoker:async()=>{
    transportCalls++;return {body:Buffer.from(JSON.stringify({embedding:[1,0],inputTextTokenCount:2}))};
  }});
  assert.equal(captureApiProviderScopeActive(),false);
  await capture(async()=>{
    assert.equal(captureApiProviderScopeActive(),true);
    await assert.rejects(titan.embed('synthetic'),/meri_capture_provider_wire_unqualified_bedrock_region/);
  });
  assert.equal(transportCalls,0);assert.equal(databaseCalls,0);
  const reranker=new NvidiaRerankingProvider({endpointUrl:'https://offline.invalid/v1/ranking',model:'synthetic/unit',fetchImpl:async(url)=>{
    transportCalls++;assert.equal(url,'https://offline.invalid/v1/ranking');
    return new Response(JSON.stringify({rankings:[{index:0,logit:1}],usage:{prompt_tokens:1,total_tokens:1}}),{status:200});
  }});
  await assert.rejects(capture(()=>reranker.rerank({query:'synthetic',passages:['synthetic']})),/meri_capture_provider_wire_unqualified_nvidia_endpoint/);
  assert.equal(transportCalls,0);assert.equal(databaseCalls,0);
  assert.equal(captureApiProviderScopeActive(),false);
  assert.deepEqual(await titan.embed('synthetic'),[1,0]);
  await reranker.rerank({query:'synthetic',passages:['synthetic']});
  assert.equal(transportCalls,2);assert.equal(databaseCalls,0);
  console.log('OFFLINE_PACKAGED_CAPTURE_PROVIDER_API_GUARDS_PASS');
  console.log('Actual packaged scope and adapter guards with local transport stubs; no database, provider pricing or live capture qualification.');
})().catch(error=>{console.error(error);process.exitCode=1;});
