const { test }=require('node:test');const assert=require('node:assert/strict');const {createBackfillReader}=require('./batch-reader.cjs');
test('batches at most five documents, isolates returned IDs, and preserves original text',async()=>{
 const ids=Array.from({length:7},(_,i)=>i.toString(16).padStart(32,'0'));const calls=[];
 const read=createBackfillReader({callTool:async(name,args)=>{calls.push([name,args]);return{structuredContent:name==='search_meetings'?{meetings:ids.map(meeting_id=>({meeting_id}))}:{results:args.ids.map(id=>({id,document:{id,notes:'  # '+id+'\n'}}))}};}},{delayMs:0});
 await read('search_meetings',{});
 for(const id of ids){const args={ids:[id],include:['notes'],format:'json'};const a=await read('get_multiple_documents',args);assert.equal(a.structuredContent.results.length,1);assert.equal(a.structuredContent.results[0].document.notes,'  # '+id+'\n');assert.deepEqual(await read('get_multiple_documents',args),a);}
 assert.equal(calls.length,3);assert.equal(calls[1][1].ids.length,5);assert.equal(calls[2][1].ids.length,2);
});
test('large batch replies fall back to an individual fetch',async()=>{
 const id='a'.repeat(32);let calls=0;
 const read=createBackfillReader({callTool:async()=>({structuredContent:{results:[{id,document:{notes:++calls===1?'truncated characters':'Full original notes'}}]}})},{delayMs:0});
 const result=await read('get_multiple_documents',{ids:[id],include:['notes'],format:'json'});assert.equal(calls,2);assert.equal(result.structuredContent.results[0].document.notes,'Full original notes');
});
