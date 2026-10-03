// Offline string/transport validation only. Never imports or executes the dispatcher.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
const parent='C:/dev/main/outputs/meri-c2-20261003';
const sourceText=readFileSync(parent+'/run-case01-native-setup-v3.mjs','utf8');
const hash=b=>createHash('sha256').update(b).digest('hex');
const body=readFileSync(parent+'/case01-native-setup-v1/case01-native-setup-inner.mjs');
const rates=readFileSync(parent+'/case01-native-setup-v1/case01-reviewed-rates-v2.json');
const mode='plan',source='5b086a6b47ffce5aa1b93bfe38f9c7b96e297642';
const stagedScript='/dev/shm/case01-native-setup-inner.mjs',receiptPath='/dev/shm/case01-native-setup-plan-01.jsonl';
const input=JSON.parse(readFileSync(parent+'/case01-native-setup-v1/plan-input.json','utf8'));
const context=vm.createContext({assert,Buffer,hash,body,rates,mode,source,receiptPath});
const start=sourceText.indexOf('function assembleReceipt(rawEvents)');
const end=sourceText.indexOf('async function collectLogs()',start);
assert.ok(start>0&&end>start);
const assemble=vm.runInContext(sourceText.slice(start,end)+'\nassembleReceipt',context);
const bytes=Buffer.from(JSON.stringify({sequence:1,phase:'RESULT',padding:'x'.repeat(13000)})+'\n');
const encoded=bytes.toString('base64');
const meta={version:1,kind:'case01-native-setup-jsonl',mode,sourceSha:source,scriptSha256:hash(body),
  rateSha256:hash(rates),captureRunId:'bd35c0f4-1604-4371-b7e9-a1338369e53f',receiptPath,
  byteLength:bytes.length,base64Length:encoded.length,chunks:Math.ceil(encoded.length/8192),
  sha256:hash(bytes),innerExitCode:0};
const records=[{phase:'BEGIN',...meta},...Array.from({length:meta.chunks},(_,i)=>({phase:'CHUNK',
  sha256:meta.sha256,index:i+1,data:encoded.slice(i*8192,(i+1)*8192)})),{phase:'END',...meta}];
const events=rows=>rows.map(row=>({message:'C2_CASE01_NATIVE_SETUP_RECEIPT '+JSON.stringify(row)}));
let passed=0;
const check=(name,work)=>{work();passed++;process.stdout.write('PASS '+name+'\n');};
check('exact complete multi-chunk byte transport',()=>assert.ok(assemble(events(records)).bytes.equals(bytes)));
check('empty tail remains incomplete',()=>assert.equal(assemble([]),null));
check('missing terminal marker remains incomplete',()=>assert.equal(assemble(events(records.slice(0,-1))),null));
check('missing chunk is refused',()=>assert.throws(()=>assemble(events(records.filter((_,i)=>i!==1)))));
check('duplicate chunk is refused',()=>assert.throws(()=>assemble(events([records[0],records[1],...records.slice(1)]))));
check('reordered chunks are refused',()=>assert.throws(()=>assemble(events([records[0],records[2],records[1],...records.slice(3)]))));
check('mismatched end metadata is refused',()=>assert.throws(()=>assemble(events([...records.slice(0,-1),{...records.at(-1),sourceSha:'0'.repeat(40)}]))));
check('wrong source even with matching header and end is refused',()=>assert.throws(()=>assemble(events(records.map(row=>['BEGIN','END'].includes(row.phase)?{...row,sourceSha:'0'.repeat(40)}:row)))));
check('modified bytes are refused',()=>assert.throws(()=>assemble(events(records.map((row,i)=>i===1?{...row,data:'A'+row.data.slice(1)}:row)))));
check('noncanonical base64 is refused',()=>assert.throws(()=>assemble(events(records.map((row,i)=>i===1?{...row,data:'!'+row.data.slice(1)}:row)))));
check('wrapper failure retained without calling it success',()=>assert.equal(assemble(events([{phase:'WRAPPER_FAILURE',errorClass:'Error'},...records])).failures.length,1));
check('inner failure exit is retained for final rejection',()=>assert.equal(assemble(events(records.map(row=>['BEGIN','END'].includes(row.phase)?{...row,innerExitCode:1}:row))).meta.innerExitCode,1));
check('malformed protocol JSON is refused',()=>assert.throws(()=>assemble([{message:'C2_CASE01_NATIVE_SETUP_RECEIPT {'}])));
const wrapperStart=sourceText.indexOf('const wrapper=`');
const wrapperEnd=sourceText.indexOf('\nconst templateBytes=',wrapperStart);
const wrapper=vm.runInNewContext(sourceText.slice(wrapperStart,wrapperEnd)+'\nwrapper',
  {body,rates,input,hash,stagedScript,receiptPath,mode,source,Buffer});
check('embedded wrapper syntax only',()=>execFileSync(process.execPath,['--input-type=module','--check'],{input:wrapper,encoding:'utf8',windowsHide:true}));
const result={status:'OFFLINE_CHECKS_PASS',passed,dispatcherSha256:hash(sourceText),
  assemblerSourceSha256:hash(sourceText.slice(start,end)),wrapperSyntaxSha256:hash(wrapper),
  dispatcherImported:false,dispatcherExecuted:false,remoteCalls:0,ownerCalls:0,fixtureOrJournalWrites:0,
  limits:'Parser checks and generated wrapper syntax only; no task/log/cleanup integration executed.'};
writeFileSync(parent+'/case01-native-setup-v3-review/offline-result-final.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
