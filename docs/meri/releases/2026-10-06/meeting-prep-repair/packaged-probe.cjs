const assert=require('node:assert/strict');
const {generateComprehensiveMeetingPrep,parseBriefingFacts}=require('./dist/engagement/meeting-prep-comprehensive.js');
const {withMeetingPrepExecution}=require('./dist/engagement/meeting-prep-job-runtime.js');
const {MEETING_BRIEFING_SECTIONS}=require('./dist/engagement/meeting-prep-policy.js');
assert.equal(process.version,'v22.23.3');
const evidence={id:'mail:probe',kind:'mail',recordId:'probe',title:'Synthetic timeline',observedAt:null,excerpt:'Send the timeline by Friday.'};
const ledger=Array.from({length:400},(_,i)=>({section:'commitments',text:`Synthetic commitment ${i}: ${'context '.repeat(50)}`,sourceId:evidence.id,quote:evidence.excerpt,importance:'critical',state:'open',eventAt:null}));
const facts=parseBriefingFacts(ledger,[evidence]);
const draft={takeaways:[{text:'Send the timeline.',factIds:[facts[0].id]}],sections:Object.fromEntries(MEETING_BRIEFING_SECTIONS.map(k=>[k,{status:k==='commitments'?'evidence_found':'no_evidence',items:k==='commitments'?[{text:'Send the timeline.',factIds:[facts[0].id]}]:[],gap:k==='commitments'?'':'No evidence in this synthetic scope.'}])),limitations:[]};
const input={meeting:{id:'probe',subject:'Synthetic probe',startsAt:'2026-10-06T18:00:00Z'},client:null,attendees:[],congressionalDirectoryMatches:[],recentMeetings:[],recentThreads:[],tasks:[],evidenceSources:[evidence]};
const reply=v=>({text:JSON.stringify(v),usage:{inputTokens:1,outputTokens:1},truncated:false,stopReason:'end_turn',raw:{}});
async function run(failReview){let repairs=0,checkpointed=false;
const complete=async r=>{assert.ok(Buffer.byteLength(r.userVolatile+r.userStatic+JSON.stringify(r.jsonSchema))+4096+r.maxTokens<=128000);const p=JSON.parse(r.userVolatile);if(r.jsonSchemaName.endsWith('extracting'))return reply({facts:ledger,limitations:[]});if(r.jsonSchemaName.endsWith('checking_coverage')){assert.equal(r.reasoningEffort,'medium');assert.equal(p.ledger[0].quote,undefined);if(failReview)throw Error('meeting_prep_model_context_budget_exceeded');return reply({omittedFactIds:p.ledger.map(f=>f.id)});}if(r.jsonSchemaName.endsWith('repairing'))repairs++;return reply(draft);};
const result=await withMeetingPrepExecution({jobId:'probe',depth:'standard',requestedAt:Date.parse('2026-10-06T18:00:00Z'),deadlineAt:Date.now()+3600000,signal:new AbortController().signal,checkpoint:async(stage)=>{if(stage==='draft_ready')checkpointed=true},loadCheckpoint:()=>undefined,commit:async()=>{}},()=>generateComprehensiveMeetingPrep(input,{provider:'openai',apiKey:'synthetic-no-network',model:'gpt-6-astra',usedTenantKey:false},{complete}));
assert.equal(result.summary,'Send the timeline.');assert.equal(checkpointed,true);assert.equal(repairs,failReview?0:2);assert.equal(result.briefing.facts[0].quote,evidence.excerpt);if(failReview)assert.ok(result.briefing.limitations.some(x=>x.includes('additional coverage review could not finish')));
}
(async()=>{await run(false);await run(true);const f=require('./dist/common/krisp-notetaker-flags.js');assert.equal(f.krispImportMode('c2-strategies'),'direct_notes');assert.equal(f.krispImportMode('other-firm'),'generated');console.log('PREP_PACKAGED_RUNTIME_PASS');})().catch(e=>{console.error(e);process.exitCode=1});
