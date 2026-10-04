const assert = require('node:assert/strict');
const {withTrustedCurrentTurnScope} = require('./dist/request/trusted-current-turn-scope.js');
const {captureProviderWireActive,prepareCaptureOpenAiBody,prepareCaptureProviderFetch} = require('./dist/meri/meri-capture-provider-wire.js');
const scope={tenantId:'synthetic-tenant',userId:'synthetic-user',conversationId:'synthetic-chat',selectedClientId:'synthetic-client',
  capturePolicy:{expectedCaptureWrites:['context_packet_and_evidence','conversation_user_message','conversation_assistant_message','provider_budget_ledger']}};
const body={model:'gpt-6-astra',store:false,max_output_tokens:8192,input:[{role:'user',content:'synthetic text'}],
  tools:[{type:'function',name:'search_memory',parameters:{type:'object'}}]};
const original=JSON.stringify(body);
assert.equal(captureProviderWireActive(),false);
assert.equal(prepareCaptureOpenAiBody(body),body);
const ordinary=['https://custom.invalid/v1/responses',{method:'POST',body:JSON.stringify({...body,service_tier:'priority',input:[{type:'input_image',image_url:'synthetic'}]})}];
assert.equal(prepareCaptureProviderFetch(ordinary),ordinary);
withTrustedCurrentTurnScope(scope,()=>{
  assert.equal(captureProviderWireActive(),true);
  const prepared=prepareCaptureOpenAiBody(body);
  assert.equal(prepared.service_tier,'default');assert.equal(JSON.stringify(body),original);
  assert.deepEqual(prepared.input,body.input);assert.equal(prepared.model,body.model);
  for(const change of [{service_tier:'auto'},{service_tier:'priority'},
    {input:[{role:'user',content:[{type:'input_image',image_url:'synthetic'}]}]},
    {input:[{role:'user',content:[{type:'input_audio',data:'synthetic'}]}]},
    {tools:[{type:'web_search'}]},{tool_choice:{type:'web_search'}},
    {previous_response_id:'external-response'},{input:[{type:'item_reference',id:'external-item'}]}]){
    assert.throws(()=>prepareCaptureOpenAiBody({...body,...change}),/meri_capture_provider_wire/);
  }
  const args=prepareCaptureProviderFetch(['https://api.openai.com/v1/responses',{method:'POST',body:original}]);
  assert.equal(args[1].redirect,'error');assert.equal(JSON.parse(args[1].body).service_tier,'default');
  for(const url of ['https://proxy.invalid/v1/responses','https://api.openai.com/v1/responses?region=other','https://api.openai.com/v1/chat/completions']){
    assert.throws(()=>prepareCaptureProviderFetch([url,{method:'POST',body:original}]),/meri_capture_provider_wire/);
  }
  const replay={...body,input:[...body.input,{type:'reasoning',id:'synthetic-reasoning',summary:[{type:'summary_text',text:'synthetic'}]},
    {type:'function_call',call_id:'synthetic-call',name:'search_memory',arguments:'{}'},
    {type:'function_call_output',call_id:'synthetic-call',output:'synthetic text'}]};
  assert.equal(prepareCaptureOpenAiBody(replay).service_tier,'default');
});
assert.equal(captureProviderWireActive(),false);
console.log('OFFLINE_PACKAGED_CAPTURE_PROVIDER_ORCHESTRATOR_GUARDS_PASS');
console.log('Actual packaged guard/ALS behavior only; no reservation, provider, database or live pricing qualification is claimed.');
